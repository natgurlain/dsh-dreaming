/**
 * Automatic dreaming: on a timer, dream every workspace that has new
 * sessions, apply each result, and write one report the user can read.
 *
 * Applying automatically skips the user's review, not the rules: every note
 * still passes the code checks in `pipeline/consolidate.ts`, tainted sessions
 * still contribute only what the user typed, the injected block keeps its cap,
 * and each apply is a new version `/dream rollback` can undo.
 *
 * @module @natgurlain/dsh-dreaming/auto
 */

import { join } from 'node:path'
import type { Dreamer } from './dreamer.ts'
import { readJson, readText, writeJson, writePrivate } from './files.ts'
import { storeFor, type MemoryStore } from './store.ts'
import type { SessionQueryLike } from './pipeline/run.ts'
import type { DreamRecord } from './types.ts'

export interface AutoSettings {
  enabled: boolean
  intervalHours: number
  apply: boolean
  /** Delay before the first check after the Host starts. */
  startDelayMs: number
  /** How often to check whether a run is due. */
  checkEveryMs: number
}

interface AutoState { lastRunAt?: string; lastReport?: string }

export interface AutoRunResult {
  startedAt: string
  finishedAt: string
  dreams: Array<{ record: DreamRecord; applied?: number; note: string }>
  report: string
  reportPath: string
}

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
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  private statePath(): string {
    return join(this.store.root, 'auto.json')
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

  /** Run when the interval has passed since the last run. */
  async tick(): Promise<AutoRunResult | undefined> {
    if (this.stopped || this.running !== undefined) return undefined
    const state = await readJson<AutoState>(this.statePath(), {})
    const last = state.lastRunAt === undefined ? 0 : Date.parse(state.lastRunAt)
    if (Date.now() - last < this.settings.intervalHours * 3_600_000) return undefined
    return this.runNow()
  }

  /** Dream every workspace with sessions now, regardless of the interval. */
  async runNow(): Promise<AutoRunResult | undefined> {
    if (this.running !== undefined) return this.running
    this.running = this.run().catch((error: unknown) => {
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

  private async run(): Promise<AutoRunResult | undefined> {
    const sessions = this.sessions()
    if (sessions === undefined) return undefined
    const startedAt = new Date().toISOString()
    const workspaces = [...new Set((await sessions.listSessions())
      .map((entry) => entry.header)
      .filter((header) => header.origin !== 'subagent' && typeof header.cwd === 'string' && header.cwd !== '')
      .map((header) => header.cwd as string))].sort()
    const dreams: AutoRunResult['dreams'] = []
    for (const cwd of workspaces) {
      if (this.stopped) break
      let record: DreamRecord
      try {
        record = await this.dreamer.start(storeFor(cwd), {})
      } catch (error) {
        this.log(`automatic dream skipped ${cwd}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const settled = await this.dreamer.settled(record.id) ?? record
      if (settled.status !== 'completed') {
        dreams.push({ record: settled, note: settled.status === 'failed' ? `failed: ${settled.error ?? 'unknown error'}` : settled.status })
        continue
      }
      if (settled.sessions.length === 0) {
        await this.store.discard(settled.id)
        continue
      }
      if (settled.progress === 'no changes' || !this.settings.apply) {
        if (settled.progress === 'no changes') await this.store.discard(settled.id)
        dreams.push({ record: settled, note: settled.progress === 'no changes' ? 'read new sessions; nothing worth remembering' : `waiting for review: /dream apply ${settled.id}` })
        continue
      }
      try {
        const { version } = await this.dreamer.apply(settled.id)
        dreams.push({ record: settled, applied: version, note: `applied as v${version}` })
      } catch (error) {
        dreams.push({ record: settled, note: `not applied: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    const finishedAt = new Date().toISOString()
    const report = await this.renderReport(startedAt, finishedAt, dreams)
    const reportPath = join(this.store.root, 'reports', `${startedAt.replace(/[:.]/g, '-')}.md`)
    await writePrivate(reportPath, report)
    await writePrivate(join(this.store.root, 'reports', 'latest.md'), report)
    await writeJson(this.statePath(), { lastRunAt: startedAt, lastReport: reportPath } satisfies AutoState)
    return { startedAt, finishedAt, dreams, report, reportPath }
  }

  private async renderReport(startedAt: string, finishedAt: string, dreams: AutoRunResult['dreams']): Promise<string> {
    const lines = [`# Dream report, ${startedAt.slice(0, 16).replace('T', ' ')} UTC`, '']
    if (dreams.length === 0) {
      lines.push('No workspace had new sessions. Memory is unchanged.', '')
      return `${lines.join('\n')}\n`
    }
    const applied = dreams.filter((dream) => dream.applied !== undefined)
    const sessionsRead = dreams.reduce((sum, dream) => sum + dream.record.sessions.length, 0)
    const calls = dreams.reduce((sum, dream) => sum + (dream.record.stats?.llmCalls ?? 0), 0)
    lines.push(`Read ${sessionsRead} session${sessionsRead === 1 ? '' : 's'} across ${dreams.length} workspace${dreams.length === 1 ? '' : 's'}; updated memory for ${applied.length}. ${calls} model calls; finished ${finishedAt.slice(11, 16)} UTC.`, '')
    lines.push('Undo any of these with `/dream rollback` in that workspace.', '')
    for (const dream of dreams) {
      lines.push(`---`, '', `**${dream.record.store.cwd ?? 'global'}**: ${dream.note}`, '')
      const diff = await this.store.readDiff(dream.record.id)
      if (diff !== undefined) lines.push(diff.split('\n').filter((line) => !line.startsWith('# Dream ') && !line.startsWith('Apply with')).join('\n').trim(), '')
    }
    return `${lines.join('\n').trimEnd()}\n`
  }
}
