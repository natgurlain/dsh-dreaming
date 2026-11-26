/**
 * The skill pass: turn procedure notes into SKILL.md drafts.
 *
 * A skill carries more authority than a note (it is a set of instructions the
 * agent follows), so drafts are never applied automatically: they land in the
 * store's review queue and become skills only after `/dream skills approve`.
 * Only procedures whose every source session was untainted are drafted, and
 * each draft passes the same lint and redaction as notes.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/skills
 */

import type { Note } from '../types.ts'
import { lintNoteText } from './consolidate.ts'
import { redact } from './redact.ts'

export const MAX_SKILLS_PER_DREAM = 3
export const MAX_SKILL_BODY = 6_000

export interface SkillDraft {
  name: string
  description: string
  whenToUse: string
  body: string
  /** Note ids the skill was drafted from. */
  notes: string[]
  createdAt: string
  dreamId: string
}

export type SkillState = 'staged' | 'approved' | 'rejected'

/**
 * Procedure notes that may become skills: from untainted sessions only, never
 * one already drafted (following merges through `supersedes`, so a rejected
 * skill is not drafted again under a new note id), and only procedures that
 * are new or gained evidence in this dream, so a quiet dream costs no call.
 */
export function skillSources(notes: readonly Note[], alreadyDrafted: ReadonlySet<string>, base: readonly Note[] = []): Note[] {
  const before = new Map(base.map((note) => [note.id, note]))
  return notes.filter((note) => note.kind === 'procedure'
    && !alreadyDrafted.has(note.id)
    && !(note.supersedes ?? []).some((id) => alreadyDrafted.has(id))
    && note.sources.length > 0
    && note.sources.every((source) => source.tainted !== true)
    && JSON.stringify(before.get(note.id)?.sources) !== JSON.stringify(note.sources))
}

export const SKILL_SYSTEM = `You turn an agent's remembered procedures into reusable skills. A skill is a short markdown guide the agent loads when a task matches: when to use it, the steps, common pitfalls, and how to check the result.

Write a skill only for a procedure that is a real recurring task with concrete steps; skip facts, one-off details and anything that is really a single rule. Use only what the notes say; do not invent commands, paths or steps. At most ${MAX_SKILLS_PER_DREAM} skills.

Each skill: a lowercase kebab-case name (letters, digits, dashes, at most 48 characters), a one-sentence description, a one-sentence "when to use", a markdown body under ${MAX_SKILL_BODY} characters with the sections "## Steps", "## Pitfalls" and "## Check", and the ids of the notes it comes from.

Reply with only this JSON object: {"skills":[{"name":"...","description":"...","whenToUse":"...","body":"...","notes":["n-..."]}]}`

export function skillPrompt(procedures: readonly Note[], related: readonly Note[]): string {
  const line = (note: Note): string => JSON.stringify({ id: note.id, kind: note.kind, text: note.text })
  return `Procedures:\n${procedures.map(line).join('\n')}\n\nRelated notes (context only):\n${related.map(line).join('\n') || '(none)'}`
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/

/** Validate drafts in code: names, sizes, citations, lint, redaction. */
export function parseSkills(value: unknown, procedures: readonly Note[], taken: ReadonlySet<string>, meta: { now: string; dreamId: string }): SkillDraft[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { skills?: unknown }).skills)) throw new Error('expected {"skills":[...]}')
  const known = new Set(procedures.map((note) => note.id))
  const drafts: SkillDraft[] = []
  for (const raw of (value as { skills: unknown[] }).skills) {
    if (drafts.length >= MAX_SKILLS_PER_DREAM) break
    const skill = raw as Record<string, unknown>
    const name = typeof skill.name === 'string' ? skill.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) : ''
    if (!SLUG.test(name) || taken.has(name) || drafts.some((draft) => draft.name === name)) continue
    const notes = Array.isArray(skill.notes) ? skill.notes.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
    if (notes.length === 0) continue
    const text = (field: unknown, max: number): string => typeof field === 'string' ? redact(field.trim()).slice(0, max) : ''
    const description = text(skill.description, 300)
    const whenToUse = text(skill.whenToUse, 300)
    const body = text(skill.body, MAX_SKILL_BODY)
    if (description === '' || body === '') continue
    if ([description, whenToUse, body].some((part) => lintNoteText(part.replace(/\s+/g, ' '), 'inferred') !== undefined && part !== '')) continue
    drafts.push({ name, description, whenToUse, body, notes, createdAt: meta.now, dreamId: meta.dreamId })
  }
  return drafts
}

/** The SKILL.md file for a draft. */
export function renderSkill(draft: SkillDraft): string {
  const yaml = (value: string): string => JSON.stringify(value.replace(/\s+/g, ' '))
  return [
    '---',
    `name: ${draft.name}`,
    `description: ${yaml(draft.description)}`,
    `when_to_use: ${yaml(draft.whenToUse)}`,
    `source: dsh-dreaming (notes ${draft.notes.join(', ')})`,
    '---',
    '',
    draft.body.trim(),
    '',
  ].join('\n')
}
