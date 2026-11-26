import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AutoDreamer, type AutoSettings } from '../src/auto.ts'
import { Dreamer } from '../src/dreamer.ts'
import type { DreamSettings } from '../src/pipeline/run.ts'
import { MemoryStore, storeFor } from '../src/store.ts'
import { ev, FakeLlm, FakeSessions, session, tempRoot, type Pass } from './support/fakes.ts'

const SETTINGS: DreamSettings = {
  maxSessions: 20, taintPolicy: 'user-only', injectedMaxBytes: 2048, chunkChars: 60_000, candidatesPerCall: 150,
  budget: { maxCalls: 60, maxInputChars: 1_600_000, maxMinutes: 5 }, callTimeoutMs: 10_000,
}
const AUTO: AutoSettings = { enabled: true, intervalHours: 24, apply: true, startDelayMs: 0, checkEveryMs: 60_000 }

const lines = (block: string): Array<Record<string, unknown>> => block.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)
function model(pass: Pass, user: string): unknown {
  if (pass === 'extract') return { candidates: [...user.matchAll(/^#(\d+) \[USER\] (.*)$/gm)].filter((m) => /prefer|always/i.test(m[2] ?? '')).map((m) => ({ text: m[2], kind: 'preference', seqs: [Number(m[1])] })) }
  if (pass === 'consolidate') return { ops: lines(user.split('New candidates')[1] ?? '').map((c) => ({ op: 'add', text: c.text, kind: c.kind, candidates: [c.id] })) }
  if (pass === 'wiki') return { pages: [] }
  return { injected: lines(user).map((n) => n.id) }
}

let store: MemoryStore
let sessions: FakeSessions
let llm: FakeLlm
let auto: AutoDreamer
let dreamer: Dreamer

beforeEach(async () => {
  ev.reset()
  store = new MemoryStore(await tempRoot())
  sessions = new FakeSessions([
    session('a1', '/repo/a', 1, [ev.user('Always run the linter before committing.')]),
    session('b1', '/repo/b', 2, [ev.user('What time is it?')]),
    session('sub', '/repo/c', 3, [ev.user('I prefer subagent noise.')], 'subagent'),
  ])
  llm = new FakeLlm(model)
  dreamer = new Dreamer({ store, settings: SETTINGS, sessions: () => sessions, llm: () => llm, model: () => ({ provider: 'p', model: 'm' }) })
  await dreamer.init()
  auto = new AutoDreamer(dreamer, store, () => sessions, AUTO)
})

describe('automatic dreaming', () => {
  it('dreams every workspace, applies changes and writes a report', async () => {
    const result = await auto.tick()
    expect(result?.dreams.map((d) => [d.record.store.cwd, d.note])).toEqual([
      ['/repo/a', 'applied as v1'],
      ['/repo/b', 'read new sessions; nothing worth remembering'],
    ])
    expect(dreamer.contextFor('/repo/a')).toContain('Always run the linter before committing.')
    expect(await store.head(storeFor('/repo/b').key)).toBe(0)
    const report = await readFile(join(store.root, 'reports', 'latest.md'), 'utf8')
    expect(report).toContain('# Dream report')
    expect(report).toContain('**/repo/a**: applied as v1')
    expect(report).toContain('Always run the linter before committing.')
    expect(report).not.toContain('subagent noise')
    expect(await auto.latestReport()).toBe(report)
  })

  it('waits for the interval, then only reads what is new', async () => {
    await auto.tick()
    const calls = llm.calls.length
    expect(await auto.tick()).toBeUndefined()
    const again = await auto.runNow()
    expect(llm.calls.length).toBe(calls)
    expect(again?.report).toContain('No workspace had new sessions')
  })

  it('leaves dreams for review when apply is off', async () => {
    const manual = new AutoDreamer(dreamer, store, () => sessions, { ...AUTO, apply: false })
    const result = await manual.runNow()
    expect(result?.dreams[0]?.note).toMatch(/^waiting for review: \/dream apply d-/)
    expect(await store.head(storeFor('/repo/a').key)).toBe(0)
  })
})
