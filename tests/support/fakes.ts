import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmLike } from '../../src/llm.ts'
import type { EventLike } from '../../src/pipeline/render.ts'
import type { SessionHeaderLike, SessionQueryLike } from '../../src/pipeline/run.ts'
import { CONSOLIDATE_SYSTEM, EXTRACT_SYSTEM, PROMOTE_SYSTEM, TIDY_SYSTEM, WIKI_SYSTEM } from '../../src/pipeline/prompts.ts'
import { SKILL_SYSTEM } from '../../src/pipeline/skills.ts'
import { GLOBAL_SYSTEM } from '../../src/pipeline/global.ts'

export async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-dreaming-'))
}

export type Pass = 'extract' | 'consolidate' | 'wiki' | 'promote' | 'tidy' | 'skills' | 'global'

const SYSTEMS: Record<string, Pass> = { [EXTRACT_SYSTEM]: 'extract', [CONSOLIDATE_SYSTEM]: 'consolidate', [WIKI_SYSTEM]: 'wiki', [PROMOTE_SYSTEM]: 'promote', [TIDY_SYSTEM]: 'tidy', [SKILL_SYSTEM]: 'skills', [GLOBAL_SYSTEM]: 'global' }
/** Answers for the passes a test does not care about: change nothing. */
const NEUTRAL: Partial<Record<Pass, unknown>> = { tidy: { ops: [] }, skills: { skills: [] }, global: { groups: [] } }

/** A model that answers each pass with a handler, and counts calls. */
export class FakeLlm implements LlmLike {
  calls: Array<{ pass: Pass; user: string }> = []

  /** `answer` handles the main passes; `extra` the tidy, skill and global passes (neutral by default). */
  constructor(private readonly answer: (pass: Pass, user: string) => unknown, private readonly extra?: (pass: Pass, user: string) => unknown) {}

  async *stream(options: { system: string; messages: Array<{ content: Array<{ text: string }> }>; signal?: AbortSignal }): AsyncIterable<unknown> {
    const pass = SYSTEMS[options.system]
    if (pass === undefined) throw new Error('unknown pass')
    const user = options.messages[0]?.content[0]?.text ?? ''
    this.calls.push({ pass, user })
    options.signal?.throwIfAborted()
    const value = pass in NEUTRAL ? this.extra?.(pass, user) ?? NEUTRAL[pass] : this.answer(pass, user)
    yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  count(pass: Pass): number {
    return this.calls.filter((call) => call.pass === pass).length
  }
}

export interface FakeSession {
  header: SessionHeaderLike
  events: EventLike[]
}

export class FakeSessions implements SessionQueryLike {
  constructor(public sessions: FakeSession[]) {}

  async listSessions(): Promise<Array<{ header: SessionHeaderLike }>> {
    return this.sessions.map((session) => ({ header: session.header }))
  }

  async filterSessions(filters: ReadonlyArray<{ kind: string; values?: readonly unknown[] }>): Promise<Array<{ header: SessionHeaderLike }>> {
    return this.sessions.filter((session) => filters.every((filter) => {
      if (filter.kind === 'cwd') return filter.values?.includes(session.header.cwd) ?? false
      if (filter.kind === 'id') return filter.values?.includes(session.header.id) ?? false
      return true
    })).map((session) => ({ header: session.header }))
  }

  async readSession(sessionId: string): Promise<{ session: SessionHeaderLike; events: EventLike[] }> {
    const session = this.sessions.find((entry) => entry.header.id === sessionId)
    if (session === undefined) throw new Error(`no session ${sessionId}`)
    return { session: session.header, events: session.events }
  }
}

let seq = 0
const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

export const ev = {
  reset(): void { seq = 0 },
  user(value: string, kind = 'user'): EventLike { return { type: 'user/message', seq: seq++, data: { role: 'user', id: `m${seq}`, source: { kind }, content: text(value) } } },
  agent(value: string): EventLike { return { type: 'assistant/message', seq: seq++, data: { turn: 1, step: 1, message: { role: 'assistant', content: text(value), source: { kind: 'model' } } } } },
  call(name: string, args = '{}'): EventLike { return { type: 'tool/call', seq: seq++, data: { turn: 1, step: 1, callId: `c${seq}`, name, arguments: args } } },
  result(value: string): EventLike { return { type: 'tool/result', seq: seq++, data: { turn: 1, step: 1, message: { role: 'tool', content: text(value), source: { kind: 'tool' } } } } },
}

export function session(id: string, cwd: string, createdAt: number, events: EventLike[], origin?: string): FakeSession {
  return { header: { id, cwd, createdAt, ...(origin === undefined ? {} : { origin }) }, events }
}
