/**
 * Model-facing tools. They start dreams and read memory; none of them can
 * change memory. Applying, discarding and rolling back are `/dream`
 * commands, which only the user can type.
 *
 * @module @natgurlain/dsh-dreaming/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Dreamer } from './dreamer.ts'
import { storeFor, type MemoryStore } from './store.ts'
import type { DreamRecord, MemorySnapshot, Note, StoreRef } from './types.ts'

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
} as const

/** How a tool call finds its session and working directory. */
export interface CallerLookup {
  sessionId(exec: object): string | undefined
  cwd(exec: object): Promise<string | undefined>
}

export function describeDream(record: DreamRecord): string {
  const scope = record.store.cwd === undefined ? 'global' : record.store.cwd
  const parts = [`${record.id} [${record.status}${record.outcome === undefined ? '' : `, ${record.outcome}${record.appliedVersion === undefined ? '' : ` as v${record.appliedVersion}`}`}] ${scope}: ${record.progress}`]
  if (record.stats !== undefined) parts.push(`${record.sessions.length} sessions, ${record.stats.candidates} candidates, +${record.stats.added} ~${record.stats.updated} merged ${record.stats.merged} -${record.stats.dropped}, ${record.stats.llmCalls} model calls`)
  if (record.truncated) parts.push('partial: budget ran out')
  if (record.error !== undefined) parts.push(`error: ${record.error}`)
  return parts.join('; ')
}

function noteLine(note: Note, store: string): string {
  return `[${note.id}] (${store}; ${note.kind}; ${note.trust === 'user' ? 'stated by the user' : 'inferred'}; last confirmed ${note.lastConfirmed.slice(0, 10)}) ${note.text}`
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1)
}

function score(text: string, words: readonly string[]): number {
  const lower = text.toLowerCase()
  return words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0)
}

