/**
 * Replay: re-run consolidation, tidying and the injection choice on the
 * candidates earlier dreams already extracted (their checkpoints), from an
 * empty memory, and score what would be loaded into every session against
 * hand-made labels. It reads the real memory folder and never writes to it.
 *
 * Use it to measure a prompt or rule change before it reaches real memory:
 * `pnpm replay --labels labels.json`.
 *
 * @module @natgurlain/dsh-dreaming/replay
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson } from './files.ts'
import type { LlmLike, ModelChoice } from './llm.ts'
import { overlap } from './pipeline/consolidate.ts'
import { runDream, type DreamSettings } from './pipeline/run.ts'
import { MemoryStore, storeFor } from './store.ts'
import type { Candidate, DreamRecord, MemorySnapshot } from './types.ts'

/** Hand labels: for each workspace path, which injected notes should be loaded. */
export type Labels = Record<string, Array<{ text: string; keep: boolean | null }>>

/** Two texts at least this similar count as the same note. */
export const LABEL_MATCH = 0.5

export interface ReplayStoreResult {
  cwd: string
  candidates: number
  injected: string[]
  /** Injected notes matched to a label, by verdict. */
  kept: number
  dropped: number
  unlabeled: number
  /** Labelled "keep" notes that the replay did not inject. */
  missed: string[]
}

export interface ReplayResult {
  stores: ReplayStoreResult[]
  /** Of the injected notes that have a label, the share labelled keep. */
  precision: number | undefined
  /** Of the notes labelled keep, the share the replay injected. */
  recall: number | undefined
}

/** Candidates from every checkpoint of every dream, grouped by workspace. */
export async function checkpointCandidates(root: string): Promise<Map<string, Candidate[]>> {
  const byCwd = new Map<string, Candidate[]>()
  let ids: string[]
  try {
    ids = await readdir(join(root, 'dreams'))
  } catch {
    return byCwd
  }
  for (const id of ids) {
    const record = await readJson<DreamRecord | undefined>(join(root, 'dreams', id, 'dream.json'), undefined)
    const cwd = record?.store.cwd
    if (cwd === undefined) continue
    let files: string[]
    try {
      files = await readdir(join(root, 'dreams', id, 'checkpoints'))
    } catch {
      continue
    }
    const seen = byCwd.get(cwd) ?? []
    for (const file of files) {
      const candidates = await readJson<Candidate[]>(join(root, 'dreams', id, 'checkpoints', file), [])
      for (const candidate of candidates) {
        // The same session can be checkpointed by several dreams; keep one copy.
        if (!seen.some((other) => other.sessionId === candidate.sessionId && other.text === candidate.text)) seen.push(candidate)
      }
    }
    byCwd.set(cwd, seen)
  }
  return byCwd
}

/** A label file to fill in: the notes each workspace loads today, verdict blank. */
export async function labelTemplate(root: string): Promise<Labels> {
  const store = new MemoryStore(root)
  const labels: Labels = {}
  for (const ref of await store.stores()) {
    if (ref.cwd === undefined) continue
    const { snapshot } = await store.current(ref.key)
    const byId = new Map(snapshot.notes.map((note) => [note.id, note]))
    labels[ref.cwd] = snapshot.injected.map((id) => ({ text: byId.get(id)?.text ?? '', keep: null }))
  }
  return labels
}

export function score(cwd: string, injected: readonly string[], labels: Labels): Omit<ReplayStoreResult, 'candidates'> {
  const entries = (labels[cwd] ?? []).filter((entry) => entry.keep !== null)
  let kept = 0
  let dropped = 0
  let unlabeled = 0
  const hit = new Set<number>()
  for (const text of injected) {
    let best = -1
    let bestScore = 0
    entries.forEach((entry, index) => {
      const value = overlap(entry.text, text)
      if (value > bestScore) { bestScore = value; best = index }
    })
    if (best === -1 || bestScore < LABEL_MATCH) { unlabeled += 1; continue }
    hit.add(best)
    if (entries[best]?.keep === true) kept += 1
    else dropped += 1
  }
  const missed = entries.filter((entry, index) => entry.keep === true && !hit.has(index)).map((entry) => entry.text)
  return { cwd, injected: [...injected], kept, dropped, unlabeled, missed }
}

/** Replay every workspace that has checkpoints. */
export async function replay(options: { root: string; llm: LlmLike; model: ModelChoice; settings: DreamSettings; labels?: Labels; only?: string }): Promise<ReplayResult> {
  const byCwd = await checkpointCandidates(options.root)
  const stores: ReplayStoreResult[] = []
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-dreaming-replay-'))
  try {
    for (const [cwd, candidates] of byCwd) {
      if (options.only !== undefined && !cwd.includes(options.only)) continue
      const store = new MemoryStore(join(scratch, String(stores.length)))
      const record = await store.createDream(storeFor(cwd), undefined)
      const none = { listSessions: async () => [], filterSessions: async () => [], readSession: async () => { throw new Error('replay reads no sessions') } }
      const settled = await runDream({ store, sessions: none, llm: options.llm, model: options.model, settings: { ...options.settings, skills: false } }, record, { candidates }, new AbortController().signal)
      if (settled.status !== 'completed') throw new Error(`replay of ${cwd} ${settled.status}: ${settled.error ?? ''}`)
      const staged = await store.readStaged(record.id) as MemorySnapshot
      const byId = new Map(staged.notes.map((note) => [note.id, note]))
      const injected = staged.injected.map((id) => byId.get(id)?.text ?? '')
      stores.push({ candidates: candidates.length, ...score(cwd, injected, options.labels ?? {}) })
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const kept = stores.reduce((sum, s) => sum + s.kept, 0)
  const dropped = stores.reduce((sum, s) => sum + s.dropped, 0)
  const missed = stores.reduce((sum, s) => sum + s.missed.length, 0)
  return {
    stores,
    precision: kept + dropped === 0 ? undefined : kept / (kept + dropped),
    recall: kept + missed === 0 ? undefined : kept / (kept + missed),
  }
}

/** An `LlmLike` over an OpenAI-compatible endpoint, for running replay outside DSH. */
export function openAiCompatible(baseUrl: string, apiKey?: string): LlmLike {
  return {
    async *stream(options) {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0,
          messages: [{ role: 'system', content: options.system }, ...options.messages.map((message) => ({ role: message.role, content: message.content.map((part) => part.text).join('\n') }))],
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (!response.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `${response.status}: ${(await response.text()).slice(0, 300)}` } } }
        return
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      yield { type: 'text-delta', text: body.choices?.[0]?.message?.content ?? '' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
