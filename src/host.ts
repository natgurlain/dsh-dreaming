/**
 * Host integrations: the skill provider for approved skills, the desktop
 * notification, and the activity check for idle-time dreaming.
 *
 * @module @natgurlain/dsh-dreaming/host
 */

import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { storeFor, type MemoryStore } from './store.ts'

/** The slice of `ctx.skills` used here (same shape the browser agent uses). */
export interface SkillsServiceLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => {
    name: string
    list: (options: { cwd?: string | undefined }) => Promise<readonly unknown[]>
    get: (candidate: { locator: unknown }, options: { cwd?: string | undefined }) => Promise<unknown>
  }): () => void
}

/** Skill rank: after project skills, before user skills. */
const SKILL_RANK = 360
const PROVIDER = 'dsh-dreaming'

/**
 * Offer the approved skills of the looked-up workspace (and global ones).
 * Staged and rejected skills are never offered.
 */
export function registerSkillProvider(skills: SkillsServiceLike, store: MemoryStore): { dispose: () => void; invalidate: () => void } {
  let invalidate = (): void => {}
  const keys = (cwd: string | undefined): string[] => ['global', ...(cwd !== undefined && isAbsolute(cwd) ? [storeFor(cwd).key] : [])]
  const dispose = skills.registerProvider((control) => {
    invalidate = control.invalidate
    return {
      name: PROVIDER,
      list: async ({ cwd }) => {
        const candidates = []
        for (const key of keys(cwd)) {
          for (const skill of await store.skills(key, 'approved')) {
            candidates.push({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse,
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'runtime',
              provider: PROVIDER,
              rank: SKILL_RANK,
              locator: { key, name: skill.name },
            })
          }
        }
        return candidates
      },
      get: async (candidate, { cwd }) => {
        const locator = candidate.locator as { key?: unknown; name?: unknown }
        if (typeof locator.key !== 'string' || typeof locator.name !== 'string') return undefined
        // A lookup from another workspace never reads this one's skills.
        if (!keys(cwd).includes(locator.key)) return undefined
        const content = await store.readSkill(locator.key, 'approved', locator.name).catch(() => undefined)
        if (content === undefined) return undefined
        const { rank: _rank, locator: _locator, ...summary } = candidate as Record<string, unknown>
        return { ...summary, content }
      },
    }
  })
  return { dispose, invalidate: () => { invalidate() } }
}

/** Show a desktop notification (macOS or Linux); text goes in as an argument, never through a shell. */
export function notifyDesktop(title: string, message: string): void {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message], { timeout: 10_000 }, () => undefined)
  } else if (process.platform === 'linux') {
    execFile('notify-send', ['--app-name=DSH', title, message], { timeout: 10_000 }, () => undefined)
  }
}

/**
 * When the user last did anything in DSH: the newest modification time of a
 * session log under `sessionsDir`. Reads directory entries and file times
 * only, never the logs themselves.
 */
export async function lastActivity(sessionsDir: string): Promise<number | undefined> {
  let newest: number | undefined
  let workspaces: string[]
  try {
    workspaces = await readdir(sessionsDir)
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    let sessions: string[]
    try {
      sessions = await readdir(join(sessionsDir, workspace))
    } catch {
      continue
    }
    for (const session of sessions) {
      let files: string[]
      try {
        files = await readdir(join(sessionsDir, workspace, session))
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.startsWith('session.')) continue
        const info = await stat(join(sessionsDir, workspace, session, file)).catch(() => undefined)
        if (info !== undefined && (newest === undefined || info.mtimeMs > newest)) newest = info.mtimeMs
      }
    }
  }
  return newest
}
