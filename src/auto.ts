/**
 * Automatic dreaming: when a run is due and the user has been idle, dream
 * every workspace with new sessions, apply each result, promote preferences
 * shared across workspaces to global memory, write one report, and notify.
 *
 * Applying automatically skips the user's review, not the rules: every note
 * still passes the code checks in `pipeline/consolidate.ts`, tainted sessions
 * still contribute only what the user typed, the injected block keeps its cap,
 * skills always wait for `/dream skills approve`, and each apply is a new
 * version `/dream rollback` can undo.
 *
 * @module @natgurlain/dsh-dreaming/auto
 */

import { join } from 'node:path'
import type { Dreamer } from './dreamer.ts'
import { readJson, readText, writeJson, writePrivate } from './files.ts'
import { storeFor, type MemoryStore } from './store.ts'
import type { SessionQueryLike } from './pipeline/run.ts'
import type { DreamRecord, StoreRef } from './types.ts'

export interface AutoSettings {
  enabled: boolean
  intervalHours: number
  /** After a run in which some workspace failed, try again this soon. */
  retryAfterMinutes: number
  apply: boolean
  /** Delay before the first check after the Host starts. */
  startDelayMs: number
  /** How often to check whether a run is due. */
  checkEveryMs: number
  /** Wait until no session has had activity for this long (0: do not wait). */
  idleMinutes: number
  /** Promote preferences shared by several workspaces to global memory. */
  global: boolean
  /** Show a desktop notification when a report has news. */
  notify: boolean
}

interface AutoState { lastRunAt?: string; lastReport?: string; nextRunAt?: string }


export interface AutoRunResult {
  startedAt: string
  finishedAt: string
  dreams: Array<{ record: DreamRecord; applied?: number; note: string }>
  /** The run stopped early because the user became active. */
  paused?: true
  report: string
  reportPath: string
}

export interface AutoHost {
  /** Time of the most recent session activity, if it can be told. */
  lastActivity?(): Promise<number | undefined>
  /** Show a desktop notification. */
  notify?(title: string, message: string): void
  log?(message: string): void
}

/** How long to wait before checking again when the user is active. */
const ACTIVE_RECHECK_MS = 30 * 60_000

export class AutoDreamer {
  private timer: NodeJS.Timeout | undefined
  private firstTimer: NodeJS.Timeout | undefined
  private running: Promise<AutoRunResult | undefined> | undefined
  private stopped = false

  constructor(
    private readonly dreamer: Dreamer,
    private readonly store: MemoryStore,
    private readonly sessions: () => SessionQueryLike | undefined,
    private readonly settings: AutoSettings,
    private readonly host: AutoHost = {},
  ) {}

  private statePath(): string {
    return join(this.store.root, 'auto.json')
  }

  private log(message: string): void {
    this.host.log?.(message)
  }

