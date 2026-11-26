/**
 * On-disk memory: immutable versions per store, a HEAD pointer, dream
 * records with their staged output, and the ledger of dreamed sessions.
 *
 * ```
 * <root>/ledger.json                         storeKey -> sessionId -> {throughSeq, dreamId, outcome}
 * <root>/stores/<key>/store.json             {key, cwd?}
 * <root>/stores/<key>/HEAD                   current version number (0 = empty)
 * <root>/stores/<key>/versions/v0007/        snapshot.json, injected.md, wiki/*.md (immutable)
 * <root>/dreams/<id>/dream.json              DreamRecord
 * <root>/dreams/<id>/staged/                 the proposed next version (same layout)
 * <root>/dreams/<id>/diff.md                 what the dream changes
 * <root>/dreams/<id>/quarantine.jsonl        candidates kept out of memory
 * <root>/dreams/<id>/checkpoints/<sid>.json  per-session extraction results
 * ```
 *
 * A dream never writes under `stores/`. Only {@link MemoryStore.apply} does,
 * and only when the store's HEAD is still the version the dream started from.
 *
 * @module @natgurlain/dsh-dreaming/store
 */

import { createHash, randomUUID } from 'node:crypto'
import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, readJson, readText, writeJson, writePrivate } from './files.ts'
import type { DreamOutcome, DreamRecord, MemorySnapshot, Note, StoreRef, WikiPage } from './types.ts'

/** Versions kept per store; older ones are deleted on apply. */
export const KEPT_VERSIONS = 20

export const EMPTY_SNAPSHOT: MemorySnapshot = Object.freeze({ notes: [], wiki: [], injected: [] }) as MemorySnapshot

/** Header placed above the injected memory so the model weighs it correctly. */
export const INJECTED_HEADER = 'Memory learned from past sessions (may be stale or imperfect; verify before relying on it):'

export interface LedgerEntry {
  throughSeq: number
  dreamId: string
  outcome: DreamOutcome
}

type Ledger = Record<string, Record<string, LedgerEntry>>

/** The store for a workspace path, or the global one. */
export function storeFor(cwd: string | undefined): StoreRef {
  if (cwd === undefined || cwd === '') return { key: 'global' }
  return { key: `ws-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`, cwd }
}

const versionDir = (n: number): string => `v${String(n).padStart(4, '0')}`

/** Render the injected block from a snapshot, verbatim note texts only. */
export function renderInjected(snapshot: MemorySnapshot): string {
  const byId = new Map(snapshot.notes.map((note) => [note.id, note]))
  const lines = snapshot.injected.map((id) => byId.get(id)).filter((note): note is Note => note !== undefined).map((note) => `- ${note.text}`)
  return lines.length === 0 ? '' : `${INJECTED_HEADER}\n${lines.join('\n')}\n`
}

function renderWikiPage(page: WikiPage): string {
  return `# ${page.title}\n\n${page.body.trim()}\n`
}

function slugIsSafe(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)
}

export class MemoryStore {
  constructor(readonly root: string) {}

  private storeDir(key: string): string {
    return join(this.root, 'stores', key)
  }

