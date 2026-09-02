# Configuration

**VS Code settings are the source of truth.** Every knob lives under `sessionSitter.*` and is
editable in the Settings UI — open **☰ → All settings…** in the panel, or run **Session Sitter:
Open Settings**. CLI flags cover one-off runs of the standalone supervisor.

Environment variables and `.env` files are a **legacy fallback**, kept so an existing env-based
install keeps working: they apply only to a setting you have not set. Nothing requires an
environment variable any more.

Nothing here is required to use the session switcher, and nothing is required to see your
`sessionSitter.autoRespond` decisions in the **Supervision activity** panel. The AI supervisor needs
`sessionSitter.supervisorStateDir`, and Telegram needs a bot token; everything else has a default.

On a remote setup (WSL, SSH, Bob IDE) put the settings in your **user** settings — they are read
from the client machine.

---

## Upgrading to 0.5.0

The project became **Session Sitter** in 0.5.0, and every setting moved into one `sessionSitter.*`
namespace. The previous names are **not** read, so an existing configuration needs renaming — a
stale key is silently ignored, which looks like the feature simply not working.

The full old-to-new table, plus the two paths that moved on disk, is in
[`CHANGELOG.md`](../CHANGELOG.md#050). Supervision state carries over untouched: point
`sessionSitter.supervisorStateDir` at the same directory and pending decisions resume with their
deadlines intact.

---

## Upgrading to 0.6.0

Supervisor configuration moved from the environment into settings. Your `.env` still works — it is
now only a fallback — but the supervisor is configurable from the UI:

| Was | Now |
|---|---|
| `SUPERVISOR_ENGINE` | `sessionSitter.supervisor.engine` |
| `BOB_CLI_PATH` | `sessionSitter.supervisor.bobCliPath` |
| `CLAUDE_CLI_PATH` | `sessionSitter.supervisor.claudeCliPath` |
| `BOB_API_KEY` / `BOBSHELL_API_KEY` | `sessionSitter.supervisor.bobApiKey` |
| `ANTHROPIC_BASE_URL` | `sessionSitter.supervisor.anthropicBaseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `sessionSitter.supervisor.anthropicAuthToken` |
| `CLAUDE_TIMEOUT_SECONDS` | `sessionSitter.supervisor.classifierTimeoutSeconds` |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `sessionSitter.supervisor.orangeResponseTimeoutMinutes` |
| `MESSAGING_CHANNEL` | `sessionSitter.supervisor.messagingChannel` |
| `TELEGRAM_BOT_TOKEN` | `sessionSitter.supervisor.telegramBotToken` |
| `TELEGRAM_CHAT_ID` | `sessionSitter.supervisor.telegramChatId` |
| `RED_NOTIFY` | `sessionSitter.supervisor.redNotify` |
| `KNOWLEDGE_REPO` | `sessionSitter.supervisor.knowledgeRepo` |
| `KNOWLEDGE_REF` | `sessionSitter.supervisor.knowledgeRef` |

VS Code stores settings in plain text, so for the three credential settings you may prefer to
leave the setting empty and keep using the environment variable. That is a supported choice, not a
deprecation.

---

## VS Code settings

### The session panel

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.autoRespond` | `[]` | Auto-reply and auto-approve rules. See [below](#auto-respond-rules). |
| `sessionSitter.probelessActiveWindowMinutes` | `120` | How recently a **Codex** or **VS Code Chat** session must have been updated to count as active. Those sources expose no live-process signal, so recency is the only proxy; Claude and Bob are judged by what their extension hosts report as open. `0` keeps them in History always. |
| `sessionSitter.sessionSort` | `"recent"` | How the Sessions list and History are ordered. See [below](#sorting-the-session-list). |
| `sessionSitter.workspaceColors` | `{}` | Colour for each workspace's pill on a session row. See [below](#workspace-colours). |

### Supervision

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.supervisorStateDir` | `""` | **Required to enable the AI supervisor.** Holds `history/`, `records/`, `outbox/`, `inbox/`, `notifications/`, `locks/`. Left unset, the extension still records deterministic rule decisions under its own global storage, so the activity panel works without it — only the supervisor stays off. |
| `sessionSitter.autoSupervise` | `true` | Hand every prompt no rule handled to the supervisor, and poll for replies and timeouts. |
| `sessionSitter.supervisorRepoPath` | `""` | Workspace root: the classifier's working directory, and where a legacy `.env` is read from. Derived from the state dir's parent when empty. |

### The classifier

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.supervisor.engine` | `bob` | Which agent CLI classifies an ambiguous action: `bob` (IBM Bob Shell) or `claude` (Claude Code). |
| `sessionSitter.supervisor.bobCliPath` | `bob` | Path to `bob` when it is not on `PATH`. |
| `sessionSitter.supervisor.claudeCliPath` | `claude` | Path to `claude` when it is not on `PATH`. |
| `sessionSitter.supervisor.bobApiKey` | `""` | Bob headless auth. Empty falls back to `BOBSHELL_API_KEY` / `BOB_API_KEY`. |
| `sessionSitter.supervisor.anthropicBaseUrl` | `""` | Gateway passed into the `claude` subprocess. Empty falls back to `ANTHROPIC_BASE_URL`. |
| `sessionSitter.supervisor.anthropicAuthToken` | `""` | Token passed into the `claude` subprocess. Empty falls back to `ANTHROPIC_AUTH_TOKEN`. |
| `sessionSitter.supervisor.classifierTimeoutSeconds` | `300` | Per-invocation classifier timeout (both engines). |

### Messaging

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.supervisor.messagingChannel` | `stub` | `stub` writes cards to `<stateDir>/notifications/` and reads replies from `<stateDir>/inbox/`; `telegram` sends real decision cards. |
| `sessionSitter.supervisor.telegramBotToken` | `""` | From BotFather. Required for `telegram`. Empty falls back to `TELEGRAM_BOT_TOKEN`. |
| `sessionSitter.supervisor.telegramChatId` | `""` | Required for `telegram`. Empty falls back to `TELEGRAM_CHAT_ID`. |
| `sessionSitter.supervisor.orangeResponseTimeoutMinutes` | `30` | How long a decision card waits before it denies and falls back. |
| `sessionSitter.supervisor.redNotify` | `true` | Whether a Red also posts a one-way alert. The block stands regardless. |
| `sessionSitter.supervisor.notifyRuleDecisions` | `true` | Whether **deterministic rule** decisions are also reported to the channel. See [below](#rule-decisions-are-recorded-too). |

With `messagingChannel: "telegram"` but the token or chat id missing, the stub is used and a
warning is logged — supervision degrades rather than failing silently.

### Telegram remote control

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.telegram.remoteControl` | `false` | Turn on the remote interface: each session becomes a topic in a Telegram forum group, and typing in a topic sends into that session. |
| `sessionSitter.telegram.allowedUserIds` | `[]` | Telegram **user ids** permitted to drive it. **Empty authorises nobody.** Rejected ids are logged so you can copy them in. |

The bot token and chat id are **reused** from `sessionSitter.supervisor.telegramBotToken` /
`.telegramChatId` (and their `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` fallbacks), so supervision
cards and the conversation with a session land in the same group.

Two things this feature needs that supervision does not:

- **A forum group.** Topics cannot be enabled in a one-to-one chat, so `chatId` must be a group with
  Topics on. Without it the session list still works and the extension says what to fix.
- **One bot per machine, and the token out of VS Code settings.** A bot token has a single
  destructive message stream, so two machines sharing one steal each other's messages. Settings Sync
  would copy a token from settings to every machine, so keep it in the environment or a `.env` file.

Enabled with no token resolved, or with an empty allowlist, the feature does **not** start and logs
why — rather than connecting and discarding every message, which reads as a broken bot.

Full walk-through: [`TELEGRAM.md`](TELEGRAM.md).

### Knowledge

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.dataRepoPath` | `""` | Corpus repo root — contains `data/sessions/` and `data/knowledge/`. Used by **Upload Session to Corpus** and, unless overridden, as the knowledge source. |
| `sessionSitter.knowledge.user` | `""` | Routes to `data/knowledge/users/<user>/bottom-line.md` — highest precedence tier. |
| `sessionSitter.knowledge.project` | `""` | Routes to `data/knowledge/projects/<project>/bottom-line.md`. |
| `sessionSitter.knowledge.team` | `""` | Routes to `data/knowledge/teams/<team>/bottom-line.md` — lowest precedence. |
| `sessionSitter.knowledge.registryPath` | `""` | Optional registry markdown. When set the triple is validated against it and the documented fallbacks apply; when empty the three slugs are used as given. See [`KNOWLEDGE.md`](KNOWLEDGE.md#routing-which-files-apply-to-this-session). |
| `sessionSitter.supervisor.knowledgeRepo` | `""` | Git URL of the knowledge repo. Used only when no local checkout is configured. |
| `sessionSitter.supervisor.knowledgeRef` | `main` | Ref to read the knowledge repo at, when fetching by URL. |

A slug left empty means that tier is not configured: its file is reported missing and the others
still load. With **no** user configured at all, supervision still runs — the classifier judges the
pending action without BDI to weigh it against. A missing setting never fails a decision, because
the agent is blocked on it. Nothing is ever guessed.

### Deprecated

| Setting | Status |
|---|---|
| `sessionSitter.uploadScriptPath` | **Deprecated.** The uploader is built in. Still read as a fallback: when `sessionSitter.dataRepoPath` is empty, the corpus root is derived from this path, so an existing setup keeps working. Set `sessionSitter.dataRepoPath` instead. |
| `sessionSitter.pythonPath` | **Deprecated and unused.** The supervisor is TypeScript and runs in-process. Reading Bob's SQLite store still uses the `python3` on your `PATH`, but that is not configurable here — see [`ARCHITECTURE.md`](ARCHITECTURE.md#why-one-python3-call-remains). |

---

## Environment (legacy fallback)

Every variable below has a `sessionSitter.*` setting now. A variable applies only when the
matching setting is unset — most usefully for the three credentials, which VS Code would otherwise
store as plain text in a synced `settings.json`.

Precedence, highest first:

1. an explicitly-set `sessionSitter.*` setting (workspace folder > workspace > user)
2. the process environment
3. `<workspaceRoot>/.env`, then `<workspaceRoot>/.supervisor.env`, then the parent's `.env`
4. the built-in default

The standalone supervisor CLI has no settings to read, so for it the environment is still the only
input.

### Classifier

| Variable | Default | Meaning |
|---|---|---|
| `SUPERVISOR_ENGINE` | `bob` | Which agent CLI classifies: `bob` (IBM Bob Shell) or `claude` (Claude Code). |
| `BOB_API_KEY` / `BOBSHELL_API_KEY` | — | Bob headless auth. Either name works. |
| `BOB_CLI_PATH` | `bob` | Override when `bob` is not on `PATH`. |
| `CLAUDE_CLI_PATH` | `claude` | Override when `claude` is not on `PATH`. |
| `CLAUDE_TIMEOUT_SECONDS` | `300` | Per-invocation classifier timeout (both engines). |
| `ANTHROPIC_BASE_URL` | — | Gateway passed into the `claude` subprocess. |
| `ANTHROPIC_AUTH_TOKEN` | — | Token passed into the `claude` subprocess. |

### Messaging

| Variable | Default | Meaning |
|---|---|---|
| `MESSAGING_CHANNEL` | `stub` | `stub` writes cards to files and reads replies from `inbox/`; `telegram` sends real decision cards. |
| `TELEGRAM_BOT_TOKEN` | — | From BotFather. Required for `telegram`. |
| `TELEGRAM_CHAT_ID` | — | Required for `telegram`. |
| `ORANGE_RESPONSE_TIMEOUT_MINUTES` | `30` | How long an Orange waits before it denies and falls back. |
| `RED_NOTIFY` | `true` | Whether a Red also posts an informational alert. `0` silences it; the block stands regardless. |
| `NOTIFY_RULE_DECISIONS` | `true` | Whether deterministic rule decisions are also reported to the channel. `0` silences them; they are still recorded. |

### State and knowledge

| Variable | Default | Meaning |
|---|---|---|
| `STATE_DIR` | `<workspaceRoot>/.supervisor-state` | Only used by the CLI; the extension passes `sessionSitter.supervisorStateDir`. Supports a leading `~`. |
| `KNOWLEDGE_LOCAL_REPO` | — | Local corpus checkout. Also accepted as `KB_SITTER_LOCAL_REPO`. |
| `KNOWLEDGE_REPO` | — | Git URL, used only when no local checkout is set. Also accepted as `KB_SITTER_KNOWLEDGE_REPO`. |
| `KNOWLEDGE_REF` | `main` | Ref to clone when reading remotely. |
| `KNOWLEDGE_REGISTRY_PATH` | — | Registry markdown, for the CLI. |

---

## Sorting the session list

`sessionSitter.sessionSort` picks the order of the **Sessions** list and **History**. Switch it from
the panel's **⇅** toolbar button — the menu writes this setting, so the choice survives a reload and
applies in every window.

The default sorts by newest activity, which means the rows move every time a session updates. That
is fine for "what did I touch last" and painful for "where is the session I was just reading". The
other orders sort by properties of the session rather than by the clock, so a row only moves when a
session appears or disappears.

| Value | Order | Rows hold still |
|---|---|---|
| `recent` *(default)* | Newest activity first. | no |
| `hostWorkspace` | Machine, then workspace, then title. This machine leads, then peers by host name. | yes |
| `workspace` | Workspace, then title — regardless of which machine the session is on. | yes |
| `source` | Agent (Claude, Bob, Codex, Chat), then workspace, then title. | yes |
| `title` | Session title, A to Z. | yes |
| `status` | Waiting on you first, then running, then idle — newest first inside each group. | no |

Sessions with no workspace sort last in the workspace-grouped orders, and an unknown value in the
setting falls back to `recent` rather than failing.

The list is still **capped by recency** before it is sorted (20 rows in Sessions, 50 in History), so
picking an alphabetical order never hides the sessions you touched most recently.

---

## Workspace colours

`sessionSitter.workspaceColors` gives each workspace its own colour for the **workspace pill** on a
session row. Unlisted workspaces keep the theme's badge colour, which is what every pill used to be.

Keys are tried in the order you write them and the **first match wins**, so put a specific workspace
above a broad glob. A key may be:

| Key | Matches |
|---|---|
| `my-app` | the workspace whose folder name is `my-app` |
| `/home/you/work/my-app` | that exact workspace path (case-insensitive, trailing slash optional) |
| `scratch-*` | any name or path matching the glob — `*` is any run of characters, `?` is exactly one |
| `*` | every workspace — the catch-all |

Values are a hex colour, a built-in name, or `auto`:

| Value | Meaning |
|---|---|
| `#0f8`, `#1a2b3c` | that colour |
| `red` `orange` `amber` `yellow` `lime` `green` `teal` `cyan` `blue` `indigo` `violet` `purple` `magenta` `pink` `brown` `slate` `gray` | a built-in colour, picked to stay legible on light and dark themes |
| `auto` | derive a stable colour from the workspace itself — same project, same colour, in every window and on every machine |

The label colour is chosen automatically for contrast against the fill, so a light colour still
reads. A value that is not a colour is ignored and that pill stays on the theme colour, rather than
being painted something arbitrary.

```jsonc
"sessionSitter.workspaceColors": {
  "session-sitter": "green",            // one project, by name
  "/home/you/work/payments": "#c0392b", // one checkout, by path
  "scratch-*": "slate",                 // a family of throwaway workspaces
  "*": "auto"                           // everything else gets its own colour
}
```

Colours apply to History rows as well, and to sessions on other machines — the same project has the
same colour wherever it is running.

---

## Auto-respond rules

One array, two kinds of rule, evaluated in order — first match wins.

| Field | Kind | Meaning |
|---|---|---|
| `matchPattern` | text | JS regex tested against the latest assistant message. |
| `response` | text | Text sent into the session on a match. |
| `toolPattern` | approval | Glob against the pending tool name. `*` matches any run of characters, `\|` separates alternatives. |
| `argumentPattern` | approval | Optional JS regex against the tool arguments JSON. Unanchored. |
| `decision` | approval | `approveOnce`, `approveForTask`, or `reject`. |
| `sessionPattern` | scope | Optional JS regex against the session's project path. |
| `source` | scope | `bob` (default) or `claude`. |

`approveForTask` also suppresses future prompts for that permission group — and, for
execute-style tools, that specific command.

```jsonc
"sessionSitter.autoRespond": [
  { "toolPattern": "read_file|list_files|glob|grep", "decision": "approveOnce" },
  { "toolPattern": "execute_command",
    "argumentPattern": "\"command\":\\s*\"(git (status|diff|log)|ls|pwd)",
    "decision": "approveOnce" },
  { "toolPattern": "*", "decision": "approveOnce", "sessionPattern": "/scratch/" },
  { "matchPattern": "Do you want to continue\\?", "response": "Yes" },
  { "matchPattern": "continue\\?", "response": "yes", "source": "claude" }
]
```

Two guards no rule can override:

- **A user-facing question is never auto-approved.** `ask_followup_question` and
  `AskUserQuestion` always go to a human, even against `toolPattern: "*"` — approving one makes
  the agent report that you gave no answer.
- **An uncaptured Claude request is never auto-approved.** If the metadata hook missed it we know
  neither the tool nor whether it is a question, so `*` must not allow it.

An invalid regex or glob skips that rule; it never throws.

### Rule decisions are recorded too

A rule that auto-approves, auto-rejects, or auto-replies changes what your agent does, so it is
not silent. Every applied rule is written as a supervision record under `<stateDir>/records/` —
the same files the supervisor writes, with `decided_by: "rule"` and a `rule` trace naming the
pattern that fired — and posted to your messaging channel as a **one-way update** (never a
decision card; the decision is already made).

In the **Supervision activity** panel the two tiers are tagged so you can tell them apart:

| Tag | Meaning |
|---|---|
| **⚙ rule** | a deterministic `sessionSitter.autoRespond` rule decided it — no model was consulted |
| **🧠 AI** | the supervisor decided it (classifier + your knowledge tiers) |

The traffic light follows the outcome: an approve is 🟢 green, a reject is 🔴 red, and a canned
text reply is 🟡 yellow.

Rule decisions need **no configuration at all**. They do not need
`sessionSitter.supervisorStateDir` (with it unset, records go to the extension's own global storage
— the log line `state dir: …` on activation says where) and they do not need
`sessionSitter.autoSupervise`: they are recorded and shown in the panel even with the supervisor
turned off. Telegram is the one part that must be configured — until you set
`sessionSitter.supervisor.messagingChannel: "telegram"` plus a bot token and chat id, rule
decisions appear in the panel only. Set `sessionSitter.supervisor.notifyRuleDecisions: false` to
keep them out of Telegram while still recording them.

---

## CLI flags

Both CLIs take `--help`.

**Supervisor** — `node out/supervisor/cli.js`

| Flag | Meaning |
|---|---|
| `run <sessionId>` | Classify one already-exported session. |
| `poll [--loop N]` | Apply replies and timeouts once, or every N seconds. |
| `--user` `--project` `--team` | The knowledge-routing triple. |
| `--transcript PATH` | Read a transcript export directly (offline runs). |
| `--workspace-root PATH` | Workspace root. `--repo-root` is accepted as an alias. |
| `--state-dir PATH` | Supervision state directory. |

**Corpus** — `node out/corpus/cli.js`

| Flag | Meaning |
|---|---|
| `upload <file>` | Upload one session. `--source` `--slug` `--user` `--force`. |
| `delete <filename>` | Remove a stored session and its sidecar. |
| `list` | List stored sessions. `--source` `--top N`. |
| `import` | Bulk-import from the local stores. `--bob` `--claude` `--limit N` `--no-push` `--no-mask` `--force`. |
| `mask` | Redact secrets in the store. `--report PATH`. |
| `fetch-knowledge` | Print the three tier files as JSON. `--user` `--project` `--team` `--local DIR` \| `--repo URL` `--ref REF`. |
| `--repo PATH` | Corpus repo root. Defaults to the current directory. |
| `--dry-run` | Print every step without touching git or the filesystem. |

---

## Commands

All under the **Session Sitter** category:

| Command | What it does |
|---|---|
| Open Settings | Opens every Session Sitter setting in the Settings UI. |
| Refresh Sessions | Sessions update automatically; this just says so. |
| New Claude Session | Opens a fresh Claude conversation in the active editor column. |
| Upload Session to Corpus | Uploads the selected session (also on the row's right-click menu). |
| Export Session for Supervision | Writes a full transcript export by hand, for a manual classify. |
| Supervise the Blocked Session Now | Classifies the currently-blocked prompt on demand. |
| Test Bob Send / Test Claude Send | Sends a test message into the most recent session of that source. |
| Test Claude List Approvals | Lists Claude's pending permission prompts. |
| Probe … / Install … Hook / Capture … | Read-only internals probes for debugging the agent bridges. |

---

## See also

- [`SUPERVISION.md`](SUPERVISION.md) · [`KNOWLEDGE.md`](KNOWLEDGE.md) · [`CORPUS.md`](CORPUS.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
