/**
 * One dream, end to end: select sessions, render, extract candidates,
 * consolidate, rebuild the wiki, choose the injected notes, stage the result.
 *
 * Nothing here writes to a store's versions. The dream's output is staged
 * under `dreams/<id>/` for the user to review and apply.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/run
 */

import type { MemoryStore } from '../store.ts'
import type { Candidate, DreamRecord, DreamStats, MemorySnapshot, Note } from '../types.ts'
import { BudgetExceeded, DreamModel, type Budget, type LlmLike, type ModelChoice } from '../llm.ts'
import { applyOps, chooseInjected, injectable, parseCandidates, parseInjected, parseOps, type Rejection } from './consolidate.ts'
import { CONSOLIDATE_SYSTEM, consolidatePrompt, EXTRACT_SYSTEM, extractPrompt, PROMOTE_SYSTEM, promotePrompt, PROMPT_VERSION, WIKI_SYSTEM, wikiPrompt } from './prompts.ts'
import { chunkLines, formatLine, renderSession, type EventLike, type TaintPolicy } from './render.ts'
import { parseWiki, renderDiff } from './wiki.ts'

/** The slice of `ctx.sessionQuery` used here. */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeaderLike }>>
  filterSessions(filters: ReadonlyArray<{ kind: string; values?: readonly unknown[]; from?: number; to?: number }>, signal?: AbortSignal): Promise<Array<{ header: SessionHeaderLike }>>
  readSession(sessionId: string): Promise<{ session: SessionHeaderLike; events: EventLike[] }>
}

export interface SessionHeaderLike {
  id: string
  createdAt: number
  cwd?: string
  origin?: string
}

export interface DreamSettings {
  maxSessions: number
  taintPolicy: TaintPolicy
  injectedMaxBytes: number
  chunkChars: number
  candidatesPerCall: number
  budget: Omit<Budget, 'deadline'> & { maxMinutes: number }
  callTimeoutMs: number
}

export interface DreamRequest {
  /** Dream exactly these sessions (still subject to the store's scope). */
  sessionIds?: readonly string[]
  /** Never read this session (the conversation that started the dream). */
  excludeSessionId?: string
  /** Re-read sessions the ledger already covers. */
  force?: boolean
}

export interface DreamDeps {
  store: MemoryStore
  sessions: SessionQueryLike
  llm: LlmLike
  model: ModelChoice
  settings: DreamSettings
  now?: () => Date
}

const MIN_CONFIDENCE = 0.2

