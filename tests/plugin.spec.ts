import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { storeFor } from '../src/store.ts'
import { ev, FakeLlm, FakeSessions, session, tempRoot } from './support/fakes.ts'

type Handler = (invocation: { rawInput: string; agent?: { id: unknown } }) => Promise<{ kind: string; text: string }>

function fakeContext(services: Record<string, unknown>) {
  const tools = new Map<string, { execute: (args: unknown, exec: object) => Promise<{ text: string }> }>()
  const disposers: Array<() => void> = []
  let command: Handler | undefined
  let context: ((c: { agent?: unknown }) => string) | undefined
  const ctx = {
    get: (name: string) => services[name],
    effect: (fn: () => () => void) => { disposers.push(fn()) },
    tools: { register: (tool: { name: string; execute: never }) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  }
  services.commands = { register: (definition: { handler: Handler }) => { command = definition.handler; return () => { command = undefined } } }
  services.systemPrompt = { context: (entry: { text: typeof context }) => { context = entry.text; return () => { context = undefined } } }
  return { ctx, tools, disposers, command: () => command as Handler, context: () => context as NonNullable<typeof context> }
}

beforeEach(() => ev.reset())

describe('the plugin', () => {
  it('mounts tools, the /dream command and the memory context, and runs a full review cycle', async () => {
    const root = await tempRoot()
    const sessions = new FakeSessions([
      session('s-now', '/w', 9, [ev.user('current conversation')]),
      session('s-old', '/w', 1, [ev.user('Write commit messages in the imperative.')]),
    ])
    const llm = new FakeLlm((pass, user) => {
      if (pass === 'extract') return { candidates: [...user.matchAll(/^#(\d+) \[USER\] (.*)$/gm)].map((m) => ({ text: m[2], kind: 'preference', seqs: [Number(m[1])] })) }
      if (pass === 'consolidate') return { ops: [{ op: 'add', text: 'Write commit messages in the imperative.', kind: 'preference', candidates: ['c1'] }] }
      if (pass === 'wiki') return { pages: [] }
      return { injected: [...user.matchAll(/"id":"(n-[a-z0-9]+)"/g)].map((m) => m[1]) }
    })
    const fake = fakeContext({ sessionQuery: sessions, llm, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })
    const config = (plugin.Config as unknown as (value: unknown) => plugin.ResolvedConfig)({ root, auto: { enabled: false } })
    expect(config.auto).toEqual({ enabled: false, intervalHours: 24, apply: true, startDelayMinutes: 10, retryAfterMinutes: 60 })
    await plugin.apply(fake.ctx as never, config)
    expect([...fake.tools.keys()].sort()).toEqual(['dream_diff', 'dream_report', 'dream_run', 'dream_status', 'memory_read', 'memory_search'])

    const exec = { agent: { id: 's-now', session: { header: { cwd: '/w' } } } }
    const started = await fake.tools.get('dream_run')?.execute({}, exec)
    const id = /Dream (d-[a-z0-9]+)/.exec(started?.text ?? '')?.[1] as string
    expect(id).toBeDefined()
    for (let i = 0; i < 100 && /\[(pending|running)/.test((await fake.tools.get('dream_status')?.execute({ id }, exec))?.text ?? ''); i++) await new Promise((r) => setTimeout(r, 10))
    expect((await fake.tools.get('dream_status')?.execute({ id }, exec))?.text).toContain('[completed]')
    // The conversation that started the dream is not read.
    expect(llm.calls.filter((c) => c.pass === 'extract').every((c) => !c.user.includes('current conversation'))).toBe(true)

    const agent = { agent: { id: 's-now' } }
    expect((await fake.command()({ rawInput: `diff ${id}`, ...agent })).text).toContain('Write commit messages in the imperative.')
    expect(fake.context()({ agent: { session: { header: { cwd: '/w' } } } })).toBe('')
    expect((await fake.command()({ rawInput: `apply ${id}`, ...agent })).text).toContain('is now v1')
    expect(fake.context()({ agent: { session: { header: { cwd: '/w' } } } })).toContain('Write commit messages in the imperative.')
    expect(fake.context()({ agent: { session: { header: { cwd: '/w', origin: 'subagent' } } } })).toBe('')
    expect(fake.context()({})).toBe('')

    expect((await fake.tools.get('memory_search')?.execute({ query: 'commit imperative' }, exec))?.text).toContain('stated by the user')
    expect((await fake.command()({ rawInput: 'rollback', ...agent })).text).toContain('back at v0')
    expect(fake.context()({ agent: { session: { header: { cwd: '/w' } } } })).toBe('')
    expect((await fake.command()({ rawInput: 'bogus', ...agent })).kind).toBe('error')
    expect(storeFor('/w').key).toMatch(/^ws-[0-9a-f]{12}$/)
  })

  it('ships a patch and manifest DSH can load', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { keywords: string[]; dsh: { bundle: { patch: string } } }
    expect(manifest.keywords).toContain('dsh-plugin')
    const patch = await readFile(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8')
    expect(patch).toContain("name: '@natgurlain/dsh-dreaming'")
    expect(plugin.name).toBe('dreaming')
  })
})
