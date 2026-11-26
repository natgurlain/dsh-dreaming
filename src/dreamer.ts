/**
 * The dream runner and the injected-memory cache.
 *
 * Dreams run in the background inside the Host process, one at a time per
 * store. A dream cut off by a restart is marked failed on the next start; its
 * checkpoints stay on disk.
 *
 * @module @natgurlain/dsh-dreaming/dreamer
 */

import { renderInjected, storeFor, type MemoryStore } from './store.ts'
import type { DreamRecord, StoreRef } from './types.ts'
import type { LlmLike, ModelChoice } from './llm.ts'
import { runDream, type DreamRequest, type DreamSettings, type SessionQueryLike } from './pipeline/run.ts'

export interface DreamerHost {
  store: MemoryStore
  settings: DreamSettings
  sessions(): SessionQueryLike | undefined
  llm(): LlmLike | undefined
  model(): ModelChoice | undefined
  /** Called after a dream reaches a terminal status. */
  onSettled?(record: DreamRecord): void
}

export class Dreamer {
  private readonly running = new Map<string, { controller: AbortController; storeKey: string; done: Promise<DreamRecord> }>()
  private readonly injected = new Map<string, string>()

  constructor(private readonly host: DreamerHost) {}

  /** Mark dreams a previous Host left running as failed, and load the cache. */
  async init(): Promise<void> {
    for (const record of await this.host.store.listDreams()) {
      if (record.status !== 'pending' && record.status !== 'running') continue
      record.status = 'failed'
      record.error = 'interrupted: the Host stopped while this dream was running'
      record.progress = 'failed'
      await this.host.store.saveDream(record)
    }
    for (const ref of await this.host.store.stores()) await this.refresh(ref.key)
  }

  /** Start a dream; resolves once it is recorded, not when it finishes. */
  async start(store: StoreRef, request: DreamRequest & { instructions?: string }): Promise<DreamRecord> {
    const sessions = this.host.sessions()
    if (sessions === undefined) throw new Error('this DSH composition has no session history service (sessionQuery)')
    const llm = this.host.llm()
    if (llm === undefined) throw new Error('this DSH composition has no model service (llm)')
    const model = this.host.model()
    if (model === undefined) throw new Error('no model is selected; choose a default model in DSH or set `model` in the dreaming config')
    for (const entry of this.running.values()) {
      if (entry.storeKey === store.key) throw new Error('a dream is already running for this memory; wait for it or cancel it')
    }
    const record = await this.host.store.createDream(store, request.instructions?.slice(0, 1_000))
    const controller = new AbortController()
    const done = runDream({ store: this.host.store, sessions, llm, model, settings: this.host.settings }, record, request, controller.signal)
      .finally(() => { this.running.delete(record.id) })
    done.then((settled) => this.host.onSettled?.(settled), () => undefined)
    this.running.set(record.id, { controller, storeKey: store.key, done })
    return record
  }

  /** Wait for a running dream (tests, shutdown). */
  async settled(id: string): Promise<DreamRecord | undefined> {
    return this.running.get(id)?.done ?? this.host.store.readDream(id)
  }

  cancel(id: string): boolean {
    const entry = this.running.get(id)
    if (entry === undefined) return false
    entry.controller.abort(new Error('canceled'))
    return true
  }

  /** Abort every running dream and wait for them to record it. */
  async stop(): Promise<void> {
    const entries = [...this.running.values()]
    for (const entry of entries) entry.controller.abort(new Error('the plugin stopped'))
    await Promise.allSettled(entries.map((entry) => entry.done))
  }

  async apply(id: string): Promise<{ record: DreamRecord; version: number }> {
    const version = await this.host.store.apply(id)
    const record = await this.host.store.readDream(id) as DreamRecord
    await this.refresh(record.store.key)
    return { record, version }
  }

  async rollback(store: StoreRef, version?: number): Promise<number> {
    const target = await this.host.store.rollback(store.key, version)
    await this.refresh(store.key)
    return target
  }

  async refresh(key: string): Promise<void> {
    const { snapshot } = await this.host.store.current(key)
    this.injected.set(key, renderInjected(snapshot))
  }

  /**
   * The memory block for a session (global plus its workspace). Synchronous:
   * the system prompt evaluates contexts without awaiting.
   */
  contextFor(cwd: string | undefined): string {
    const global = this.injected.get('global') ?? ''
    const workspace = cwd === undefined ? '' : this.injected.get(storeFor(cwd).key) ?? ''
    const parts = [global === '' ? '' : `Across all workspaces. ${global}`, workspace === '' ? '' : `For this workspace. ${workspace}`].filter((part) => part !== '')
    return parts.join('\n')
  }
}