/** Run a dream to a terminal status. Never throws; the outcome is in the record. */
export async function runDream(deps: DreamDeps, record: DreamRecord, request: DreamRequest, signal: AbortSignal): Promise<DreamRecord> {
  const { store, settings } = deps
  const now = (): string => (deps.now?.() ?? new Date()).toISOString()
  const progress = async (text: string): Promise<void> => {
    record.progress = text
    await store.saveDream(record)
  }
  const model = new DreamModel(deps.llm, deps.model, { ...settings.budget, deadline: Date.now() + settings.budget.maxMinutes * 60_000 }, signal, settings.callTimeoutMs)
  const stats: DreamStats = { llmCalls: 0, inputChars: 0, candidates: 0, quarantined: 0, added: 0, updated: 0, merged: 0, dropped: 0, confirmed: 0, rejectedOps: 0 }
  const quarantine: unknown[] = []
  const rejections: Rejection[] = []
  record.status = 'running'
  let finishing = false
  try {
    const base = await store.readVersion(record.store.key, record.baseVersion)
    await progress('selecting sessions')
    const selected = await selectSessions(deps, record, request, signal)

    // ---- extract ----
    const candidates: Candidate[] = []
    let index = 0
    for (const { header, afterSeq } of selected) {
      signal.throwIfAborted()
      index += 1
      const snapshot = await deps.sessions.readSession(header.id)
      const rendered = renderSession(header.id, snapshot.events, { afterSeq, taintPolicy: settings.taintPolicy })
      if (rendered === undefined) continue
      const checkpointKey = `${header.id}-${rendered.throughSeq}-p${PROMPT_VERSION}`
      let found = await store.readCheckpoint<Candidate[]>(record.id, checkpointKey)
      if (found === undefined) {
        found = []
        const chunks = chunkLines(rendered.lines, settings.chunkChars)
        let chunkIndex = 0
        for (const chunk of chunks) {
          chunkIndex += 1
          await progress(`reading session ${index}/${selected.length}${chunks.length > 1 ? `, part ${chunkIndex}/${chunks.length}` : ''}`)
          const user = extractPrompt(chunk.map(formatLine).join('\n'), record.instructions)
          if (!model.fits(EXTRACT_SYSTEM.length + user.length)) throw new BudgetExceeded('extraction')
          found.push(...await model.json(EXTRACT_SYSTEM, user, (value) => parseCandidates(value, chunk, rendered)))
        }
        await store.writeCheckpoint(record.id, checkpointKey, found)
      }
      candidates.push(...found)
      record.sessions.push({ sessionId: header.id, throughSeq: rendered.throughSeq, tainted: rendered.tainted })
    }
    await finish(base, candidates)
  } catch (error) {
    if (error instanceof BudgetExceeded && !finishing && !signal.aborted) {
      record.truncated = true
      try {
        await finish(await store.readVersion(record.store.key, record.baseVersion), [])
      } catch (inner) {
        fail(inner)
      }
    } else if (signal.aborted) {
      record.status = 'canceled'
      record.progress = 'canceled'
    } else {
      fail(error)
    }
  }
  stats.llmCalls = model.calls
  stats.inputChars = model.inputChars
  stats.rejectedOps = rejections.length
  record.stats = stats
  await store.saveDream(record)
  return record

  function fail(error: unknown): void {
    record.status = 'failed'
    record.error = error instanceof Error ? error.message : String(error)
    record.progress = 'failed'
  }

  /** Consolidate what was extracted and stage the next snapshot. */
  async function finish(base: MemorySnapshot, extracted: Candidate[]): Promise<void> {
    finishing = true
    // Re-collect candidates from checkpoints when extraction was cut short.
    const all = extracted.length > 0 || !record.truncated ? extracted : await collectCheckpoints()
    all.forEach((candidate, i) => { candidate.id = `c${i + 1}` })
    stats.candidates = all.length
    const usable: Candidate[] = []
    for (const candidate of all) {
      if (candidate.speaker === 'tool') quarantine.push({ ...candidate, reason: 'only tool output supports it' })
      else if (candidate.confidence < MIN_CONFIDENCE) quarantine.push({ ...candidate, reason: 'low confidence' })
      else usable.push(candidate)
    }
    stats.quarantined = quarantine.length

    let notes: Note[] = base.notes
    let budgetHit = false
    for (let start = 0; start < usable.length; start += settings.candidatesPerCall) {
      const batch = usable.slice(start, start + settings.candidatesPerCall)
      await progress(`consolidating ${Math.min(start + batch.length, usable.length)}/${usable.length} candidates`)
      const user = consolidatePrompt(notes, batch, record.instructions)
      if (!model.fits(CONSOLIDATE_SYSTEM.length + user.length)) { budgetHit = true; break }
      const ops = await model.json(CONSOLIDATE_SYSTEM, user, parseOps)
      const result = applyOps(notes, batch, ops, now())
      notes = result.notes
      rejections.push(...result.rejected)
      for (const key of ['added', 'updated', 'merged', 'dropped', 'confirmed'] as const) stats[key] += result.counts[key]
    }

    const changed = JSON.stringify(notes) !== JSON.stringify(base.notes)
    let wiki = base.wiki
    let injected = base.injected.filter((id) => notes.some((note) => note.id === id && injectable(note)))
    if (changed && !budgetHit) {
      if (notes.length === 0) wiki = []
      else {
        await progress('rewriting the wiki')
        const user = wikiPrompt(notes, base.wiki)
        if (model.fits(WIKI_SYSTEM.length + user.length)) wiki = await model.json(WIKI_SYSTEM, user, (value) => parseWiki(value, notes))
        else budgetHit = true
      }
      const eligible = notes.filter(injectable)
      if (eligible.length === 0) injected = []
      else if (!budgetHit) {
        await progress('choosing what every session loads')
        const user = promotePrompt(eligible, injected)
        if (model.fits(PROMOTE_SYSTEM.length + user.length)) injected = chooseInjected(notes, await model.json(PROMOTE_SYSTEM, user, parseInjected), settings.injectedMaxBytes)
        else budgetHit = true
      }
    }
    if (budgetHit) record.truncated = true
    injected = chooseInjected(notes, injected, settings.injectedMaxBytes)

    const staged: MemorySnapshot = { notes, wiki, injected }
    await store.writeStaged(record.id, staged)
    for (const rejection of rejections) quarantine.push({ rejectedOp: rejection.op, reason: rejection.reason })
    await store.writeQuarantine(record.id, quarantine)
    const scope = record.store.cwd === undefined ? 'global memory' : `memory for ${record.store.cwd}`
    await store.writeDiff(record.id, renderDiff(base, staged, [
      `# Dream ${record.id}: ${scope}`,
      '',
      `Based on v${record.baseVersion}. Read ${record.sessions.length} session${record.sessions.length === 1 ? '' : 's'}${record.sessions.some((s) => s.tainted) ? ` (${record.sessions.filter((s) => s.tainted).length} had read web or tool content and contributed only what the user typed)` : ''}; ${stats.candidates} candidates, ${quarantine.length} kept out of memory.${record.truncated ? ' The budget ran out, so this dream is partial.' : ''}`,
      '',
      `Apply with \`/dream apply ${record.id}\`, or \`/dream discard ${record.id}\`.`,
    ].join('\n')))
    record.status = 'completed'
    record.progress = changed ? 'ready for review' : 'no changes'
  }

  async function collectCheckpoints(): Promise<Candidate[]> {
    const result: Candidate[] = []
    for (const session of record.sessions) {
      const found = await store.readCheckpoint<Candidate[]>(record.id, `${session.sessionId}-${session.throughSeq}-p${PROMPT_VERSION}`)
      if (found !== undefined) result.push(...found)
    }
    return result
  }
}

