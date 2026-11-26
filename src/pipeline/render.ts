/**
 * Turn a DSH session log into the transcript a dream reads.
 *
 * Kept: the user's own messages (`[USER]`), assistant text (`[AGENT]`),
 * tool calls as `name(args)` and tool results cut short inside
 * `<untrusted>` (`[TOOL]`). Dropped: injected context (instructions,
 * snapshots, notices), system and developer messages, reasoning.
 *
 * A session is tainted when it called a tool that reads content from outside
 * the user's control (browser, web fetch/search, MCP, computer use). The
 * taint is derived from the log itself, so it survives restarts and does not
 * depend on any other plugin. With `taintPolicy: 'user-only'` a tainted
 * session contributes only the user's own messages.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/render
 */

import { redact } from './redact.ts'

/** Tool names that read untrusted content. */
export const TAINTING_TOOL = /^(browser_|web_fetch$|web_search$|fetch$|mcp__|computer|WebFetch$|WebSearch$)/

export const MAX_TOOL_ARGS_CHARS = 200
export const MAX_TOOL_RESULT_CHARS = 500
export const MAX_MESSAGE_CHARS = 4_000

export type TaintPolicy = 'user-only' | 'exclude' | 'include'

/** One rendered transcript line. */
export interface TranscriptLine {
  seq: number
  speaker: 'user' | 'agent' | 'tool'
  text: string
}

export interface RenderedSession {
  sessionId: string
  tainted: boolean
  /** Highest seq in the log, whether or not it was rendered. */
  throughSeq: number
  lines: TranscriptLine[]
}

/** The slice of a DSH session event read here. */
export interface EventLike {
  type: string
  seq: number
  data?: unknown
}

interface ContentBlockLike { type?: unknown; text?: unknown }
interface MessageLike { content?: unknown; source?: { kind?: unknown }; form?: unknown }

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ContentBlockLike[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Whether the log called a tool that reads untrusted content. */
export function isTainted(events: readonly EventLike[]): boolean {
  return events.some((event) => event.type === 'tool/call' && TAINTING_TOOL.test(String((event.data as { name?: unknown } | undefined)?.name ?? '')))
}

/**
 * Render events with seq greater than `afterSeq`.
 * @returns undefined when the policy excludes the session entirely.
 */
export function renderSession(sessionId: string, events: readonly EventLike[], options: { afterSeq?: number; taintPolicy: TaintPolicy }): RenderedSession | undefined {
  const tainted = isTainted(events)
  if (tainted && options.taintPolicy === 'exclude') return undefined
  const userOnly = tainted && options.taintPolicy === 'user-only'
  const afterSeq = options.afterSeq ?? -1
  const throughSeq = events.reduce((max, event) => Math.max(max, event.seq), -1)
  const lines: TranscriptLine[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.type === 'user/message') {
      const message = event.data as MessageLike | undefined
      // Injected context (instructions, snapshots, notices, recalls) carries a form; only the user's own typing has none.
      if (message?.source?.kind !== 'user' || message.form !== undefined) continue
      const text = textOf(message.content)
      if (text !== '') lines.push({ seq: event.seq, speaker: 'user', text: redact(clip(text, MAX_MESSAGE_CHARS)) })
    } else if (userOnly) {
      continue
    } else if (event.type === 'assistant/message') {
      const text = textOf((event.data as { message?: MessageLike } | undefined)?.message?.content)
      if (text !== '') lines.push({ seq: event.seq, speaker: 'agent', text: redact(clip(text, MAX_MESSAGE_CHARS)) })
    } else if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; arguments?: unknown } | undefined
      const name = String(data?.name ?? 'tool')
      lines.push({ seq: event.seq, speaker: 'agent', text: redact(`called ${name}(${clip(String(data?.arguments ?? ''), MAX_TOOL_ARGS_CHARS)})`) })
    } else if (event.type === 'tool/result') {
      const data = event.data as { message?: MessageLike; error?: { code?: unknown } } | undefined
      const text = textOf(data?.message?.content)
      const prefix = data?.error === undefined ? 'result' : `error ${String(data.error.code ?? '')}`.trim()
      lines.push({ seq: event.seq, speaker: 'tool', text: `${prefix}: <untrusted>${redact(clip(text, MAX_TOOL_RESULT_CHARS))}</untrusted>` })
    }
  }
  return { sessionId, tainted, throughSeq, lines }
}

/** Split a rendered session into chunks of at most `maxChars`, on line boundaries. */
export function chunkLines(lines: readonly TranscriptLine[], maxChars: number): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = []
  let current: TranscriptLine[] = []
  let size = 0
  for (const line of lines) {
    const length = formatLine(line).length + 1
    if (current.length > 0 && size + length > maxChars) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(line.text.length > maxChars ? { ...line, text: clip(line.text, maxChars - 32) } : line)
    size += length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function formatLine(line: TranscriptLine): string {
  return `#${line.seq} [${line.speaker.toUpperCase()}] ${line.text}`
}