  dreamDir(id: string): string {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`invalid dream id: ${id}`)
    return join(this.root, 'dreams', id)
  }

  async head(key: string): Promise<number> {
    const text = await readText(join(this.storeDir(key), 'HEAD'))
    const value = text === undefined ? 0 : Number.parseInt(text.trim(), 10)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  async versions(key: string): Promise<number[]> {
    let names: string[]
    try {
      names = await readdir(join(this.storeDir(key), 'versions'))
    } catch {
      return []
    }
    return names.map((name) => /^v(\d{4,})$/.exec(name)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b)
  }

  async readVersion(key: string, version: number): Promise<MemorySnapshot> {
    if (version === 0) return EMPTY_SNAPSHOT
    return readJson<MemorySnapshot>(join(this.storeDir(key), 'versions', versionDir(version), 'snapshot.json'), EMPTY_SNAPSHOT)
  }

  async current(key: string): Promise<{ version: number; snapshot: MemorySnapshot }> {
    const version = await this.head(key)
    return { version, snapshot: await this.readVersion(key, version) }
  }

  /** Every store that has been written, with its workspace path. */
  async stores(): Promise<StoreRef[]> {
    let names: string[]
    try {
      names = await readdir(join(this.root, 'stores'))
    } catch {
      return []
    }
    const refs = await Promise.all(names.map((name) => readJson<StoreRef | undefined>(join(this.storeDir(name), 'store.json'), undefined)))
    return refs.filter((ref): ref is StoreRef => ref !== undefined)
  }

  /** Write a snapshot and its human-readable files into `dir`. */
  async writeSnapshotDir(dir: string, snapshot: MemorySnapshot): Promise<void> {
    await ensureDir(dir)
    await writeJson(join(dir, 'snapshot.json'), snapshot)
    await writePrivate(join(dir, 'injected.md'), renderInjected(snapshot))
    for (const page of snapshot.wiki) {
      if (!slugIsSafe(page.slug)) continue
      await writePrivate(join(dir, 'wiki', `${page.slug}.md`), renderWikiPage(page))
    }
    const index = snapshot.wiki.map((page) => `- [${page.title}](${page.slug}.md)`).join('\n')
    await writePrivate(join(dir, 'wiki', 'index.md'), `# Memory wiki\n\n${index}\n`)
  }

  // ---- dreams ----

  async createDream(store: StoreRef, instructions: string | undefined): Promise<DreamRecord> {
    const now = new Date().toISOString()
    const record: DreamRecord = {
      id: `d-${randomUUID().slice(0, 8)}`,
      store,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      baseVersion: await this.head(store.key),
      sessions: [],
      progress: 'queued',
      ...(instructions === undefined || instructions === '' ? {} : { instructions }),
    }
    await this.saveDream(record)
    return record
  }

  async saveDream(record: DreamRecord): Promise<void> {
    record.updatedAt = new Date().toISOString()
    await writeJson(join(this.dreamDir(record.id), 'dream.json'), record)
  }

  async readDream(id: string): Promise<DreamRecord | undefined> {
    return readJson<DreamRecord | undefined>(join(this.dreamDir(id), 'dream.json'), undefined)
  }

  /** All dreams, newest first. */
  async listDreams(): Promise<DreamRecord[]> {
    let names: string[]
    try {
      names = await readdir(join(this.root, 'dreams'))
    } catch {
      return []
    }
    const records = await Promise.all(names.filter((name) => /^[a-z0-9-]{1,64}$/.test(name)).map((name) => this.readDream(name)))
    return records.filter((record): record is DreamRecord => record !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async readStaged(id: string): Promise<MemorySnapshot | undefined> {
    return readJson<MemorySnapshot | undefined>(join(this.dreamDir(id), 'staged', 'snapshot.json'), undefined)
  }

  async writeStaged(id: string, snapshot: MemorySnapshot): Promise<void> {
    const dir = join(this.dreamDir(id), 'staged')
    await rm(dir, { recursive: true, force: true })
    await this.writeSnapshotDir(dir, snapshot)
  }

  async readDiff(id: string): Promise<string | undefined> {
    return readText(join(this.dreamDir(id), 'diff.md'))
  }

  async writeDiff(id: string, text: string): Promise<void> {
    await writePrivate(join(this.dreamDir(id), 'diff.md'), text)
  }

  async writeQuarantine(id: string, lines: unknown[]): Promise<void> {
    await writePrivate(join(this.dreamDir(id), 'quarantine.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : ''))
  }

  async readCheckpoint<T>(id: string, key: string): Promise<T | undefined> {
    return readJson<T | undefined>(join(this.dreamDir(id), 'checkpoints', `${key}.json`), undefined)
  }

  async writeCheckpoint(id: string, key: string, value: unknown): Promise<void> {
    await writeJson(join(this.dreamDir(id), 'checkpoints', `${key}.json`), value)
  }

  // ---- ledger ----

  private ledgerPath(): string {
    return join(this.root, 'ledger.json')
  }

  async ledger(key: string): Promise<Record<string, LedgerEntry>> {
    const ledger = await readJson<Ledger>(this.ledgerPath(), {})
    return ledger[key] ?? {}
  }

  private async recordLedger(record: DreamRecord, outcome: DreamOutcome): Promise<void> {
    const ledger = await readJson<Ledger>(this.ledgerPath(), {})
    const entries = ledger[record.store.key] ?? {}
    for (const session of record.sessions) {
      const previous = entries[session.sessionId]
      if (previous !== undefined && previous.throughSeq >= session.throughSeq) continue
      entries[session.sessionId] = { throughSeq: session.throughSeq, dreamId: record.id, outcome }
    }
    ledger[record.store.key] = entries
    await writeJson(this.ledgerPath(), ledger)
  }

  // ---- review ----

  /**
   * Make a completed dream's staged output the store's next version.
   * @throws when the dream is not completed, was already settled, or the
   *   store moved on since the dream started (dream again on the new HEAD).
   */
  async apply(id: string): Promise<number> {
    const record = await this.readDream(id)
    if (record === undefined) throw new Error(`no dream ${id}`)
    if (record.outcome !== undefined) throw new Error(`dream ${id} was already ${record.outcome}`)
    if (record.status !== 'completed') throw new Error(`dream ${id} is ${record.status}; only a completed dream can be applied`)
    const head = await this.head(record.store.key)
    if (head !== record.baseVersion) throw new Error(`memory changed since dream ${id} started (it was based on v${record.baseVersion}, the store is at v${head}); discard it and dream again`)
    const staged = join(this.dreamDir(id), 'staged')
    if (await this.readStaged(id) === undefined) throw new Error(`dream ${id} has no staged output`)
    const dir = this.storeDir(record.store.key)
    await ensureDir(join(dir, 'versions'))
    await writeJson(join(dir, 'store.json'), record.store)
    const versions = await this.versions(record.store.key)
    const next = Math.max(head, ...versions) + 1
    await rename(staged, join(dir, 'versions', versionDir(next)))
    await writePrivate(join(dir, 'HEAD'), `${next}\n`)
    record.outcome = 'applied'
    record.appliedVersion = next
    await this.saveDream(record)
    await this.recordLedger(record, 'applied')
    await this.prune(record.store.key, next)
    return next
  }

  /** Settle a dream without changing memory. Its sessions count as dreamed. */
  async discard(id: string): Promise<void> {
    const record = await this.readDream(id)
    if (record === undefined) throw new Error(`no dream ${id}`)
    if (record.outcome !== undefined) throw new Error(`dream ${id} was already ${record.outcome}`)
    if (record.status === 'pending' || record.status === 'running') throw new Error(`dream ${id} is still ${record.status}; cancel it first`)
    record.outcome = 'discarded'
    await this.saveDream(record)
    await rm(join(this.dreamDir(id), 'staged'), { recursive: true, force: true })
    if (record.status === 'completed') await this.recordLedger(record, 'discarded')
  }

  /** Point HEAD at an earlier kept version (default: the one before HEAD). */
  async rollback(key: string, version?: number): Promise<number> {
    const head = await this.head(key)
    const versions = await this.versions(key)
    const target = version ?? [0, ...versions].filter((n) => n < head).pop()
    if (target === undefined) throw new Error('there is no earlier version to roll back to')
    if (target !== 0 && !versions.includes(target)) throw new Error(`version v${target} is not kept`)
    if (target === head) throw new Error(`the store is already at v${target}`)
    await writePrivate(join(this.storeDir(key), 'HEAD'), `${target}\n`)
    return target
  }

  private async prune(key: string, head: number): Promise<void> {
    const versions = await this.versions(key)
    const excess = versions.filter((n) => n !== head).slice(0, Math.max(0, versions.length - KEPT_VERSIONS))
    for (const n of excess) await rm(join(this.storeDir(key), 'versions', versionDir(n)), { recursive: true, force: true })
  }
}
