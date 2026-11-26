/**
 * `@natgurlain/dsh-dreaming`: dreaming for DeepSeek Harness.
 *
 * Between conversations a dream reads recent sessions and proposes an
 * updated long-term memory, in the four layers Anthropic describes for
 * Claude Managed Agents: transcripts (DSH's session history, read through
 * `ctx.sessionQuery`), notes, a wiki, and a small block loaded into every
 * session (a `ctx.systemPrompt` context). A dream only stages a new version;
 * the user reviews it and applies it with `/dream apply`.
 *
 * @module @natgurlain/dsh-dreaming
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { registerCommand, type CommandRegistryLike } from './command.ts'
import { AutoDreamer } from './auto.ts'
import { Dreamer } from './dreamer.ts'
import { isLlmLike, type ModelChoice } from './llm.ts'
import { MemoryStore } from './store.ts'
import { registerTools } from './tools.ts'
import { lastActivity, notifyDesktop, registerSkillProvider, type SkillsServiceLike } from './host.ts'
import { CombinedSessions, TranscriptSessions } from './import.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionQueryLike } from './pipeline/run.ts'
import type { TaintPolicy } from './pipeline/render.ts'

export { MemoryStore, storeFor, renderInjected } from './store.ts'
export { Dreamer } from './dreamer.ts'
export { AutoDreamer } from './auto.ts'
export { runDream } from './pipeline/run.ts'
export { replay } from './replay.ts'
export type * from './types.ts'

export const name = 'dreaming'
export const inject = ['tools']

export interface Config {
  maxSessionsPerDream?: number
  injectedMaxBytes?: number
  taintPolicy?: TaintPolicy
  model?: string
  maxModelCalls?: number
  maxInputChars?: number
  maxMinutes?: number
  callTimeoutMs?: number
  chunkChars?: number
  candidatesPerCall?: number
  injectMemory?: boolean
  root?: string
  auto?: { enabled?: boolean; intervalHours?: number; apply?: boolean; startDelayMinutes?: number; retryAfterMinutes?: number; idleMinutes?: number; global?: boolean; notify?: boolean }
  skills?: boolean
  import?: { claudeCode?: boolean; codex?: boolean; days?: number; claudeHome?: string; codexHome?: string }
}

export type ResolvedConfig = Required<Omit<Config, 'model' | 'root' | 'auto' | 'import'>> & Pick<Config, 'model' | 'root'> & {
  auto: Required<NonNullable<Config['auto']>>
  import: Required<Omit<NonNullable<Config['import']>, 'claudeHome' | 'codexHome'>> & Pick<NonNullable<Config['import']>, 'claudeHome' | 'codexHome'>
}

export const Config: z<Config, ResolvedConfig> = z.object({
  maxSessionsPerDream: z.number().step(1).min(1).max(100).default(20).description('Most sessions one dream reads.'),
  injectedMaxBytes: z.number().step(1).min(0).max(4096).default(2048).description('Size cap of the memory loaded into every session.'),
  taintPolicy: z.union(['user-only', 'exclude', 'include']).default('user-only').description('Sessions that read web pages or tool content: keep only what the user typed, skip them, or read them fully.'),
  model: z.string().description('provider/model for dreaming; defaults to the DSH default model.'),
  maxModelCalls: z.number().step(1).min(1).default(60),
  maxInputChars: z.number().step(1).min(10_000).default(1_600_000),
  maxMinutes: z.number().min(1).default(30),
  callTimeoutMs: z.number().step(1).min(1_000).default(180_000),
  chunkChars: z.number().step(1).min(4_000).default(60_000),
  candidatesPerCall: z.number().step(1).min(10).default(150),
  injectMemory: z.boolean().default(true).description('Load applied memory into every new session.'),
  root: z.string().description('Where memory is kept; defaults to ~/.dsh/dreaming.'),
  auto: z.object({
    enabled: z.boolean().default(true).description('Dream automatically in the background.'),
    intervalHours: z.number().min(1).default(24).description('Hours between automatic dreams.'),
    apply: z.boolean().default(true).description('Apply automatic dreams without review; /dream report shows what changed.'),
    startDelayMinutes: z.number().min(0).default(10).description('Wait after DSH starts before the first check.'),
    retryAfterMinutes: z.number().min(5).default(60).description('When a workspace fails (for example the model is busy), try again this soon.'),
    idleMinutes: z.number().min(0).default(20).description('Dream only after no session activity for this long (0: do not wait).'),
    global: z.boolean().default(true).description('Promote preferences stated in two or more workspaces to global memory.'),
    notify: z.boolean().default(true).description('Show a desktop notification when a report has news.'),
  }).default({ enabled: true, intervalHours: 24, apply: true, startDelayMinutes: 10, retryAfterMinutes: 60, idleMinutes: 20, global: true, notify: true }),
  skills: z.boolean().default(true).description('Draft skills from recurring procedures; they wait for /dream skills approve.'),
  import: z.object({
    claudeCode: z.boolean().default(false).description('Also dream Claude Code transcripts (~/.claude/projects).'),
    codex: z.boolean().default(false).description('Also dream Codex transcripts (~/.codex/sessions).'),
    days: z.number().min(1).default(14).description('Only transcripts changed in this many days.'),
    claudeHome: z.string().description('Defaults to ~/.claude.'),
    codexHome: z.string().description('Defaults to ~/.codex.'),
  }).default({ claudeCode: false, codex: false, days: 14 }),
}) as unknown as z<Config, ResolvedConfig>

interface AgentLike { id?: unknown; session?: { header?: { cwd?: string; origin?: string } } }

function parseModel(value: string | undefined): ModelChoice | undefined {
  if (value === undefined || value === '') return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error(`dreaming: model must be "provider/model", got "${value}"`)
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

export async function apply(ctx: Context, config: ResolvedConfig): Promise<void> {
  const store = new MemoryStore(config.root ?? dshHomePath('dreaming'))
  const configured = parseModel(config.model)
  const dshSessions = (): SessionQueryLike | undefined => ctx.get('sessionQuery' as never) as SessionQueryLike | undefined
  const imported = config.import.claudeCode || config.import.codex
    ? new TranscriptSessions({
      claudeCode: config.import.claudeCode,
      codex: config.import.codex,
      days: config.import.days,
      claudeHome: config.import.claudeHome ?? join(homedir(), '.claude'),
      codexHome: config.import.codexHome ?? join(homedir(), '.codex'),
    })
    : undefined
  const sessions = (): SessionQueryLike | undefined => {
    const dsh = dshSessions()
    if (dsh === undefined) return undefined
    return imported === undefined ? dsh : new CombinedSessions(dsh, imported)
  }
  const dreamer = new Dreamer({
    store,
    settings: {
      maxSessions: config.maxSessionsPerDream,
      taintPolicy: config.taintPolicy,
      injectedMaxBytes: config.injectedMaxBytes,
      chunkChars: config.chunkChars,
      candidatesPerCall: config.candidatesPerCall,
      budget: { maxCalls: config.maxModelCalls, maxInputChars: config.maxInputChars, maxMinutes: config.maxMinutes },
      callTimeoutMs: config.callTimeoutMs,
      skills: config.skills,
    },
    sessions,
    llm: () => {
      const llm = ctx.get('llm' as never) as unknown
      return isLlmLike(llm) ? llm : undefined
    },
    model: () => {
      if (configured !== undefined) return configured
      const selection = (ctx.get('agentDefaultModel' as never) as { currentSelection?: () => { provider?: string; model?: string } } | undefined)?.currentSelection?.()
      return selection?.provider !== undefined && selection.model !== undefined ? { provider: selection.provider, model: selection.model } : undefined
    },
  })
  await dreamer.init()
  ctx.effect(() => () => { void dreamer.stop() }, 'dreaming: running dreams')

  const auto = new AutoDreamer(dreamer, store, sessions, {
    enabled: config.auto.enabled,
    intervalHours: config.auto.intervalHours,
    retryAfterMinutes: config.auto.retryAfterMinutes,
    apply: config.auto.apply,
    startDelayMs: config.auto.startDelayMinutes * 60_000,
    checkEveryMs: 15 * 60_000,
    idleMinutes: config.auto.idleMinutes,
    global: config.auto.global,
    notify: config.auto.notify,
  }, {
    lastActivity: () => lastActivity(dshHomePath('sessions')),
    notify: notifyDesktop,
    log: (message) => {
      try {
        ctx.logger('dreaming').warn(message)
      } catch {
        console.warn(`[dreaming] ${message}`)
      }
    },
  })
  ctx.effect(() => {
    auto.start()
    return () => { void auto.stop() }
  }, 'dreaming: automatic dreams')

  const cwdOf = async (sessionId: string | undefined): Promise<string | undefined> => {
    if (sessionId === undefined) return undefined
    const found = await sessions()?.filterSessions([{ kind: 'id', values: [sessionId] }])
    return found?.[0]?.header.cwd
  }
  const caller = {
    sessionId: (exec: object): string | undefined => {
      const agent = (exec as { agent?: AgentLike }).agent
      return agent?.id === undefined ? undefined : String(agent.id)
    },
    cwd: async (exec: object): Promise<string | undefined> => {
      const agent = (exec as { agent?: AgentLike }).agent
      return agent?.session?.header?.cwd ?? cwdOf(agent?.id === undefined ? undefined : String(agent.id))
    },
  }

  ctx.effect(() => {
    const disposers = registerTools((tool: ToolDefinition) => ctx.tools.register(tool), dreamer, store, caller, auto)
    return () => { for (const dispose of disposers) dispose() }
  }, 'dreaming: tools')

  const skillService = ctx.get('skills' as never) as SkillsServiceLike | undefined
  let invalidateSkills = (): void => {}
  if (config.skills && typeof skillService?.registerProvider === 'function') {
    ctx.effect(() => {
      const provider = registerSkillProvider(skillService, store)
      invalidateSkills = provider.invalidate
      return provider.dispose
    }, 'dreaming: skill provider')
  }

  const commands = ctx.get('commands' as never) as CommandRegistryLike | undefined
  if (commands !== undefined) {
    ctx.effect(() => registerCommand(commands, { dreamer, store, cwdOf, auto, invalidateSkills: () => invalidateSkills() }) ?? (() => undefined), 'dreaming: /dream command')
  }

  const systemPrompt = ctx.get('systemPrompt' as never) as { context(entry: { name: string; order: number; interpolate: boolean; text: (context: { agent?: AgentLike }) => string }): () => void } | undefined
  if (config.injectMemory && systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.context({
      name: 'dreaming:memory',
      order: 300,
      interpolate: false,
      text: (context) => {
        const header = context.agent?.session?.header
        if (context.agent === undefined || header?.origin === 'subagent') return ''
        return dreamer.contextFor(header?.cwd)
      },
    }), 'dreaming: memory context')
  }
}
