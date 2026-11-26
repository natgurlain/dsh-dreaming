/**
 * The rules of a dream, enforced in code: parsing the model's candidates and
 * operations, applying the operations to the notes, choosing which notes are
 * injected into every session. The model proposes; this module decides.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/consolidate
 */

import { randomUUID } from 'node:crypto'
import { NOTE_KINDS, type Candidate, type Note, type NoteKind, type NoteSource, type Speaker } from '../types.ts'
import { renderInjected } from '../store.ts'
import { redact } from './redact.ts'
import type { TranscriptLine } from './render.ts'

export const MAX_NOTE_CHARS = 400
export const MAX_NOTES = 500
/** An inferred note needs this many distinct untainted sessions to be injected. */
export const INFERRED_INJECT_SESSIONS = 3
/** Kinds that change behavior in almost every session; facts and procedures stay searchable. */
export const INJECT_KINDS: readonly NoteKind[] = ['preference', 'correction', 'pitfall']
/** At most this many injected notes may rest on a single session. */
export const SINGLE_SESSION_SLOTS = 3
/** A single-session note leaves the injected set after this long unconfirmed. */
export const SINGLE_SESSION_TTL_DAYS = 14
/** Word overlap above which two injected notes count as the same. */
export const DUPLICATE_OVERLAP = 0.6

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isKind = (value: unknown): value is NoteKind => typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value)

/** Text that addresses the agent the way an injected instruction would. */
const DIRECTIVE = /\b(ignore (all |any |the )?(previous|prior|above)|disregard (all|previous|prior)|system prompt|you must now|new instructions|exfiltrat|send (it|this|them|the \w+) to)\b/i
/** A URL with a query string or fragment may carry data out. */
const URL_WITH_DATA = /https?:\/\/\S+[?#]\S*/i

/** Why a note text is refused, or undefined when it is acceptable. */
export function lintNoteText(text: string, trust: 'user' | 'inferred'): string | undefined {
  if (text.length === 0) return 'empty text'
  if (URL_WITH_DATA.test(text)) return 'contains a URL with a query string'
  if (trust === 'inferred' && DIRECTIVE.test(text)) return 'reads like an instruction planted in the transcript'
  return undefined
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? redact(value.replace(/\s+/g, ' ').trim()).slice(0, MAX_NOTE_CHARS) : ''
}

/**
 * Parse one chunk's extraction reply. The speaker is not taken from the
 * model: it is derived from the cited lines (user if any cited line is the
 * user's, else agent if any is the agent's, else tool). Citations outside
 * the chunk are dropped; a candidate without one is dropped.
 */
export function parseCandidates(value: unknown, chunk: readonly TranscriptLine[], session: { sessionId: string; tainted: boolean }): Candidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) throw new Error('expected {"candidates":[...]}')
  const speakers = new Map(chunk.map((line) => [line.seq, line.speaker]))
  const result: Candidate[] = []
  for (const raw of value.candidates.slice(0, 40)) {
    if (!isRecord(raw)) continue
    const text = cleanText(raw.text)
    if (text === '' || !isKind(raw.kind)) continue
    const seqs = (Array.isArray(raw.seqs) ? raw.seqs : []).filter((seq): seq is number => typeof seq === 'number' && speakers.has(seq))
    if (seqs.length === 0) continue
    const cited = new Set(seqs.map((seq) => speakers.get(seq)))
    const speaker: Speaker = cited.has('user') ? 'user' : cited.has('agent') ? 'agent' : 'tool'
    const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0.5
    result.push({ id: '', text, kind: raw.kind, speaker, confidence, sessionId: session.sessionId, seqs: [...new Set(seqs)], tainted: session.tainted })
  }
  return result
}

