/**
 * Replay saved candidates through the current consolidation rules and score
 * what would be loaded into every session.
 *
 *   pnpm replay --write-labels labels.json     # template from today's memory
 *   pnpm replay --labels labels.json           # replay and score
 *
 * Options: --root (default ~/.dsh/dreaming), --base-url (default
 * http://127.0.0.1:18081/v1), --model (default inkling-2-mini), --only <path part>.
 * Set OPENAI_API_KEY for an endpoint that needs a key. Reads memory, never writes it.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { labelTemplate, openAiCompatible, replay, type Labels } from '../src/replay.ts'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: join(homedir(), '.dsh', 'dreaming') },
    'base-url': { type: 'string', default: 'http://127.0.0.1:18081/v1' },
    model: { type: 'string', default: 'inkling-2-mini' },
    labels: { type: 'string' },
    'write-labels': { type: 'string' },
    only: { type: 'string' },
  },
})

if (values['write-labels'] !== undefined) {
  await writeFile(values['write-labels'], `${JSON.stringify(await labelTemplate(values.root), null, 2)}\n`, { flag: 'wx' })
  console.log(`Wrote ${values['write-labels']}: set "keep" to true or false for each note, then run with --labels.`)
  process.exit(0)
}

const labels = values.labels === undefined ? {} : JSON.parse(await readFile(values.labels, 'utf8')) as Labels
const result = await replay({
  root: values.root,
  llm: openAiCompatible(values['base-url'], process.env.OPENAI_API_KEY),
  model: { provider: 'replay', model: values.model },
  settings: {
    maxSessions: 100, taintPolicy: 'user-only', injectedMaxBytes: 2048, chunkChars: 60_000, candidatesPerCall: 150,
    budget: { maxCalls: 60, maxInputChars: 1_600_000, maxMinutes: 30 }, callTimeoutMs: 180_000,
  },
  labels,
  ...(values.only === undefined ? {} : { only: values.only }),
})
for (const store of result.stores) {
  console.log(`\n${store.cwd}: ${store.candidates} candidates -> ${store.injected.length} loaded (keep ${store.kept}, drop ${store.dropped}, unlabeled ${store.unlabeled})`)
  for (const text of store.injected) console.log(`  + ${text}`)
  for (const text of store.missed) console.log(`  missed: ${text}`)
}
const pct = (value: number | undefined): string => value === undefined ? 'n/a (no labels)' : `${(value * 100).toFixed(0)}%`
console.log(`\nprecision ${pct(result.precision)}, recall ${pct(result.recall)}`)
