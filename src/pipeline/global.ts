/**
 * The global pass: preferences the user stated in two or more workspaces
 * become one global note that every session loads, and stop taking space in
 * each workspace's block.
 *
 * Only notes the user stated, of the kinds that are injected, are
 * considered; a group must cite notes from at least two different
 * workspaces. The result is an ordinary dream on the `global` store, so it is
 * versioned, reported and undone with `/dream rollback global`.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/global
 */

import { DreamModel, type LlmLike, type ModelChoice } from '../llm.ts'
import type { MemoryStore } from '../store.ts'
import type { DreamRecord, MemorySnapshot, Note, NoteKind } from '../types.ts'
import { chooseInjected, INJECT_KINDS, lintNoteText, newNoteId, overlap, DUPLICATE_OVERLAP } from './consolidate.ts'
import { redact } from './redact.ts'
import type { DreamSettings } from './run.ts'
import { renderDiff } from './wiki.ts'

/** A preference must appear in this many workspaces to become global. */
export const GLOBAL_MIN_WORKSPACES = 2
const MAX_INPUT_NOTES = 200

export const GLOBAL_SYSTEM = `You find preferences a user holds across projects. You get notes from several workspaces, each id prefixed with its workspace number (w1:, w2:, ...). Group notes from DIFFERENT workspaces that express the same standing preference, correction or pitfall, and write one general rule for each group that holds in any workspace. Leave out anything project-specific (paths, project names, stack details). Only cite ids from the input.

Reply with only this JSON object: {"groups":[{"notes":["w1:n-...","w3:n-..."],"text":"...","kind":"preference|correction|pitfall"}]}`

interface Entry { store: string; note: Note; ref: string }

export function globalPrompt(entries: readonly Entry[]): string {
  return entries.map((entry) => JSON.stringify({ id: entry.ref, kind: entry.note.kind, text: entry.note.text })).join('\n')
}

type Link = { store: string; note: string }

/** A stable key for a set of workspace notes. */
export function linkKey(links: readonly Link[]): string[] {
  return links.map((link) => `${link.store}:${link.note}`).sort()
}

/**
 * Validate groups in code and merge them into the global notes.
 * @param tombstones - link sets the user rolled back; a group inside one is not promoted again.
 */
export function applyGroups(value: unknown, entries: readonly Entry[], base: readonly Note[], now: string, makeId: () => string = newNoteId, tombstones: ReadonlyArray<readonly string[]> = []): { notes: Note[]; added: number; updated: number; rejected: number } {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { groups?: unknown }).groups)) throw new Error('expected {"groups":[...]}')
  const byRef = new Map(entries.map((entry) => [entry.ref, entry]))
  const notes = base.map((note) => ({ ...note, sources: [...note.sources], ...(note.derivedFrom === undefined ? {} : { derivedFrom: [...note.derivedFrom] }) }))
  let added = 0
  let updated = 0
  let rejected = 0
  for (const raw of (value as { groups: unknown[] }).groups) {
    const group = raw as { notes?: unknown; text?: unknown; kind?: unknown }
    const members = (Array.isArray(group.notes) ? group.notes : []).map((ref) => typeof ref === 'string' ? byRef.get(ref) : undefined)
    const text = typeof group.text === 'string' ? redact(group.text.replace(/\s+/g, ' ').trim()).slice(0, 400) : ''
    const kind = INJECT_KINDS.includes(group.kind as NoteKind) ? group.kind as NoteKind : 'preference'
    const valid = members.filter((member): member is Entry => member !== undefined)
    if (valid.length !== members.length || new Set(valid.map((member) => member.store)).size < GLOBAL_MIN_WORKSPACES || text === '' || lintNoteText(text, 'user') !== undefined) {
      rejected += 1
      continue
    }
    const derivedFrom = valid.map((member) => ({ store: member.store, note: member.note.id }))
    const keys = linkKey(derivedFrom)
    if (tombstones.some((stone) => keys.every((key) => stone.includes(key)))) { rejected += 1; continue }
    const sources = valid.flatMap((member) => member.note.sources)
    const existing = notes.find((note) => overlap(note.text, text) >= DUPLICATE_OVERLAP || note.derivedFrom?.some((link) => derivedFrom.some((other) => other.store === link.store && other.note === link.note)))
    if (existing !== undefined) {
      const known = new Set(linkKey(existing.derivedFrom ?? []))
      // The same notes grouped again is not news: keep the text, so memory does not churn daily.
      if (keys.every((key) => known.has(key))) continue
      existing.text = text
      existing.lastConfirmed = now
      existing.sources = [...existing.sources, ...sources].filter((source, i, all) => all.findIndex((other) => other.sessionId === source.sessionId) === i)
      existing.derivedFrom = [...(existing.derivedFrom ?? []), ...derivedFrom].filter((link, i, all) => all.findIndex((other) => other.store === link.store && other.note === link.note) === i)
      updated += 1
    } else {
      notes.push({ id: makeId(), text, kind, trust: 'user', sources, firstSeen: now, lastConfirmed: now, derivedFrom })
      added += 1
    }
  }
  return { notes, added, updated, rejected }
}