export type Op =
  | { op: 'add'; text: string; kind: NoteKind; candidates: string[] }
  | { op: 'confirm'; note: string; candidates: string[] }
  | { op: 'update'; note: string; text: string; candidates: string[] }
  | { op: 'merge'; notes: string[]; text: string; kind?: NoteKind }
  | { op: 'drop'; note: string; candidates: string[]; reason: string }
  | { op: 'reword'; note: string; text: string }

const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

export function parseOps(value: unknown): Op[] {
  if (!isRecord(value) || !Array.isArray(value.ops)) throw new Error('expected {"ops":[...]}')
  const ops: Op[] = []
  for (const raw of value.ops) {
    if (!isRecord(raw)) continue
    const note = typeof raw.note === 'string' ? raw.note : ''
    if (raw.op === 'add' && isKind(raw.kind)) ops.push({ op: 'add', text: cleanText(raw.text), kind: raw.kind, candidates: ids(raw.candidates) })
    else if (raw.op === 'confirm') ops.push({ op: 'confirm', note, candidates: ids(raw.candidates) })
    else if (raw.op === 'update') ops.push({ op: 'update', note, text: cleanText(raw.text), candidates: ids(raw.candidates) })
    else if (raw.op === 'merge') ops.push({ op: 'merge', notes: ids(raw.notes), text: cleanText(raw.text), ...(isKind(raw.kind) ? { kind: raw.kind } : {}) })
    else if (raw.op === 'drop') ops.push({ op: 'drop', note, candidates: ids(raw.candidates), reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '' })
    else if (raw.op === 'reword') ops.push({ op: 'reword', note, text: cleanText(raw.text) })
  }
  return ops
}

export interface Rejection { op: Op; reason: string }

export interface ConsolidationResult {
  notes: Note[]
  rejected: Rejection[]
  counts: { added: number; updated: number; merged: number; dropped: number; confirmed: number; reworded: number }
}

function sourcesOf(candidates: readonly Candidate[]): NoteSource[] {
  const bySession = new Map<string, NoteSource>()
  for (const candidate of candidates) {
    const source = bySession.get(candidate.sessionId) ?? { sessionId: candidate.sessionId, seqs: [], ...(candidate.tainted ? { tainted: true as const } : {}) }
    source.seqs = [...new Set([...source.seqs, ...candidate.seqs])].sort((a, b) => a - b)
    bySession.set(candidate.sessionId, source)
  }
  return [...bySession.values()]
}

function mergeSources(a: readonly NoteSource[], b: readonly NoteSource[]): NoteSource[] {
  const bySession = new Map<string, NoteSource>()
  for (const source of [...a, ...b]) {
    const existing = bySession.get(source.sessionId)
    if (existing === undefined) bySession.set(source.sessionId, { ...source, seqs: [...source.seqs] })
    else {
      existing.seqs = [...new Set([...existing.seqs, ...source.seqs])].sort((x, y) => x - y)
      if (source.tainted) existing.tainted = true
    }
  }
  return [...bySession.values()]
}

const distinctSessions = (items: ReadonlyArray<{ sessionId: string }>): number => new Set(items.map((item) => item.sessionId)).size

export function newNoteId(): string {
  return `n-${randomUUID().slice(0, 8)}`
}

/**
 * Apply proposed operations to the notes.
 * @param candidates - consolidation input; tool-speaker candidates must already be quarantined.
 */
