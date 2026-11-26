/**
 * Read Claude Code and Codex transcripts as if they were DSH sessions, so a
 * dream can learn from every agent the user works with. Off by default.
 *
 * Each transcript becomes a session with an id prefixed `claude-code:` or
 * `codex:` and the working directory it ran in, so it lands in the same
 * workspace memory as DSH sessions in that directory. Only the user's own
 * typing becomes `user/message` (injected context, command output and tool
 * results never do); tool calls keep their names so web and MCP use taints
 * the session exactly like a DSH one.
 *
 * @module @natgurlain/dsh-dreaming/import
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventLike } from './pipeline/render.ts'
import type { SessionHeaderLike, SessionQueryLike } from './pipeline/run.ts'

/** Largest transcript read (bytes). */
export const MAX_TRANSCRIPT_BYTES = 40 * 1024 * 1024

export interface ImportSettings {
  claudeCode: boolean
  codex: boolean
  /** Only transcripts changed within this many days. */
  days: number
  claudeHome: string
  codexHome: string
}

interface Transcript { header: SessionHeaderLike; file: string; version: string; parse: (text: string) => EventLike[] }

/** How long the list of transcripts is reused before the folders are scanned again. */
const LIST_TTL_MS = 10 * 60_000

const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

/** Bytes read from the start of a transcript to learn its id, start and directory. */
const HEADER_BYTES = 256 * 1024

/** Injected context, command echoes, reminders and harness stubs are not the user's typing. */
function isTyped(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== ''
    && !trimmed.startsWith('<')
    && !trimmed.startsWith('Caveat:')
    && !trimmed.startsWith('[Request interrupted')
    && !trimmed.startsWith('This session is being continued')
    && !trimmed.startsWith('# AGENTS.md')
    && !/<(system-reminder|INSTRUCTIONS|environment_context|user_instructions)>/.test(trimmed)
}

/**
 * Whether a Claude Code `user` record is something the person typed. Newer
 * records say so (`origin.kind: "human"`); compaction summaries, meta
 * records and transcript-only records never are.
 */
function isHumanRecord(record: Record<string, unknown>): boolean {
  if (record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true || record.isMeta === true) return false
  const origin = record.origin as { kind?: unknown } | undefined
  return origin === undefined || origin.kind === 'human'
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. */
export function parseClaudeCode(raw: string): EventLike[] {
  const events: EventLike[] = []
  raw.split('\n').forEach((line, index) => {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (record.isSidechain === true) return
    const human = record.type === 'user' && isHumanRecord(record)
    const message = record.message as { content?: unknown } | undefined
    const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : 0
    const blocks = typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : []
    blocks.forEach((block, part) => {
      const seq = index * 100 + part
      if (human && block.type === 'text' && typeof block.text === 'string' && isTyped(block.text)) {
        events.push({ type: 'user/message', seq, data: { role: 'user', source: { kind: 'user' }, content: text(block.text) }, time } as EventLike)
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const content = Array.isArray(block.content) ? (block.content as Array<{ text?: unknown }>).map((item) => typeof item.text === 'string' ? item.text : '').join('\n') : stringify(block.content)
        events.push({ type: 'tool/result', seq, data: { message: { role: 'tool', content: text(content) } } })
      } else if (record.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
        events.push({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: text(block.text) } } })
      } else if (record.type === 'assistant' && block.type === 'tool_use') {
        events.push({ type: 'tool/call', seq, data: { name: String(block.name ?? 'tool'), arguments: stringify(block.input) } })
      }
    })
  })
  return events
}

/** Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export function parseCodex(raw: string): EventLike[] {
  const events: EventLike[] = []
  raw.split('\n').forEach((line, index) => {
    let record: { type?: unknown; payload?: Record<string, unknown> }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      return
    }
    const payload = record.payload
    if (record.type !== 'response_item' || payload === undefined) return
    const seq = index * 100
    if (payload.type === 'message') {
      const content = Array.isArray(payload.content) ? (payload.content as Array<{ text?: unknown }>).map((item) => typeof item.text === 'string' ? item.text : '').join('\n') : ''
      if (payload.role === 'user' && isTyped(content)) events.push({ type: 'user/message', seq, data: { role: 'user', source: { kind: 'user' }, content: text(content) } })
      else if (payload.role === 'assistant' && content.trim() !== '') events.push({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: text(content) } } })
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      events.push({ type: 'tool/call', seq, data: { name: String(payload.name ?? 'tool'), arguments: stringify(payload.arguments ?? payload.input) } })
    } else if (payload.type === 'web_search_call') {
      events.push({ type: 'tool/call', seq, data: { name: 'web_search', arguments: stringify(payload.action) } })
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      events.push({ type: 'tool/result', seq, data: { message: { role: 'tool', content: text(stringify(payload.output)) } } })
    }
  })
  return events
}

async function recentFiles(dir: string, depth: number, since: number, match: (name: string) => boolean): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) files.push(...await recentFiles(path, depth - 1, since, match))
    else if (entry.isFile() && match(entry.name)) {
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && info.mtimeMs >= since && info.size <= MAX_TRANSCRIPT_BYTES) files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
    }
  }
  return files
}

/** Read just enough of a transcript to learn its id, start and working directory. */
async function headerOf(file: string, kind: 'claude-code' | 'codex', mtimeMs: number): Promise<SessionHeaderLike | undefined> {
  let raw = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
      raw = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  let cwd: string | undefined
  let id: string | undefined
  let created: number | undefined
  for (const line of raw.split('\n').slice(0, 400)) {
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (kind === 'claude-code') {
      if (cwd === undefined && typeof record.cwd === 'string') cwd = record.cwd
      if (id === undefined && typeof record.sessionId === 'string') id = record.sessionId
      if (created === undefined && typeof record.timestamp === 'string') created = Date.parse(record.timestamp)
    } else if (record.type === 'session_meta') {
      const payload = record.payload as { cwd?: unknown; id?: unknown; timestamp?: unknown } | undefined
      if (typeof payload?.cwd === 'string') cwd = payload.cwd
      if (typeof payload?.id === 'string') id = payload.id
      if (typeof payload?.timestamp === 'string') created = Date.parse(payload.timestamp)
    }
    if (cwd !== undefined && id !== undefined && created !== undefined) break
  }
  id ??= file.split('/').pop()?.replace(/\.jsonl$/, '')
  if (id === undefined || cwd === undefined) return undefined
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return undefined
  return { id: `${kind}:${id}`, cwd, createdAt: Number.isFinite(created) ? created as number : mtimeMs }
}

/** Transcripts from Claude Code and Codex, as a session query. */
export class TranscriptSessions implements SessionQueryLike {
  private cache: { at: number; transcripts: Transcript[] } | undefined
  /** Headers by file version (path, mtime, size): a file is only re-read when it changes. */
  private readonly headers = new Map<string, SessionHeaderLike | undefined>()
  /** Last event seq by file version. */
  private readonly lastSeqs = new Map<string, number>()

  constructor(private readonly settings: ImportSettings) {}

  private async scan(kind: 'claude-code' | 'codex', files: Array<{ path: string; mtimeMs: number; size: number }>, parse: (text: string) => EventLike[]): Promise<Transcript[]> {
    const found: Transcript[] = []
    for (const file of files) {
      const version = `${file.path}:${file.mtimeMs}:${file.size}`
      if (!this.headers.has(version)) this.headers.set(version, await headerOf(file.path, kind, file.mtimeMs))
      const header = this.headers.get(version)
      if (header !== undefined) found.push({ header, file: file.path, version, parse })
    }
    return found
  }

