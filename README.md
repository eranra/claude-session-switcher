<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/branding/wordmark-light.png">
    <img src="docs/branding/wordmark-dark.png" alt="Session Sitter" width="560">
  </picture>
</p>

<p align="center"><em>see every agent session · switch in one click · supervise what they pause on</em></p>

<p align="center">
  <a href="https://github.com/eranra/session-sitter/actions/workflows/ci.yml"><img src="https://github.com/eranra/session-sitter/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-602-success" alt="tests">
  <img src="https://img.shields.io/badge/TypeScript-only-3178c6?logo=typescript&logoColor=white" alt="TypeScript only">
  <img src="https://img.shields.io/badge/VS%20Code-1.65%2B-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code 1.65+">
  <img src="https://img.shields.io/badge/license-MIT-informational" alt="MIT">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#supervision-optional">Supervision</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#development">Development</a>
</p>

---

A VS Code extension that does two things for your coding agents.

**It shows you your sessions.** One live panel across
[Claude Code](https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code),
[IBM Bob IDE](https://marketplace.visualstudio.com/items?itemName=ibm.bob-code), Codex and
VS Code Chat — which are alive right now, one click to switch, across windows *and across
machines*, including the sessions on whatever remote hosts your other windows are attached to.

**It supervises what they pause on.** When an agent stops for approval, it classifies that action
into a traffic light against your team's own practices and acts: approve it, correct it, or reach
you with a countdown. Silence is never approval. *Optional — off until you turn it on.*

---

## Install

**Two commands, from source:**

```bash
git clone https://github.com/eranra/session-sitter.git
cd session-sitter
make install
```

That builds the extension and installs it. Then reload the window — `Ctrl+Shift+P` →
**Developer: Reload Window**. Done.

<details>
<summary><strong>Installing into IBM Bob IDE, Cursor, or another VS Code build</strong></summary>

`make install` shells out to `code`. Point it at any other CLI:

```bash
make install CODE=bobide     # IBM Bob IDE
make install CODE=cursor     # Cursor
make install CODE=code-insiders
```
</details>

<details>
<summary><strong>Installing a prebuilt .vsix (no toolchain)</strong></summary>

Grab the `.vsix` from the [latest release](https://github.com/eranra/session-sitter/releases/latest), then either:

- **In the IDE:** Extensions panel → `···` → **Install from VSIX…**
- **From a terminal:** `code --install-extension session-sitter-*.vsix`

Every pull request also attaches a build, under the CI run's **Artifacts** — handy for trying a
change before it lands.
</details>

<details>
<summary><strong>Hacking on it</strong></summary>

```bash
npm ci        # once
make check    # type-check + lint + 602 tests
```

Then press **F5** for an Extension Development Host with live reloading — no packaging step.
`make` on its own lists every target.
</details>

### What you need

| | |
|---|---|
| **VS Code or IBM Bob IDE** | 1.65 or later |
| **Linux or WSL** | Claude liveness detection reads `/proc/<pid>/stat` |
| **`python3`** | to read IBM Bob's SQLite store — standard on Linux/WSL. Only needed for Bob sessions. |
| **Node 20+** | only to build from source |

Not on the Marketplace yet, so installation is by VSIX.

---

> **Upgrading from before 0.5.0?** The project was renamed, and every setting now lives under one
> `sessionSitter.*` namespace — earlier names are no longer read. The old-to-new table is in
> [`CHANGELOG.md`](CHANGELOG.md#050). Your supervision state directory carries over untouched.

---

## First run

Open the **Secondary Sidebar** — `Ctrl+Alt+B`, or **View → Secondary Side Bar**. The
**Session Sitter** panel is there. Open a Claude or Bob session and it shows up within seconds.

| I want to… | Do this |
|---|---|
| Switch to a session | Click the row |
| Close its tab | Click `×` on the row |
| Start a new session | Click `+` (Claude) or `+B` (Bob) |
| Peek at the conversation | Hover a row |
| See older sessions | Click **History ▶** |
| Copy a transcript | Right-click → **Copy transcript** → editor / clipboard / file |
| Open About or Settings | Click **☰** |

The main list is a **live worklist** — only sessions you can act on right now. Claude and Bob are
judged by what their extension hosts report as open, unioned across every window, so a session
open in another window still appears here. Codex and Chat expose no such signal, so they count as
active while recently updated. Everything else moves to History.

### The marker on each row

Every row carries a marker saying whose turn it is, and why.

| Marker | Means | Your move |
|---|---|---|
| spinning green ring | Running a tool, or writing a reply | Nothing — it is busy |
| solid amber arrow | Paused on a permission prompt | Approve or reject it |
| amber question mark | Asked you a question | Answer it |
| green dot in a ring | Finished, and you have not opened it since | Read the result |
| small grey dot | Finished, and you have read it | Nothing |
| hollow grey circle | Nothing happening, or no signal to tell | Nothing |

Each state has its own shape, not only its own colour, so the row still reads at 10px and in a
high-contrast theme. Only the working marker moves — a marker that animates says "leave this
alone", which is the wrong thing to say about a session blocked waiting for you. Hover any marker
for the reason in words. Sort by **Needs you first** (**⇅**) to put the blocked ones on top.

A session waiting for your approval never ages out of the worklist: it is stuck, not stale.

→ [`docs/STATUS-INDICATORS.md`](docs/STATUS-INDICATORS.md) for exactly how each state is decided,
separately for Claude and Bob, and where the answer is inferred rather than known.

---

## Supervision (optional)

Coding agents do not stop when you close the laptop. Supervision is for the moments you are not
there: it classifies each action an agent pauses on and acts.

| Light | Meaning | What happens |
|:---:|---|---|
| 🟢 **Green** | fine | approve the prompt, record it, no human contact |
| 🟡 **Yellow** | a safe correction | inject labeled guidance; the agent self-corrects |
| 🟠 **Orange** | your call | block, send a decision card with a countdown; on timeout deny and offer alternatives |
| 🔴 **Red** | policy | block outright; the block stands on timeout |

**Everything is a setting.** No environment variables, no `.env` to maintain — open
**☰ → All settings…** in the panel, or search `sessionSitter` in the Settings UI.

**1.** State dir, corpus, and knowledge routing:

```jsonc
{
  "sessionSitter.supervisorStateDir": "/home/you/.ai-sessions/state",   // required for the AI supervisor
  "sessionSitter.dataRepoPath": "/home/you/work/team-corpus",           // where your rules live
  "sessionSitter.knowledge.user": "your-slug",
  "sessionSitter.knowledge.project": "your-project",
  "sessionSitter.knowledge.team": "your-team"
}
```

**2.** Pick a classifier and a channel:

```jsonc
{
  "sessionSitter.supervisor.engine": "bob",              // or: "claude"
  "sessionSitter.supervisor.bobApiKey": "…",
  "sessionSitter.supervisor.messagingChannel": "stub",   // cards to files — try it with no account
  // then switch to real cards on your phone:
  // "sessionSitter.supervisor.messagingChannel": "telegram",
  // "sessionSitter.supervisor.telegramBotToken": "…",
  // "sessionSitter.supervisor.telegramChatId": "…"
}
```

Tokens are the one place you may prefer not to use settings, since VS Code stores them in plain
text. Leave a token setting empty and the matching environment variable or `.env` entry
(`BOBSHELL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, …) is still honored as a fallback.
A setting you do fill in always wins.

**3.** Write your first rule. Copy
[`knowledge/bottom-line.template.md`](knowledge/bottom-line.template.md) to
`data/knowledge/teams/<your-team>/bottom-line.md` in your corpus repo and edit it.

**There is nothing to run.** The supervisor runs inside the extension — no daemon, no interpreter,
no background script. Watch decisions land in the **Supervision activity** panel. Turn it off with
`sessionSitter.autoSupervise: false`.

→ [`docs/SUPERVISION.md`](docs/SUPERVISION.md) for the lifecycle, the CLI, and troubleshooting.
→ [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for every setting.

### Rules that skip the supervisor entirely

Prompts you never want to see again are resolved by rule, before any model call:

```jsonc
"sessionSitter.autoRespond": [
  { "toolPattern": "read_file|list_files|glob|grep", "decision": "approveOnce" },
  { "matchPattern": "Do you want to continue\\?", "response": "Yes" }
]
```

First match wins. Anything unmatched goes to the supervisor, or stays for you. A user-facing
question is never auto-answered.

**Rule decisions are visible too.** A rule that auto-approves, auto-rejects, or auto-replies is a
real intervention, so it is recorded like any supervisor decision: it appears in the **Supervision
activity** panel tagged **⚙ rule** (the supervisor's own decisions are tagged **🧠 AI**) and goes
out as a one-way update on your messaging channel. Nothing Session Sitter does to your sessions is
invisible. Keep rule decisions out of Telegram — while still recording them — with
`sessionSitter.supervisor.notifyRuleDecisions: false`.

---

## Features

- **Four sources in one panel** — Claude Code, IBM Bob IDE, Codex CLI, VS Code Chat.
- **Live status** per row, refreshed every 5 s.
- **Sort the list your way** — the ⇅ button picks recency, machine + workspace, workspace, agent,
  title, or needs-you-first. The non-recency orders keep rows still while sessions update, so you
  do not lose your place.
- **A colour per workspace** — give each project its own workspace pill colour, or `auto` to have
  one derived for every project.
- **Cross-window switching** — clicking a session owned by another window brings that window
  forward.
- **Hover preview** of the last few messages.
- **Copy transcript** as handoff-clean markdown: user and assistant prose only, tool calls and
  scaffolding stripped. All four sources.
- **Smart titles** — Claude's AI-generated title, Bob's task title, Codex's thread name, Chat's
  first request.
- **Traffic-light supervision** with a deterministic tier, so read-only actions never cost a model
  call.
- **Auto-respond and auto-approve** rules, scopable per project and per IDE.
- **Supervision activity feed** — every decision, with failures expanding to their recorded error.
- **Upload to corpus** — add a session to the store your rules are learned from, secrets redacted
  before anything is committed.

---

## How it finds your sessions

Only by reading what the agents already write — no reimplementation of their internals:

| Source | Read from |
|---|---|
| **Claude Code** | `~/.claude/projects/**/<uuid>.jsonl` for content; `~/.claude/sessions/<pid>.json` for liveness (PID + kernel start-time, so a recycled PID cannot fake it) |
| **IBM Bob IDE** | `~/.bob/db/bob.db` (read-only), watching `bob.db-wal` for changes |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` plus `~/.codex/session_index.jsonl` |
| **VS Code Chat** | `workspaceStorage/*/chatSessions/*.jsonl` under VS Code's user directory |

Acting on a *blocked* session is a different problem: a task waiting at a permission prompt cannot
be reached by a chat message. That path uses each agent's own approval emitter, reached in-process
through the V8 inspector. → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | components, session detection, the supervision layer, the agent bridges |
| [`docs/STATUS-INDICATORS.md`](docs/STATUS-INDICATORS.md) | the six row markers, and the rules that pick one — per agent |
| [`docs/SUPERVISION.md`](docs/SUPERVISION.md) | the traffic lights, the lifecycle, the CLI, troubleshooting |
| [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md) | the BDI schema, the three tiers, routing |
| [`docs/CORPUS.md`](docs/CORPUS.md) | collecting sessions, bulk import, secret masking |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | every setting, environment variable, flag and command |

---

## Development

`make` with no target lists everything. The ones you will use:

```bash
make check      # type-check + lint + 602 tests — the same gate CI applies
make test       # just the tests
make install    # build the .vsix and install it
make package    # build the .vsix without installing
make clean      # remove build output
```

Everything CI runs is a `make` target or a script in `ci/`, so a green pipeline means `make check`
told you the truth. Tests are [vitest](https://vitest.dev): no network, no real agent, no VS Code
instance.

Releasing: bump `version` in `package.json`, then push a matching tag —
`git tag v0.1.1 && git push origin v0.1.1`. CI verifies the tag agrees with `package.json`, runs
the full gate, and publishes the `.vsix` to a GitHub Release.

---

## Known limitations

- **Linux / WSL for Claude liveness detection** — it reads `/proc/<pid>/stat`. Elsewhere sessions
  still list; the open/closed signal is weaker.
- **A new Claude session appears after its first message** — that is when Claude Code writes the
  session file.
- **Bob cannot report which task is open in its sidebar**, so a running task plus a recency window
  is the best available signal.
- **Codex and Chat have no liveness signal at all** — recency is the proxy
  (`sessionSitter.probelessActiveWindowMinutes`).
- **`python3` is required for Bob sessions** — a VS Code extension has no SQLite driver, and a
  native module would break VSIX portability. Confined to one file, read-only.
  → [why](docs/ARCHITECTURE.md#why-one-python3-call-remains)
- **Claude message injection targets one conversation** — the sessionId↔channel link lives in
  Claude's webview, not its extension host.
- **Supervision needs a classifier CLI** — `bob` or `claude` on your `PATH`.

---

## Contributing

Issues and pull requests welcome. Run `make check` before you push; CI runs the same thing.

## License

MIT
