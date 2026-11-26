import { readFile, writeFile } from 'node:fs/promises'
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
const AUTO: AutoSettings = { enabled: true, intervalHours: 24, retryAfterMinutes: 60, apply: true, startDelayMs: 0, checkEveryMs: 60_000, idleMinutes: 0, global: false, notify: false }

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

describe('temporary model errors', () => {
  const busy = (inner: FakeLlm, failures: { left: number }) => ({
    async *stream(options: Parameters<FakeLlm['stream']>[0]): AsyncIterable<unknown> {
      if (failures.left > 0) {
        failures.left -= 1
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '503: {"message":"Loading model","type":"unavailable_error","code":503}' } } }
        return
      }
      yield* inner.stream(options)
    },
  })

  it('retries a busy model and then succeeds', async () => {
    const failures = { left: 2 }
    const retrying = new Dreamer({ store, settings: { ...SETTINGS, retryDelaysMs: [0, 0, 0] }, sessions: () => sessions, llm: () => busy(llm, failures), model: () => ({ provider: 'p', model: 'm' }) })
    const record = await retrying.start(storeFor('/repo/a'), {})
    const settled = await retrying.settled(record.id)
    expect(settled?.status).toBe('completed')
    expect(settled?.stats?.retries).toBe(2)
  })

  it('tries failed workspaces again soon instead of tomorrow', async () => {
    const failing = new Dreamer({ store, settings: { ...SETTINGS, retryDelaysMs: [0] }, sessions: () => sessions, llm: () => busy(llm, { left: 99 }), model: () => ({ provider: 'p', model: 'm' }) })
    const first = await new AutoDreamer(failing, store, () => sessions, AUTO).runNow()
    expect(first?.dreams.every((d) => d.record.status === 'failed')).toBe(true)
    expect(first?.report).toMatch(/2 failed; the next try is at \d\d:\d\d UTC/)
    const state = JSON.parse(await readFile(join(store.root, 'auto.json'), 'utf8')) as { nextRunAt: string }
    const wait = Date.parse(state.nextRunAt) - Date.now()
    expect(wait).toBeGreaterThan(55 * 60_000)
    expect(wait).toBeLessThan(61 * 60_000)

    // When the retry is due and the model is back, the failed sessions are read again.
    await writeFile(join(store.root, 'auto.json'), JSON.stringify({ ...state, nextRunAt: new Date(Date.now() - 1000).toISOString() }))
    const second = await auto.tick()
    expect(second?.dreams.find((d) => d.record.store.cwd === '/repo/a')?.note).toBe('applied as v1')
  })

  it('treats a failed run from before retries existed as due after the retry delay', async () => {
    const failing = new Dreamer({ store, settings: { ...SETTINGS, retryDelaysMs: [] }, sessions: () => sessions, llm: () => busy(llm, { left: 99 }), model: () => ({ provider: 'p', model: 'm' }) })
    await new AutoDreamer(failing, store, () => sessions, AUTO).runNow()
    const lastRunAt = new Date(Date.now() - 61 * 60_000).toISOString()
    await writeFile(join(store.root, 'auto.json'), JSON.stringify({ lastRunAt }))
    for (const record of await store.listDreams()) { record.createdAt = new Date(Date.now() - 60 * 60_000).toISOString(); await store.saveDream(record) }
    expect(await auto.tick()).toBeDefined()
  })
})

describe('/dream now', () => {
  it('returns at once instead of holding the conversation for the whole run', async () => {
    const { runCommand } = await import('../src/command.ts')
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = { async *stream(options: Parameters<FakeLlm['stream']>[0]): AsyncIterable<unknown> { await gate; yield* llm.stream(options) } }
    const slowDreamer = new Dreamer({ store, settings: SETTINGS, sessions: () => sessions, llm: () => slow, model: () => ({ provider: 'p', model: 'm' }) })
    const slowAuto = new AutoDreamer(slowDreamer, store, () => sessions, AUTO)
    const host = { dreamer: slowDreamer, store, auto: slowAuto, cwdOf: async () => '/repo/a' }
    const first = await runCommand(host, 'now', 's1')
    expect(first.text).toMatch(/started in the background/)
    expect(slowAuto.busy).toBe(true)
    expect((await runCommand(host, 'now', 's1')).text).toMatch(/already in progress/)
    release()
    await slowAuto.runNow()
    expect(slowAuto.busy).toBe(false)
  })
})
