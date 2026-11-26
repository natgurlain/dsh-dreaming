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
 * /dream skills                skills drafted for this workspace
 * /dream skills show <name>    read a skill
 * /dream skills approve <name> let sessions use it
 * /dream skills reject <name>  drop it (it is not drafted again)
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
  /** Tell DSH the approved skills changed. */
  invalidateSkills?: () => void
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
        const { version, snapshot } = await host.dreamer.memory(storeFor(cwd).key)
        const injected = renderInjected(snapshot)
        return ok(`${cwd ?? 'Global memory'} v${version}: ${snapshot.notes.length} notes, ${snapshot.wiki.length} wiki pages.\n${injected === '' ? 'Nothing is loaded into every session.' : injected}`)
      }
      case 'report':
        return ok(await host.auto?.latestReport() ?? 'No automatic dream has run yet. Start one with /dream now.')
      case 'now': {
        if (host.auto === undefined) return { kind: 'error', text: 'Automatic dreaming is not set up.' }
        // Never await the run here: a command holds the conversation until it returns.
        if (host.auto.busy) return ok('A dream run is already in progress. Keep working; see /dream status for progress and /dream report when it finishes.')
        void host.auto.runNow()
        return ok('Dreaming started in the background for every workspace with new sessions. Keep working; see /dream status for progress and /dream report when it finishes.')
      }
      case 'skills': {
        const [action, name] = rest
        const key = storeFor(await host.cwdOf(sessionId)).key
        if (action === undefined || action === 'list') {
          const all = [...await host.store.skills(key), ...(key === 'global' ? [] : await host.store.skills('global'))]
          if (all.length === 0) return ok('No skills drafted yet. A dream drafts skills from procedures you repeat; they wait here for review.')
          const order = { staged: 0, approved: 1, rejected: 2 }
          return ok(all.sort((a, b) => order[a.state] - order[b.state]).map((skill) => `${skill.state === 'staged' ? 'needs review' : skill.state}: ${skill.name}: ${skill.description}`).join('\n') + '\n\nRead one with /dream skills show <name>; approve or reject it.')
        }
        if (name === undefined) return { kind: 'error', text: `Usage: /dream skills ${action} <name>` }
        const found = [...await host.store.skills(key), ...(key === 'global' ? [] : await host.store.skills('global'))].find((skill) => skill.name === name)
        if (found === undefined) return { kind: 'error', text: `No skill named ${name} for this workspace.` }
        const owner = (await host.store.skills(key)).some((skill) => skill.name === name) ? key : 'global'
        if (action === 'show') return ok(`[${found.state}]\n${await host.store.readSkill(owner, found.state, name) ?? ''}`)
        if (action === 'approve' || action === 'reject') {
          const to = action === 'approve' ? 'approved' : 'rejected'
          if (found.state === to) return ok(`${name} is already ${to}.`)
          await host.store.moveSkill(owner, name, found.state, to)
          host.invalidateSkills?.()
          return ok(action === 'approve' ? `Approved ${name}: new sessions in this workspace can use it.` : `Rejected ${name}; it will not be drafted again.`)
        }
        return { kind: 'error', text: 'Usage: /dream skills [list | show <name> | approve <name> | reject <name>]' }
      }
      default:
        return { kind: 'error', text: 'Usage: /dream [status | report | now | skills | run [global] [focus] | diff <id> | apply <id> | discard <id> | cancel <id> | rollback [global] [version] | memory [global]]' }
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
    input: { hint: 'report | now | skills | status | run | diff <id> | apply <id> | discard <id> | rollback' },
    handler: async (invocation) => runCommand(host, invocation.rawInput, invocation.agent === undefined ? undefined : String(invocation.agent.id)),
  })
}