  private async transcripts(): Promise<Transcript[]> {
    if (this.cache !== undefined && Date.now() - this.cache.at < LIST_TTL_MS) return this.cache.transcripts
    const since = Date.now() - this.settings.days * 86_400_000
    const transcripts: Transcript[] = []
    if (this.settings.claudeCode) transcripts.push(...await this.scan('claude-code', await recentFiles(join(this.settings.claudeHome, 'projects'), 1, since, (name) => name.endsWith('.jsonl')), parseClaudeCode))
    if (this.settings.codex) transcripts.push(...await this.scan('codex', await recentFiles(join(this.settings.codexHome, 'sessions'), 4, since, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl')), parseCodex))
    this.cache = { at: Date.now(), transcripts }
    return transcripts
  }

  /** The last event seq of an imported session, re-parsing only a changed file. */
  async lastSeq(sessionId: string): Promise<number | undefined> {
    const transcript = (await this.transcripts()).find((entry) => entry.header.id === sessionId)
    if (transcript === undefined) return undefined
    if (!this.lastSeqs.has(transcript.version)) {
      const events = transcript.parse(await readFile(transcript.file, 'utf8'))
      this.lastSeqs.set(transcript.version, events.reduce((max, event) => Math.max(max, event.seq), -1))
    }
    return this.lastSeqs.get(transcript.version)
  }

  async listSessions(): Promise<Array<{ header: SessionHeaderLike }>> {
    return (await this.transcripts()).map((transcript) => ({ header: transcript.header }))
  }

  async filterSessions(filters: ReadonlyArray<{ kind: string; values?: readonly unknown[] }>): Promise<Array<{ header: SessionHeaderLike }>> {
    return (await this.listSessions()).filter(({ header }) => filters.every((filter) => {
      if (filter.kind === 'cwd') return filter.values?.includes(header.cwd) ?? false
      if (filter.kind === 'id') return filter.values?.includes(header.id) ?? false
      return true
    }))
  }

  async readSession(sessionId: string): Promise<{ session: SessionHeaderLike; events: EventLike[] }> {
    const transcript = (await this.transcripts()).find((entry) => entry.header.id === sessionId)
    if (transcript === undefined) throw new Error(`no imported session ${sessionId}`)
    const events = transcript.parse(await readFile(transcript.file, 'utf8'))
    this.lastSeqs.set(transcript.version, events.reduce((max, event) => Math.max(max, event.seq), -1))
    return { session: transcript.header, events }
  }
}

/** DSH sessions plus imported transcripts; ids say which source answers. */
export class CombinedSessions implements SessionQueryLike {
  constructor(private readonly dsh: SessionQueryLike, private readonly imported: TranscriptSessions) {}

  private isImported(id: string): boolean {
    return id.startsWith('claude-code:') || id.startsWith('codex:')
  }

  async listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeaderLike; live?: boolean }>> {
    return [...await this.dsh.listSessions(signal), ...await this.imported.listSessions()]
  }

  async filterSessions(filters: ReadonlyArray<{ kind: string; values?: readonly unknown[]; from?: number; to?: number }>, signal?: AbortSignal): Promise<Array<{ header: SessionHeaderLike }>> {
    const ids = filters.find((filter) => filter.kind === 'id')?.values as readonly string[] | undefined
    const dshFilters = ids === undefined ? filters : filters.map((filter) => filter.kind === 'id' ? { ...filter, values: ids.filter((id) => !this.isImported(id)) } : filter)
    const fromDsh = ids !== undefined && ids.every((id) => this.isImported(id)) ? [] : await this.dsh.filterSessions(dshFilters, signal)
    // A lookup of DSH ids only (every /dream command does one) never scans the transcript folders.
    if (ids !== undefined && !ids.some((id) => this.isImported(id))) return fromDsh
    return [...fromDsh, ...await this.imported.filterSessions(filters)]
  }

  async readSession(sessionId: string): Promise<{ session: SessionHeaderLike; events: EventLike[] }> {
    return this.isImported(sessionId) ? this.imported.readSession(sessionId) : this.dsh.readSession(sessionId)
  }

  /** Cheap last-seq for imported sessions; DSH sessions fall back to a read. */
  async lastSeq(sessionId: string): Promise<number | undefined> {
    return this.isImported(sessionId) ? this.imported.lastSeq(sessionId) : undefined
  }

  listEvents(sessionId: string): Promise<Array<{ time: number }>> {
    const dsh = this.dsh as SessionQueryLike & { listEvents?: (id: string) => Promise<Array<{ time: number }>> }
    return dsh.listEvents?.(sessionId) ?? Promise.resolve([])
  }
}