export function applyOps(notes: readonly Note[], candidates: readonly Candidate[], ops: readonly Op[], now: string, makeId: () => string = newNoteId, options: { tidy?: boolean } = {}): ConsolidationResult {
  const byId = new Map(notes.map((note) => [note.id, { ...note, sources: [...note.sources] }]))
  const byCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const rejected: Rejection[] = []
  const counts = { added: 0, updated: 0, merged: 0, dropped: 0, confirmed: 0, reworded: 0 }
  const reject = (op: Op, reason: string): void => { rejected.push({ op, reason }) }
  const evidence = (op: Op, list: readonly string[]): Candidate[] | undefined => {
    const found = list.map((id) => byCandidate.get(id))
    if (found.length === 0) { reject(op, 'cites no candidate'); return undefined }
    if (found.some((candidate) => candidate === undefined)) { reject(op, 'cites an unknown candidate'); return undefined }
    return found as Candidate[]
  }
  /** One inferred session cannot overturn what the user said. */
  const mayOverturn = (note: Note, cited: readonly Candidate[]): boolean =>
    note.trust !== 'user' || cited.some((candidate) => candidate.speaker === 'user') || distinctSessions(cited) >= 2

  for (const op of ops) {
    // A tidy pass has no new evidence: it may only merge and reword.
    if (options.tidy === true && op.op !== 'merge' && op.op !== 'reword') { reject(op, 'a tidy pass may only merge or reword'); continue }
    if (options.tidy !== true && op.op === 'reword') { reject(op, 'reword is only for a tidy pass'); continue }
    switch (op.op) {
      case 'add': {
        const cited = evidence(op, op.candidates)
        if (cited === undefined) break
        const trust = cited.some((candidate) => candidate.speaker === 'user') ? 'user' : 'inferred'
        const problem = lintNoteText(op.text, trust)
        if (problem !== undefined) { reject(op, problem); break }
        if (byId.size >= MAX_NOTES) { reject(op, `the store holds the maximum of ${MAX_NOTES} notes`); break }
        const id = makeId()
        byId.set(id, { id, text: op.text, kind: op.kind, trust, sources: sourcesOf(cited), firstSeen: now, lastConfirmed: now })
        counts.added += 1
        break
      }
      case 'confirm': {
        const note = byId.get(op.note)
        if (note === undefined) { reject(op, 'unknown note'); break }
        const cited = evidence(op, op.candidates)
        if (cited === undefined) break
        note.sources = mergeSources(note.sources, sourcesOf(cited))
        note.lastConfirmed = now
        if (cited.some((candidate) => candidate.speaker === 'user')) note.trust = 'user'
        counts.confirmed += 1
        break
      }
      case 'update': {
        const note = byId.get(op.note)
        if (note === undefined) { reject(op, 'unknown note'); break }
        const cited = evidence(op, op.candidates)
        if (cited === undefined) break
        if (!mayOverturn(note, cited)) { reject(op, 'an inferred candidate from one session cannot change a note the user stated'); break }
        const trust = cited.some((candidate) => candidate.speaker === 'user') ? 'user' : note.trust
        const problem = lintNoteText(op.text, trust)
        if (problem !== undefined) { reject(op, problem); break }
        note.text = op.text
        note.trust = trust
        note.sources = mergeSources(note.sources, sourcesOf(cited))
        note.lastConfirmed = now
        counts.updated += 1
        break
      }
      case 'merge': {
        const merged = [...new Set(op.notes)].map((id) => byId.get(id))
        if (merged.length < 2 || merged.some((note) => note === undefined)) { reject(op, 'a merge needs two or more known notes'); break }
        const parts = merged as Note[]
        // A merge brings no new evidence, so it must not raise trust: an inferred
        // (or tainted) note merged into one the user stated would inherit user trust.
        const trust = (parts[0] as Note).trust
        if (parts.some((note) => note.trust !== trust)) { reject(op, 'only notes of the same trust can be merged'); break }
        // The merged text is model-written: lint it as untrusted whatever its trust.
        const problem = lintNoteText(op.text, 'inferred')
        if (problem !== undefined) { reject(op, problem); break }
        const id = makeId()
        const first = parts[0] as Note
        byId.set(id, {
          id,
          text: op.text,
          kind: op.kind ?? first.kind,
          trust,
          sources: parts.reduce<NoteSource[]>((all, note) => mergeSources(all, note.sources), []),
          firstSeen: parts.map((note) => note.firstSeen).sort()[0] ?? now,
          // No new evidence: keep the latest confirmation of the parts, not now.
          lastConfirmed: parts.map((note) => note.lastConfirmed).sort().at(-1) ?? now,
          // Transitive, so links to earlier ids (skill history, global notes) survive merges.
          supersedes: [...new Set(parts.flatMap((note) => [note.id, ...(note.supersedes ?? [])]))],
        })
        for (const note of parts) byId.delete(note.id)
        counts.merged += 1
        break
      }
      case 'reword': {
        const note = byId.get(op.note)
        if (note === undefined) { reject(op, 'unknown note'); break }
        // The reworded text is model-written: lint it as untrusted whatever its trust.
        const problem = lintNoteText(op.text, 'inferred')
        if (problem !== undefined) { reject(op, problem); break }
        if (op.text === note.text) break
        note.text = op.text
        counts.reworded += 1
        break
      }
      case 'drop': {
        const note = byId.get(op.note)
        if (note === undefined) { reject(op, 'unknown note'); break }
        const cited = evidence(op, op.candidates)
        if (cited === undefined) break
        if (!mayOverturn(note, cited)) { reject(op, 'an inferred candidate from one session cannot remove a note the user stated'); break }
        byId.delete(note.id)
        counts.dropped += 1
        break
      }
    }
  }
  return { notes: [...byId.values()], rejected, counts }
}