/** Sessions with something new for this store, newest first. */
async function selectSessions(deps: DreamDeps, record: DreamRecord, request: DreamRequest, signal: AbortSignal): Promise<Array<{ header: SessionHeaderLike; afterSeq: number }>> {
  const filters: Array<{ kind: string; values: readonly unknown[] }> = []
  if (record.store.cwd !== undefined) filters.push({ kind: 'cwd', values: [record.store.cwd] })
  if (request.sessionIds !== undefined) filters.push({ kind: 'id', values: request.sessionIds })
  const records = filters.length === 0 ? await deps.sessions.listSessions(signal) : await deps.sessions.filterSessions(filters, signal)
  const ledger = request.force === true ? {} : await deps.store.ledger(record.store.key)
  const candidates = records
    .map((entry) => entry.header)
    .filter((header) => header.origin !== 'subagent' && header.id !== request.excludeSessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
  const selected: Array<{ header: SessionHeaderLike; afterSeq: number }> = []
  for (const header of candidates) {
    if (selected.length >= deps.settings.maxSessions) break
    const covered = ledger[header.id]?.throughSeq ?? -1
    if (covered >= 0) {
      // Skip sessions with nothing after the seq a previous dream covered.
      const snapshot = await deps.sessions.readSession(header.id)
      if (!snapshot.events.some((event) => event.seq > covered)) continue
    }
    selected.push({ header, afterSeq: covered })
  }
  return selected.reverse()
}