export function registerTools(register: (tool: ToolDefinition) => () => void, dreamer: Dreamer, store: MemoryStore, caller: CallerLookup): Array<() => void> {
  const scopeOf = async (exec: object, scope: unknown): Promise<StoreRef> => {
    if (scope === 'global') return storeFor(undefined)
    const cwd = await caller.cwd(exec)
    if (cwd === undefined) throw new Error('this session has no working directory; use scope "global"')
    return storeFor(cwd)
  }
  const readable = async (exec: object): Promise<Array<{ label: string; snapshot: MemorySnapshot }>> => {
    const cwd = await caller.cwd(exec)
    const refs = [storeFor(undefined), ...(cwd === undefined ? [] : [storeFor(cwd)])]
    return Promise.all(refs.map(async (ref) => ({ label: ref.cwd === undefined ? 'global' : 'workspace', snapshot: (await store.current(ref.key)).snapshot })))
  }

  const tools: ToolDefinition[] = [
    defineTool({
      name: 'dream_run',
      description: 'Start a dream: in the background, review recent past sessions and propose an updated long-term memory (notes, a wiki, and the few notes loaded into every session). It never changes memory by itself; the user reviews the result and applies it with /dream apply <id>. Returns the dream id at once. Use only when the user asks to dream or consolidate memory.',
      parameters: {
        scope: { type: 'string', enum: ['workspace', 'global'], description: 'workspace (default): sessions in this working directory. global: all sessions.' },
        instructions: { type: 'string', description: 'Optional focus for the dream, in the user\'s words.' },
        session_ids: { type: 'array', items: { type: 'string' }, description: 'Dream only these sessions.' },
        force: { type: 'boolean', description: 'Re-read sessions an earlier dream already covered.' },
      },
      timeoutMs: 30_000,
      output: TEXT_OUTPUT,
      execute: async (args, exec) => {
        const a = args as { scope?: string; instructions?: string; session_ids?: string[]; force?: boolean }
        const ref = await scopeOf(exec, a.scope)
        const excluded = caller.sessionId(exec)
        const record = await dreamer.start(ref, {
          ...(a.instructions === undefined ? {} : { instructions: a.instructions }),
          ...(a.session_ids === undefined ? {} : { sessionIds: a.session_ids }),
          ...(excluded === undefined ? {} : { excludeSessionId: excluded }),
          ...(a.force === true ? { force: true } : {}),
        })
        return { text: `Dream ${record.id} started for ${ref.cwd ?? 'global memory'}. It runs in the background; check it with dream_status. When it completes, the user reviews it with /dream diff ${record.id} and applies it with /dream apply ${record.id}.` }
      },
    }),
    defineTool({
      name: 'dream_status',
      description: 'Show recent dreams, or one dream by id: status, progress and what it changed.',
      parameters: { id: { type: 'string', description: 'A dream id; omit to list recent dreams.' } },
      timeoutMs: 10_000,
      output: TEXT_OUTPUT,
      execute: async (args) => {
        const id = (args as { id?: string }).id
        if (id !== undefined) {
          const record = await store.readDream(id)
          return { text: record === undefined ? `No dream ${id}.` : describeDream(record) }
        }
        const records = (await store.listDreams()).slice(0, 10)
        return { text: records.length === 0 ? 'No dreams yet.' : records.map(describeDream).join('\n') }
      },
    }),
    defineTool({
      name: 'dream_diff',
      description: 'Show what a completed dream would change in memory.',
      parameters: { id: { type: 'string', required: true, description: 'The dream id.' } },
      timeoutMs: 10_000,
      output: TEXT_OUTPUT,
      execute: async (args) => {
        const id = (args as { id: string }).id
        const diff = await store.readDiff(id)
        return { text: diff ?? `Dream ${id} has no diff yet; check dream_status.` }
      },
    }),
    defineTool({
      name: 'memory_search',
      description: 'Search long-term memory from past sessions (global and this workspace): notes and wiki pages. Memory can be stale; check anything important before relying on it.',
      parameters: { query: { type: 'string', required: true, description: 'Words to look for.' } },
      timeoutMs: 10_000,
      output: TEXT_OUTPUT,
      execute: async (args, exec) => {
        const words = terms((args as { query: string }).query)
        if (words.length === 0) return { text: 'Give a query with at least one word.' }
        const hits: Array<{ score: number; line: string }> = []
        for (const { label, snapshot } of await readable(exec)) {
          for (const note of snapshot.notes) {
            const s = score(note.text, words)
            if (s > 0) hits.push({ score: s + 0.5, line: noteLine(note, label) })
          }
          for (const page of snapshot.wiki) {
            const s = score(`${page.title} ${page.body}`, words)
            if (s > 0) hits.push({ score: s, line: `[wiki:${page.slug}] (${label}) ${page.title}` })
          }
        }
        hits.sort((a, b) => b.score - a.score)
        return { text: hits.length === 0 ? 'Nothing in memory matches.' : hits.slice(0, 20).map((hit) => hit.line).join('\n') }
      },
    }),
    defineTool({
      name: 'memory_read',
      description: 'Read one memory note (with the sessions it came from) or one wiki page. Use ids from memory_search: n-… for a note, wiki:<slug> for a page, or "index" for the list of pages.',
      parameters: { id: { type: 'string', required: true, description: 'n-<id>, wiki:<slug>, or index.' } },
      timeoutMs: 10_000,
      output: TEXT_OUTPUT,
      execute: async (args, exec) => {
        const id = (args as { id: string }).id.trim()
        const stores = await readable(exec)
        if (id === 'index') {
          const lines = stores.flatMap(({ label, snapshot }) => snapshot.wiki.map((page) => `wiki:${page.slug} (${label}) ${page.title}`))
          return { text: lines.length === 0 ? 'The memory wiki is empty.' : lines.join('\n') }
        }
        for (const { label, snapshot } of stores) {
          if (id.startsWith('wiki:')) {
            const page = snapshot.wiki.find((entry) => entry.slug === id.slice(5))
            if (page !== undefined) return { text: `# ${page.title} (${label})\n\n${page.body}` }
          } else {
            const note = snapshot.notes.find((entry) => entry.id === id)
            if (note !== undefined) return { text: `${noteLine(note, label)}\nSources: ${note.sources.map((source) => `${source.sessionId} #${source.seqs.join(',#')}${source.tainted ? ' (session read web or tool content)' : ''}`).join('; ')}` }
          }
        }
        return { text: `Nothing in memory has the id ${id}.` }
      },
    }),
  ]
  return tools.map((tool) => register(tool))
}