/**
 * Re-point each global note at the workspace notes that still back it
 * (following merges through `supersedes`), and retire it once fewer than
 * {@link GLOBAL_MIN_WORKSPACES} workspaces do.
 */
export function retireGlobal(notes: readonly Note[], workspaces: ReadonlyMap<string, readonly Note[]>): { notes: Note[]; retired: number } {
  const current = (link: Link): Link | undefined => {
    const live = workspaces.get(link.store)
    const found = live?.find((note) => note.id === link.note) ?? live?.find((note) => note.supersedes?.includes(link.note))
    return found === undefined ? undefined : { store: link.store, note: found.id }
  }
  let retired = 0
  const kept: Note[] = []
  for (const note of notes) {
    if (note.derivedFrom === undefined) { kept.push(note); continue }
    const links = note.derivedFrom.map(current).filter((link): link is Link => link !== undefined)
    const unique = links.filter((link, i) => links.findIndex((other) => other.store === link.store && other.note === link.note) === i)
    if (new Set(unique.map((link) => link.store)).size < GLOBAL_MIN_WORKSPACES) { retired += 1; continue }
    kept.push(JSON.stringify(unique) === JSON.stringify(note.derivedFrom) ? note : { ...note, derivedFrom: unique })
  }
  return { notes: kept, retired }
}

/** Run the global pass as a dream on the `global` store. Never throws. */
export async function runGlobalDream(deps: { store: MemoryStore; llm: LlmLike; model: ModelChoice; settings: DreamSettings }, record: DreamRecord, signal: AbortSignal): Promise<DreamRecord> {
  const { store, settings } = deps
  const now = new Date().toISOString()
  const model = new DreamModel(deps.llm, deps.model, { ...settings.budget, deadline: Date.now() + settings.budget.maxMinutes * 60_000 }, signal, settings.callTimeoutMs, settings.retryDelaysMs)
  record.status = 'running'
  try {
    const base = await store.readVersion('global', record.baseVersion)
    const entries: Entry[] = []
    const workspaces = new Map<string, readonly Note[]>()
    let index = 0
    for (const ref of await store.stores()) {
      if (ref.key === 'global') continue
      index += 1
      const { snapshot } = await store.current(ref.key)
      workspaces.set(ref.key, snapshot.notes)
      for (const note of snapshot.notes) {
        if (note.trust === 'user' && INJECT_KINDS.includes(note.kind)) entries.push({ store: ref.key, note, ref: `w${index}:${note.id}` })
      }
    }
    const retirement = retireGlobal(base.notes, workspaces)
    let notes = retirement.notes
    let stats = { added: 0, updated: 0, rejected: 0 }
    const tombstones = await store.globalTombstones()
    if (new Set(entries.map((entry) => entry.store)).size >= GLOBAL_MIN_WORKSPACES) {
      record.progress = 'looking for preferences shared across workspaces'
      await store.saveDream(record)
      const user = globalPrompt(entries.slice(0, MAX_INPUT_NOTES))
      const result = await model.json(GLOBAL_SYSTEM, user, (value) => applyGroups(value, entries, notes, now, undefined, tombstones))
      notes = result.notes
      stats = result
    }
    const injected = chooseInjected(notes, [...notes].sort((a, b) => (b.derivedFrom?.length ?? 0) - (a.derivedFrom?.length ?? 0)).map((note) => note.id), settings.injectedMaxBytes, now)
    const staged: MemorySnapshot = { notes, wiki: base.wiki, injected }
    await store.writeStaged(record.id, staged)
    await store.writeDiff(record.id, renderDiff(base, staged, [`# Dream ${record.id}: global memory`, '', `Preferences you stated in ${GLOBAL_MIN_WORKSPACES} or more workspaces become global and are loaded in every workspace. ${stats.rejected} proposed group${stats.rejected === 1 ? '' : 's'} did not pass the checks.`].join('\n')))
    record.stats = { llmCalls: model.calls, inputChars: model.inputChars, candidates: entries.length, quarantined: stats.rejected, added: stats.added, updated: stats.updated, merged: 0, dropped: retirement.retired, confirmed: 0, rejectedOps: stats.rejected }
    record.status = 'completed'
    record.progress = JSON.stringify(staged) === JSON.stringify(base) ? 'no changes' : 'ready for review'
  } catch (error) {
    record.status = signal.aborted ? 'canceled' : 'failed'
    record.progress = record.status
    if (!signal.aborted) record.error = error instanceof Error ? error.message : String(error)
  }
  await store.saveDream(record)
  return record
}
