# dsh-dreaming

Dreaming for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Once a day, in the background, a dream reads each workspace's new sessions and updates its long-term memory. You just read the report: `/dream report`, or ask the agent "what did the dreaming do?". Every change is a version you can undo with `/dream rollback`.

If you would rather review each dream first, set `auto.apply: false`; dreams then wait for `/dream apply <id>`.

The design follows what Anthropic describes for Claude Managed Agents in [The components of agent memory](https://anthropic.com/engineering/components-of-agent-memory) (Nov 2026) and the [dreams API](https://platform.claude.com/docs/en/managed-agents/dreams). The idea is the same; the code is independent and runs on whatever model you use in DSH.

## How it works

Memory has four layers:

| Layer | In this plugin |
|---|---|
| Transcripts | DSH's own session history, read through `ctx.sessionQuery`. Never modified. |
| Notes | Short standalone facts, preferences, corrections, pitfalls and procedures. Each note cites the sessions and events it came from, and records whether you said it or the agent inferred it. |
| Wiki | Topic pages that group related notes and cite them. |
| Loaded every session | A small block (2 KiB by default, at most 4 KiB) added to every new conversation as runtime context. |

A dream runs in the background and makes these passes, each one a single model call with no tools:

1. **Select** sessions in the workspace (or all of them for global memory) that have something new since the last dream. Subagent sessions and the conversation that started the dream are skipped.
2. **Extract** candidate memories from each transcript, in chunks.
3. **Consolidate**: the model proposes `add`, `confirm`, `update`, `merge` and `drop` operations. Code checks each one before it is applied.
4. **Wiki**: pages are rewritten when notes change.
5. **Choose** which notes every session loads.

The result is staged as a new version with a readable diff. In automatic mode it is applied right away and summarized in the report (`~/.dsh/dreaming/reports/latest.md`). Otherwise you apply or discard it with `/dream`.

## Safety

Dreams read transcripts that may contain hostile web pages, so the model only proposes and code decides:

- **The agent can't edit memory.** Model tools can start a dream and read memory and reports. Applying, discarding and rolling back happen only through the automatic run or the `/dream` command, which only you can type. Automatic apply skips your review, not the checks below.
- **The model can't pick who said something.** A note counts as user-stated only if it cites a line you typed. A note supported only by tool output is quarantined, never stored.
- **Web content contributes only what you typed.** A session that used a browser, web fetch, web search, MCP or computer-use tool is treated as tainted. By default (`taintPolicy: user-only`) only what you typed in it is read. A tainted session can never get a note loaded into every session.
- **The agent can't overrule you on a guess.** One inferred session cannot change or remove a note you stated. An inferred procedure needs two sessions. An inferred note needs three untainted sessions before every session loads it. Procedures the agent inferred are never loaded into every session.
- **Planted instructions are refused.** Notes that read like instructions planted in the transcript are rejected, and so are URLs that carry query strings.
- **Secrets are redacted** before any model call and again in every note: API keys, tokens, private keys, `password=`, card-like numbers.
- **Busy models are retried.** A temporary model error (a 503 "Loading model", 429, 5xx, a timeout or a network error) is retried after 10, 30 and 90 seconds. A workspace that still fails is tried again in an hour, and its sessions stay unread until then.
- **Budgets are hard.** The defaults are 60 model calls, about 400k input tokens and 30 minutes per dream. A dream that runs out stages what it has and says so.
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

Nothing to do: the first automatic dream runs 10 minutes after DSH starts, then every 24 hours. To read what it did, or to steer it:

```
/dream report                the latest automatic dream report
/dream now                   run the automatic dream now
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

## Not yet

- A review panel in the DSH client.
- Running dreams as DSH jobs with live progress.
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
