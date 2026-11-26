# dsh-dreaming

Dreaming for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Once a day, when you have been idle for a while, a dream reads each workspace's new sessions and updates its long-term memory. Preferences you state in several workspaces become global memory, and tasks you repeat become skill drafts for you to approve. You get a desktop notification and read the report: `/dream report`, or ask the agent "what did the dreaming do?". Every change is a version you can undo with `/dream rollback`.

If you would rather review each dream first, set `auto.apply: false`; dreams then wait for `/dream apply <id>`.

The design follows what Anthropic describes for Claude Managed Agents in [The components of agent memory](https://anthropic.com/engineering/components-of-agent-memory) (Nov 2026) and the [dreams API](https://platform.claude.com/docs/en/managed-agents/dreams). The idea is the same; the code is independent and runs on whatever model you use in DSH.

## How it works

Memory has four layers:

| Layer | In this plugin |
|---|---|
| Transcripts | DSH's own session history, read through `ctx.sessionQuery`, and optionally your Claude Code and Codex transcripts. Never modified. |
| Notes | Short standalone facts, preferences, corrections, pitfalls and procedures. Each note cites the sessions and events it came from, and records whether you said it or the agent inferred it. |
| Wiki | Topic pages that group related notes and cite them. |
| Loaded every session | A small block (2 KiB by default, at most 4 KiB) added to every new conversation as runtime context: global preferences first, then the workspace's own. |
| Skills | `SKILL.md` drafts made from procedures you repeat. Used only after you approve them. |

A dream runs in the background and makes these passes, each one a single model call with no tools:

1. **Select** sessions in the workspace that have something new since the last dream. Subagent sessions and the conversation that started the dream are skipped.
2. **Extract** candidate memories from each transcript, in chunks, written as rules for the agent ("When …, …") rather than descriptions of you or of an incident.
3. **Consolidate**: the model proposes `add`, `confirm`, `update`, `merge` and `drop` operations. Code checks each one before it is applied.
4. **Tidy**: near-duplicates are merged (including ones added in the same dream) and notes that describe you or narrate an incident are reworded as rules.
5. **Wiki**: pages are rewritten when notes change.
6. **Choose** which notes every session loads. Code decides, not the model: only preferences, corrections and pitfalls; notes seen in several sessions first; at most 3 notes resting on a single session, and only while confirmed in the last 14 days; near-duplicates skipped; within the byte cap.
7. **Skills**: procedures from sessions that read no web or tool content are drafted as `SKILL.md` files for review.

After the workspaces, a **global pass** looks for preferences you stated in two or more workspaces and makes each one a single global note. A workspace then loads it once, as the global note, instead of its own copy (a workspace note with project-specific detail stays). A global note is retired when fewer than two workspaces still back it, and one you remove with `/dream rollback global` is not promoted again.

The result is staged as a new version with a readable diff. In automatic mode it is applied right away and summarized in the report (`~/.dsh/dreaming/reports/latest.md`). Otherwise you apply or discard it with `/dream`.

## Safety

Dreams read transcripts that may contain hostile web pages, so the model only proposes and code decides:

- **The agent can't edit memory.** Model tools can start a dream and read memory and reports. Applying, discarding and rolling back happen only through the automatic run or the `/dream` command, which only you can type. Automatic apply skips your review, not the checks below.
- **The model can't pick who said something.** A note counts as user-stated only if it cites a line you typed. A note supported only by tool output is quarantined, never stored.
- **Web content contributes only what you typed.** A session that used a browser, web fetch, web search, MCP or computer-use tool is treated as tainted. By default (`taintPolicy: user-only`) only what you typed in it is read, and the model is told the agent's side is hidden. A note from a tainted session can be loaded into every session only if it is something you typed; nothing the agent or a tool said in a tainted session ever is, and tainted sessions never produce skills.
- **The agent can't overrule you on a guess.** One inferred session cannot change or remove a note you stated. An inferred note needs three untainted sessions before every session loads it. Facts and procedures are never loaded into every session; they stay searchable with `memory_search`.
- **Skills always wait for you.** Even with automatic apply, a drafted skill is only offered to sessions after `/dream skills approve <name>`. A rejected skill is not drafted again.
- **Planted instructions are refused.** Notes that read like instructions planted in the transcript are rejected, and so are URLs that carry query strings.
- **Secrets are redacted** before any model call and again in every note: API keys, tokens, private keys, `password=`, card-like numbers.
- **It stays out of your way.** Automatic dreams wait until no session has been active for 20 minutes, and pause between workspaces if you start working again. `/dream now` and `/dream tidy` return at once and run in the background.
- **Busy models are retried.** A temporary model error (a 503 "Loading model", 429, 5xx, a timeout or a network error) is retried after 10, 30 and 90 seconds. A workspace that still fails is tried again in an hour, and its sessions stay unread until then.
- **Budgets are hard.** The defaults are 60 model calls, about 400k input tokens and 30 minutes per dream. A dream that runs out stages what it has and says so.
- **Tidying can't raise trust.** A merge only joins notes of the same trust, and merged or reworded text is checked as if the agent wrote it.
- **Imported transcripts count only real typing.** Compaction summaries, background notifications, command output and injected instructions in Claude Code and Codex transcripts are never treated as your words.
- **Applying is safe.** Versions are immutable and the last 20 are kept. Apply refuses when memory changed after the dream started.

Memory lives in `~/.dsh/dreaming`. Directories are created 0700 and files 0600.

## Install

You need Node.js 24.9+ and pnpm. Build the plugin first:

```sh
git clone https://github.com/natgurlain/dsh-dreaming.git && cd dsh-dreaming
pnpm install && pnpm run build
```

Then register it with the DSH desktop app:

```sh
dsh plugin --profile desktop add -w "@natgurlain/dsh-dreaming@link:$PWD"
```

Or with `dsh web`:

```sh
dsh plugin --profile web add -w "@natgurlain/dsh-dreaming@link:$PWD"
```

Restart DSH afterwards.

## Use

Nothing to do: the first automatic dream runs once DSH has been up 10 minutes and you have been idle for 20, then every 24 hours. To read what it did, or to steer it:

```
/dream report                the latest automatic dream report
/dream now                   run the automatic dream now, in the background
/dream tidy                  merge duplicates and reword notes in every store
/dream skills                skills drafted for this workspace
/dream skills show <name>    read a drafted skill
/dream skills approve <name> let new sessions use it
/dream skills reject <name>  drop it for good
/dream run                   dream about this workspace's sessions
/dream run global            dream about every session
/dream run focus on testing  steer what the dream looks for
/dream                       recent dreams and their status
/dream diff <id>             what a dream would change
/dream apply <id>            make it the current memory
/dream discard <id>          drop it (its sessions count as dreamed)
/dream cancel <id>           stop a running dream
/dream rollback [global] [n] go back one version, or to version n
/dream memory [global]       what every session currently loads
```

The agent also gets two read-only tools, `memory_search` and `memory_read`, for notes and wiki pages that are not loaded into every session.

## Configuration

Set these in `cordis.patch.yml` or in the profile's plugin config:

| Key | Default | |
|---|---|---|
| `maxSessionsPerDream` | 20 | 1 to 100 |
| `injectedMaxBytes` | 2048 | at most 4096 |
| `taintPolicy` | `user-only` | `user-only`, `exclude`, or `include` |
| `model` | DSH default model | `provider/model` |
| `maxModelCalls` / `maxInputChars` / `maxMinutes` | 60 / 1,600,000 / 30 | budget per dream |
| `injectMemory` | true | set false to keep memory searchable but not loaded into sessions |
| `root` | `~/.dsh/dreaming` | |
| `auto.enabled` | true | dream automatically |
| `auto.intervalHours` | 24 | hours between automatic dreams |
| `auto.apply` | true | apply without review; false leaves each dream for `/dream apply` |
| `auto.startDelayMinutes` | 10 | wait after DSH starts before the first check |
| `auto.retryAfterMinutes` | 60 | when a workspace fails (model busy, loading or offline), try again this soon instead of the next day |
| `auto.idleMinutes` | 20 | dream only after no session activity for this long; 0 to ignore activity |
| `auto.global` | true | promote preferences stated in two or more workspaces to global memory |
| `auto.notify` | true | desktop notification (macOS, or `notify-send` on Linux) when a report has news |
| `skills` | true | draft skills from repeated procedures |
| `import.claudeCode` | false | also dream Claude Code transcripts from `~/.claude/projects` |
| `import.codex` | false | also dream Codex transcripts from `~/.codex/sessions` |
| `import.days` | 14 | only transcripts changed in this many days |

Imported transcripts land in the memory of the directory they ran in, next to that directory's DSH sessions. Only what you typed counts as your words; tool output never becomes a note, and their web and MCP tools taint a session like DSH's own.

## Measuring quality

`pnpm replay` re-runs the candidates earlier dreams extracted through the current rules, from empty memory, and prints what every session would load. It reads your memory folder and never writes to it. To get a precision number, label what should be loaded:

```sh
pnpm replay --write-labels labels.json   # today's loaded notes, verdict blank
# set "keep": true or false for each note, then:
pnpm replay --labels labels.json         # precision and recall against your labels
```

It talks to an OpenAI-compatible endpoint (`--base-url`, default `http://127.0.0.1:18081/v1`; `--model`, default `inkling-2-mini`).

## Not yet

- A review panel in the DSH client.
- Re-checking evidence against the full session log.
- Exporting memory to `AGENTS.md`.

## Development

```sh
pnpm test        # vitest, with a fake model and fake session history
pnpm run typecheck
pnpm run build
```

## License

MIT
