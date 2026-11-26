/**
 * `/dream`: the user's controls. Applying, discarding and rolling back live
 * here, not in tools, so only something the user typed can change memory.
 *
 * ```
 * /dream                       recent dreams
 * /dream run [global] [focus…] start a dream (workspace by default)
 * /dream diff <id>             what a dream would change
 * /dream apply <id>            make it the current memory
 * /dream discard <id>          drop it
 * /dream cancel <id>           stop a running dream
 * /dream rollback [global] [v] go back one version (or to version v)
 * /dream memory [global]       what every session currently loads
 * /dream report                the latest automatic dream report
 * /dream now                   run the automatic dream now
 * ```
 *
 * @module @natgurlain/dsh-dreaming/command
 */

import type { AutoDreamer } from './auto.ts'
import type { Dreamer } from './dreamer.ts'
import { renderInjected, storeFor, type MemoryStore } from './store.ts'
import { describeDream } from './tools.ts'

export const COMMAND_NAME = 'dream'

type Result = { kind: 'success' | 'error'; text: string }

/** The slice of `ctx.commands` used here. */
export interface CommandRegistryLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { rawInput: string; agent?: { id: unknown } }) => Promise<Result>
  }): () => void
}

export interface CommandHost {
  dreamer: Dreamer
  store: MemoryStore
  auto?: AutoDreamer
  cwdOf(sessionId: string | undefined): Promise<string | undefined>
}

export async function runCommand(host: CommandHost, rawInput: string, sessionId: string | undefined): Promise<Result> {
  const words = rawInput.trim().split(/\s+/).filter((word) => word !== '')
  const [sub = 'status', ...rest] = words
  const ok = (text: string): Result => ({ kind: 'success', text })
  try {
    switch (sub) {
      case 'status':
      case 'list': {
        const records = (await host.store.listDreams()).slice(0, 10)
        return ok(records.length === 0 ? 'No dreams yet. Start one with /dream run.' : records.map(describeDream).join('\n'))
      }
      case 'run': {
        const global = rest[0] === 'global'
        const focus = (global ? rest.slice(1) : rest).join(' ')
        const cwd = global ? undefined : await host.cwdOf(sessionId)
        if (!global && cwd === undefined) return { kind: 'error', text: 'This conversation has no working directory; use /dream run global.' }
        const record = await host.dreamer.start(storeFor(cwd), {
          ...(focus === '' ? {} : { instructions: focus }),
          ...(sessionId === undefined ? {} : { excludeSessionId: sessionId }),
        })
        return ok(`Dream ${record.id} started for ${cwd ?? 'global memory'}. Check it with /dream status; review it with /dream diff ${record.id}.`)
      }
      case 'diff': {
        const id = need(rest[0], 'diff')
        return ok(await host.store.readDiff(id) ?? `Dream ${id} has no diff yet.`)
      }
      case 'apply': {
        const { record, version } = await host.dreamer.apply(need(rest[0], 'apply'))
        return ok(`Applied ${record.id}: ${record.store.cwd ?? 'global memory'} is now v${version}. New sessions load the updated memory; /dream rollback undoes this.`)
      }
      case 'discard': {
        const id = need(rest[0], 'discard')
        await host.store.discard(id)
        return ok(`Discarded ${id}. Its sessions will not be dreamed again unless you pass force.`)
      }
      case 'cancel': {
        const id = need(rest[0], 'cancel')
        return host.dreamer.cancel(id) ? ok(`Canceling ${id}.`) : { kind: 'error', text: `${id} is not running.` }
      }
      case 'rollback': {
        const global = rest[0] === 'global'
        const versionWord = global ? rest[1] : rest[0]
        const version = versionWord === undefined ? undefined : Number.parseInt(versionWord.replace(/^v/, ''), 10)
        if (version !== undefined && !Number.isSafeInteger(version)) return { kind: 'error', text: 'Give the version as a number, like /dream rollback 3.' }
        const cwd = global ? undefined : await host.cwdOf(sessionId)
        const target = await host.dreamer.rollback(storeFor(cwd), version)
        return ok(`${cwd ?? 'Global memory'} is back at v${target}.`)
      }
      case 'memory': {
        const cwd = rest[0] === 'global' ? undefined : await host.cwdOf(sessionId)
        const { version, snapshot } = await host.store.current(storeFor(cwd).key)
        const injected = renderInjected(snapshot)
        return ok(`${cwd ?? 'Global memory'} v${version}: ${snapshot.notes.length} notes, ${snapshot.wiki.length} wiki pages.\n${injected === '' ? 'Nothing is loaded into every session.' : injected}`)
      }
      case 'report':
        return ok(await host.auto?.latestReport() ?? 'No automatic dream has run yet. Start one with /dream now.')
      case 'now': {
        if (host.auto === undefined) return { kind: 'error', text: 'Automatic dreaming is not set up.' }
        const result = await host.auto.runNow()
        return ok(result?.report ?? 'The automatic dream could not run; check /dream status.')
      }
      default:
        return { kind: 'error', text: 'Usage: /dream [status | report | now | run [global] [focus] | diff <id> | apply <id> | discard <id> | cancel <id> | rollback [global] [version] | memory [global]]' }
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

function need(id: string | undefined, sub: string): string {
  if (id === undefined) throw new Error(`Usage: /dream ${sub} <dream id>`)
  return id
}

export function registerCommand(commands: CommandRegistryLike | undefined, host: CommandHost): (() => void) | undefined {
  if (typeof commands?.register !== 'function') return undefined
  return commands.register({
    name: COMMAND_NAME,
    description: 'Review and apply dreams: consolidated memory from past sessions',
    input: { hint: 'report | now | status | run | diff <id> | apply <id> | discard <id> | rollback' },
    handler: async (invocation) => runCommand(host, invocation.rawInput, invocation.agent === undefined ? undefined : String(invocation.agent.id)),
  })
}
