/**
 * Wiki pages (layer 3) and the review diff.
 *
 * @module @natgurlain/dsh-dreaming/pipeline/wiki
 */

import type { MemorySnapshot, Note, WikiPage } from '../types.ts'
import { redact } from './redact.ts'

export const MAX_PAGE_CHARS = 8_000
export const MAX_PAGES = 30

export function parseWiki(value: unknown, notes: readonly Note[]): WikiPage[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { pages?: unknown }).pages)) throw new Error('expected {"pages":[...]}')
  const known = new Set(notes.map((note) => note.id))
  const seen = new Set<string>()
  const pages: WikiPage[] = []
  for (const raw of (value as { pages: unknown[] }).pages) {
    if (pages.length >= MAX_PAGES) break
    const page = raw as { slug?: unknown; title?: unknown; body?: unknown }
    if (typeof page.slug !== 'string' || typeof page.title !== 'string' || typeof page.body !== 'string') continue
    const slug = page.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    if (slug === '' || slug === 'index' || seen.has(slug)) continue
    // Citations to notes that do not exist are removed rather than trusted.
    const body = redact(page.body).replace(/\[n:([a-z0-9-]+)\]/g, (match, id: string) => known.has(id) ? match : '').slice(0, MAX_PAGE_CHARS)
    seen.add(slug)
    pages.push({ slug, title: redact(page.title.replace(/\s+/g, ' ').trim()).slice(0, 120), body })
  }
  return pages
}

/** A markdown summary of what a staged snapshot changes. */
export function renderDiff(base: MemorySnapshot, next: MemorySnapshot, header: string): string {
  const before = new Map(base.notes.map((note) => [note.id, note]))
  const after = new Map(next.notes.map((note) => [note.id, note]))
  const lines: string[] = [header, '']
  const added = next.notes.filter((note) => !before.has(note.id))
  const removed = base.notes.filter((note) => !after.has(note.id))
  const changed = next.notes.filter((note) => before.has(note.id) && before.get(note.id)?.text !== note.text)
  const label = (note: Note): string => `\`${note.id}\` (${note.kind}, ${note.trust}, ${new Set(note.sources.map((s) => s.sessionId)).size} session${new Set(note.sources.map((s) => s.sessionId)).size === 1 ? '' : 's'})`
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return
    lines.push(`## ${title}`, '', ...items, '')
  }
  section('Added notes', added.map((note) => `- ${label(note)}${note.supersedes === undefined ? '' : ` replaces ${note.supersedes.map((id) => `\`${id}\``).join(', ')}`}: ${note.text}`))
  section('Changed notes', changed.map((note) => `- ${label(note)}\n  - was: ${before.get(note.id)?.text ?? ''}\n  - now: ${note.text}`))
  section('Removed notes', removed.map((note) => `- \`${note.id}\`: ${note.text}`))
  const wasInjected = new Set(base.injected)
  const isInjected = new Set(next.injected)
  section('Loaded into every session: added', next.injected.filter((id) => !wasInjected.has(id)).map((id) => `- \`${id}\`: ${after.get(id)?.text ?? ''}`))
  section('Loaded into every session: removed', base.injected.filter((id) => !isInjected.has(id)).map((id) => `- \`${id}\`: ${before.get(id)?.text ?? after.get(id)?.text ?? ''}`))
  const oldPages = new Map(base.wiki.map((page) => [page.slug, page]))
  const newPages = new Map(next.wiki.map((page) => [page.slug, page]))
  section('Wiki', [
    ...next.wiki.filter((page) => !oldPages.has(page.slug)).map((page) => `- new page \`${page.slug}\`: ${page.title}`),
    ...next.wiki.filter((page) => oldPages.has(page.slug) && oldPages.get(page.slug)?.body !== page.body).map((page) => `- rewritten \`${page.slug}\`: ${page.title}`),
    ...base.wiki.filter((page) => !newPages.has(page.slug)).map((page) => `- removed \`${page.slug}\`: ${page.title}`),
  ])
  if (lines.length === 2) lines.push('No changes.', '')
  return `${lines.join('\n').trimEnd()}\n`
}