  start(): void {
    if (!this.settings.enabled) return
    this.firstTimer = setTimeout(() => { void this.tick() }, this.settings.startDelayMs)
    this.timer = setInterval(() => { void this.tick() }, this.settings.checkEveryMs)
    this.firstTimer.unref?.()
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.firstTimer !== undefined) clearTimeout(this.firstTimer)
    if (this.timer !== undefined) clearInterval(this.timer)
    await this.running
  }

  /** Whether the user has been idle long enough to dream. */
  async idle(): Promise<boolean> {
    if (this.settings.idleMinutes <= 0 || this.host.lastActivity === undefined) return true
    let last: number | undefined
    try {
      last = await this.host.lastActivity()
    } catch {
      return true
    }
    return last === undefined || Date.now() - last >= this.settings.idleMinutes * 60_000
  }

  /** Run when due and the user is idle. */
  async tick(): Promise<AutoRunResult | undefined> {
    if (this.stopped || this.running !== undefined) return undefined
    const state = await readJson<AutoState>(this.statePath(), {})
    const last = state.lastRunAt === undefined ? 0 : Date.parse(state.lastRunAt)
    let due = state.nextRunAt === undefined ? last + this.settings.intervalHours * 3_600_000 : Date.parse(state.nextRunAt)
    if (state.nextRunAt === undefined && state.lastRunAt !== undefined) {
      // State from before retries existed: a run whose dreams failed is due for a retry.
      const since = state.lastRunAt
      const failed = (await this.store.listDreams()).some((record) => record.status === 'failed' && record.createdAt >= since)
      if (failed) due = last + this.settings.retryAfterMinutes * 60_000
    }
    if (Date.now() < due || !await this.idle()) return undefined
    return this.runNow({ respectIdle: true })
  }

  /** Whether an automatic run is in progress. */
  get busy(): boolean {
    return this.running !== undefined
  }

  /** Run now, regardless of the interval. Resolves when the run finishes. */
  async runNow(options: { respectIdle?: boolean } = {}): Promise<AutoRunResult | undefined> {
    if (this.running !== undefined) return this.running
    this.running = this.run(options.respectIdle === true).catch((error: unknown) => {
      this.log(`automatic dream failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }).finally(() => { this.running = undefined })
    return this.running
  }

  /** The latest report, if any. */
  async latestReport(): Promise<string | undefined> {
    const state = await readJson<AutoState>(this.statePath(), {})
    if (state.lastReport === undefined) return undefined
    return readText(state.lastReport)
  }

  private async targets(): Promise<StoreRef[]> {
    const sessions = this.sessions()
    if (sessions === undefined) return []
    const workspaces = [...new Set((await sessions.listSessions())
      .map((entry) => entry.header)
      .filter((header) => header.origin !== 'subagent' && typeof header.cwd === 'string' && header.cwd !== '')
      .map((header) => header.cwd as string))].sort()
    return workspaces.map((cwd) => storeFor(cwd))
  }

  /** Wait for a started dream and apply it (or leave it for review). */
  private async settle(record: DreamRecord): Promise<AutoRunResult['dreams'][number] | undefined> {
    const settled = await this.dreamer.settled(record.id) ?? record
    if (settled.status !== 'completed') return { record: settled, note: settled.status === 'failed' ? `failed: ${settled.error ?? 'unknown error'}` : settled.status }
    if (settled.progress === 'no changes') {
      await this.store.discard(settled.id)
      return settled.sessions.length > 0 ? { record: settled, note: 'read new sessions; nothing worth remembering' } : undefined
    }
    if (!this.settings.apply) return { record: settled, note: `waiting for review: /dream apply ${settled.id}` }
    try {
      const { version } = await this.dreamer.apply(settled.id)
      return { record: settled, applied: version, note: `applied as v${version}` }
    } catch (error) {
      return { record: settled, note: `not applied: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async run(respectIdle: boolean): Promise<AutoRunResult | undefined> {
    const startedAt = new Date().toISOString()
    const dreams: AutoRunResult['dreams'] = []
    let paused = false
    for (const ref of await this.targets()) {
      if (this.stopped) break
      if (respectIdle && !await this.idle()) { paused = true; break }
      let record: DreamRecord
      try {
        record = await this.dreamer.start(ref, {})
      } catch (error) {
        this.log(`dream skipped ${ref.cwd ?? ref.key}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const entry = await this.settle(record)
      if (entry !== undefined) dreams.push(entry)
    }
    // Only when some workspace memory changed in this run: otherwise there is nothing new to generalize.
    if (this.settings.global && !paused && !this.stopped && dreams.some((dream) => dream.applied !== undefined)) {
      try {
        const entry = await this.settle(await this.dreamer.startGlobal())
        if (entry !== undefined) dreams.push(entry)
      } catch (error) {
        this.log(`global pass skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const finishedAt = new Date().toISOString()
    const failed = dreams.filter((dream) => dream.record.status === 'failed').length
    const nextRunAt = new Date(paused
      ? Date.now() + ACTIVE_RECHECK_MS
      : failed > 0
        ? Date.now() + this.settings.retryAfterMinutes * 60_000
        : Date.parse(startedAt) + this.settings.intervalHours * 3_600_000).toISOString()
    const report = await this.renderReport({ startedAt, finishedAt, dreams, failed, nextRunAt, paused })
    const reportPath = join(this.store.root, 'reports', `${startedAt.replace(/[:.]/g, '-')}.md`)
    await writePrivate(reportPath, report)
    await writePrivate(join(this.store.root, 'reports', 'latest.md'), report)
    await writeJson(this.statePath(), { lastRunAt: startedAt, lastReport: reportPath, nextRunAt } satisfies AutoState)
    this.announce(dreams, failed, paused)
    return { startedAt, finishedAt, dreams, ...(paused ? { paused: true as const } : {}), report, reportPath }
  }

  private announce(dreams: AutoRunResult['dreams'], failed: number, paused: boolean): void {
    if (!this.settings.notify || this.host.notify === undefined) return
    const applied = dreams.filter((dream) => dream.applied !== undefined).length
    const review = dreams.filter((dream) => dream.note.startsWith('waiting for review')).length
    if (applied === 0 && failed === 0 && review === 0) return
    const parts = [
      applied > 0 ? `Updated memory for ${applied} workspace${applied === 1 ? '' : 's'}` : '',
      review > 0 ? `${review} waiting for review` : '',
      failed > 0 ? `${failed} failed` : '',
      paused ? 'paused while you work' : '',
    ].filter((part) => part !== '')
    try {
      this.host.notify('DSH dreaming', `${parts.join('; ')}. /dream report for details.`)
    } catch (error) {
      this.log(`notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async renderReport(run: { startedAt: string; finishedAt: string; dreams: AutoRunResult['dreams']; failed: number; nextRunAt: string; paused: boolean }): Promise<string> {
    const { startedAt, finishedAt, dreams, failed, nextRunAt, paused } = run
    const lines = [`# Dream report, ${startedAt.slice(0, 16).replace('T', ' ')} UTC`, '']
    if (paused) lines.push(`Paused because you were active; the remaining workspaces are dreamed after ${nextRunAt.slice(11, 16)} UTC once you have been idle for ${this.settings.idleMinutes} minutes.`, '')
    if (dreams.length === 0) {
      lines.push('No workspace had new sessions. Memory is unchanged.', '')
      return `${lines.join('\n')}\n`
    }
    const applied = dreams.filter((dream) => dream.applied !== undefined)
    const sessionsRead = dreams.reduce((sum, dream) => sum + dream.record.sessions.length, 0)
    const calls = dreams.reduce((sum, dream) => sum + (dream.record.stats?.llmCalls ?? 0), 0)
    lines.push(`Read ${sessionsRead} session${sessionsRead === 1 ? '' : 's'} across ${dreams.length} store${dreams.length === 1 ? '' : 's'}; updated memory for ${applied.length}. ${calls} model calls; finished ${finishedAt.slice(11, 16)} UTC.`, '')
    if (failed > 0) lines.push(`${failed} failed; the next try is at ${nextRunAt.slice(11, 16)} UTC. Sessions in a failed workspace are read again then.`, '')
    lines.push('Undo any of these with `/dream rollback` in that workspace (`/dream rollback global` for global memory).', '')
    for (const dream of dreams) {
      lines.push(`---`, '', `**${dream.record.store.cwd ?? 'global (all workspaces)'}**: ${dream.note}`, '')
      const diff = await this.store.readDiff(dream.record.id)
      if (diff !== undefined) lines.push(diff.split('\n').filter((line) => !line.startsWith('# Dream ') && !line.startsWith('Apply with')).join('\n').trim(), '')
    }
    return `${lines.join('\n').trimEnd()}\n`
  }
}