/** Whether a single-session note is still fresh enough to load (multi-session notes always are). */
export function fresh(note: Note, now: string = new Date().toISOString()): boolean {
  return distinctSessions(note.sources) >= 2 || Date.parse(note.lastConfirmed) >= Date.parse(now) - SINGLE_SESSION_TTL_DAYS * 86_400_000
}

/** Whether a note may be loaded into every session. */
export function injectable(note: Note): boolean {
  if (!INJECT_KINDS.includes(note.kind)) return false
  if (note.trust === 'user') return true
  return distinctSessions(note.sources.filter((source) => source.tainted !== true)) >= INFERRED_INJECT_SESSIONS
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2))
}

/** Share of words two texts have in common (Jaccard). */
export function overlap(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const word of x) if (y.has(word)) shared += 1
  return shared / (x.size + y.size - shared)
}

/**
 * The injected list, decided in code: eligible kinds only, notes seen in
 * several sessions before single-session ones (at most {@link SINGLE_SESSION_SLOTS},
 * and only while confirmed in the last {@link SINGLE_SESSION_TTL_DAYS} days),
 * near-duplicates skipped, until the rendered block would exceed `maxBytes`.
 * Within each group the proposed order is kept.
 */
export function chooseInjected(notes: readonly Note[], proposed: readonly string[], maxBytes: number, now: string = new Date().toISOString()): string[] {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const ordered = [...new Set(proposed)].map((id) => byId.get(id)).filter((note): note is Note => note !== undefined && injectable(note))
  const multi = ordered.filter((note) => distinctSessions(note.sources) >= 2)
  const fresh = Date.parse(now) - SINGLE_SESSION_TTL_DAYS * 86_400_000
  const single = ordered.filter((note) => distinctSessions(note.sources) < 2 && Date.parse(note.lastConfirmed) >= fresh).slice(0, SINGLE_SESSION_SLOTS * 3)
  const chosen: Note[] = []
  let singles = 0
  for (const note of [...multi, ...single]) {
    const isSingle = distinctSessions(note.sources) < 2
    if (isSingle && singles >= SINGLE_SESSION_SLOTS) continue
    if (chosen.some((other) => overlap(other.text, note.text) >= DUPLICATE_OVERLAP)) continue
    const next = [...chosen, note]
    if (Buffer.byteLength(renderInjected({ notes: next, wiki: [], injected: next.map((n) => n.id) })) > maxBytes) continue
    chosen.push(note)
    if (isSingle) singles += 1
  }
  return chosen.map((note) => note.id)
}

export function parseInjected(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.injected)) throw new Error('expected {"injected":[...]}')
  return ids(value.injected)
}
