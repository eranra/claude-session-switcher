# Changelog

This is the one file that names what the project used to be called. Everywhere else carries a
single name — **Session Sitter** — and `ci/check-naming.sh` enforces that.

## Unreleased

### 0.8.4 — Telegram shows the active sessions, and nothing else

A dead session's topic was **closed**, and closing does not remove it. Telegram keeps a closed topic
in the group's topic list — locked, greyed, and fully visible — so the cleanup that was supposed to
keep the group equal to the worklist did nothing a user could see. A real install had 46 topic
records: 43 correctly marked closed, and all 43 still sitting in the sidebar. The one thing the
feature was meant to prevent had happened anyway.

Topics are now **deleted** when their session leaves the active list. `ForumApi.deleteTopic` calls
`deleteForumTopic` and the record is dropped, so the group's topic list is the active list. Nothing
that matters is lost: the transcript on disk was always the source of truth, and `/history` builds a
fresh topic from it.

Two details this depended on:

- **Already-closed records are selected too.** `topicsToDelete` no longer skips `closed` topics, the
  way the old `topicsToPrune` did. Every install carries a pile of them from this version's
  predecessor, and passing over those would have left the 43 dead threads there for good — the
  upgrade would have fixed nothing.
- **A topic already gone is not a failure.** `isTopicGoneError` tells "message thread not found"
  apart from "not enough rights", so a topic you deleted by hand in the app has its record dropped
  instead of being retried on every pass forever. A genuine permission failure keeps the record,
  falls back to closing the topic, and says why in the Output log — the bot needs `can_manage_topics`.

The empty-fleet guard is unchanged and now matters more: a window whose session scan has not loaded
yet reports nothing active, and acting on that would have deleted every topic in the group.

**`sessionSitter.telegram.idleTopicCloseHours` is removed.** It closed the topic of a session that
was *still active*, which under the new rule just puts a locked thread back in the list. With delete
as the only cleanup there is one rule and nothing to tune: a session in the worklist has an open
topic, and the moment it leaves, the topic goes.

`lastActivityAt` goes from the topic record with it — the idle timer was its only reader, and a field
still written on every turn for nobody to read is worse than an absent one. Old records on disk parse
fine; the extra key is ignored.

### 0.8.3 — Give the panel a clock, and a spinner that survives a repaint

**A bound is not a bound if nothing checks it.** Every age rule the panel applies is measured against
`Date.now()` at the moment `_partitionSessions` runs: the 2h `working` fallback and the probeless
recency window in `isActiveSession`, the 24h finished→dormant split in `resolveDisplayStatus`, and the
pruning of a dead window's session ids by `readLiveWindows`. But that only runs when the webview
repaints, and every repaint trigger was a *change* signal. The one that matters is gated —
`onDidChangeSessions` fires only when `sessionsFingerprint` moves, and a fingerprint stops moving for
good once a session's raw status settles on a transcript nobody will write to again.

So the panel could not see time pass. A row that should have aged out hours ago kept whatever verdict
the panel last reached, until something unrelated happened in the fleet and the whole list corrected
itself at once. That is how it was found: a day-old session sat at the top of the worklist until a new
session was started in another workspace, at which point the list silently fixed itself. The 60-second
`_registryTimer` was no help — it publishes this window's registry entry and never repaints anything.
`PANEL_REPAINT_MS` now ticks every 15 seconds while the view is visible, skipping hidden panels
because each tick costs two inspector round-trips into other extension hosts. Not a regression: the
same gap is in 0.8.0.

**The `working` spinner was being restarted faster than it could turn.** `renderTabs()` clears the
strip and rebuilds every row on every push, and a brand-new element starts its CSS animation at 0°.
Pushes follow the fingerprint, which for a streaming session means every 250ms watcher debounce —
Claude writes its transcript far faster than that, as the comment on `STREAMING_WINDOW_MS` already
says. So the one state that animates was also the one rebuilt several times a second, and the ring
snapped back to 0 before it had turned a quarter. It read as a ring twitching in place.

The marker's phase is now anchored to the wall clock with a negative `animation-delay`, so each new
element picks up where the one it replaced left off. `SPIN_PERIOD_MS` in `main.js` and the duration in
`styles.css` have to agree for that to work, and a test pins them together — a mismatch is invisible
in review and shows up only as a marker that jumps. Nothing changes under `prefers-reduced-motion`:
there is no animation left to offset.

The underlying waste — tearing down the whole strip several times a second, which also drops hover
state and the row preview — is untouched. Reconciling rows by session id is the fix, and it is its own
change.

### 0.8.2 — Stop a dead session sitting at the top of the worklist

A session killed mid-tool-call was pinned as `approval` **forever**. The two blocked states are the
only ones the worklist never ages out — on purpose, because a session waiting on you is stuck rather
than stale — so it sat at the top of the list for weeks, on the strength of a transcript that would
never be written again, with no process left to answer it and no way to clear it. Found in a real
registry as a 47-hour-old `approval` that no window held.

An unanswered tool call now reads `dormant` once it has been silent for a day
(`ABANDONED_TOOL_CALL_MS`). Fixed in `sessionStatus.ts` rather than in the worklist filter, so the
panel and Telegram both get it from one rule. Nothing is lost by the bound: a session whose window is
still open stays in the worklist through the live probe, which never consults the status, and Bob's
live pending approvals still upgrade a row at any age. It only bites when *no* live signal agrees
with the file — the case where the file is the thing that is wrong.

**The window registry now writes atomically.** `writeWindowEntry` truncated and wrote in place, so a
reader on its timer could catch a fragment, and a process killed mid-write left one behind for good —
two 0-byte entries had been sitting in a real registry since July. It writes to a temporary name and
renames, like `TopicStore` already did. Cleanup was the other half: an unparsable entry was skipped
but never deleted, because the old code only removed a file *after* parsing it. Unparsable entries are
now cleaned once they are older than the 24h staleness bound — age-gated, so a window mid-recovery is
never made invisible to its peers.

**Two things that could hide the same symptom are now visible in the log**, rather than needing a
guess:

- `PendingWatcher` names every blocked session on each change, and says so when nothing is blocked.
  This map is the only input that can make a row `approval` or `question`, and those never age out —
  one stale entry pins a row indefinitely. It used to log only when the *read failed*, which made
  "why is this old task in my active list?" unanswerable.
- The Claude inspector calls out sessions that have state but no open panel. `open` is
  `sessionPanels ∪ sessionStates`, so each of those counts as held by the window, and therefore
  active at any age. Whether Claude drops a session's state when its panel closes is undocumented and
  was not reproducible, so the union is **unchanged** — this is instrumentation, not a behaviour
  change, and the log now says which ids to suspect.

### 0.8.1 — Telegram shows the active sessions, and only those

The Telegram group used to list every session the machine had ever seen. A fleet accumulates
hundreds, and a list of hundreds answers no question — you cannot find the one that needs you in it.
It now shows exactly what the **Sessions panel** shows: the active worklist.

Not "the same by convention". The rule moved into `src/sessionActivity.ts`, a pure module both
surfaces call, so there is one definition of *active* and nothing to keep in sync. Telegram also
reads the panel's **display** statuses, so an amber row in the sidebar is an amber row on your phone.

A session that leaves the active list has its topic **closed**, right then rather than after a
timeout — closed, never deleted, so the scrollback stays and the topic reopens by itself if the
session comes back.

```
  # General                            ← /sessions /history /new /who /help
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

**Names now read status → workspace → title → agent → machine.** The workspace comes first because
it says which piece of work this is, which is the question a list of twenty rows is actually asked.
The agent and the machine trail, and the machine appears only when it is not this one. The list is
no longer grouped by host — that heading put the machine name above the workspace, which is exactly
backwards. Same order in the topic name, the list row, the topic header and `/who`.

**`/history`** reaches everything the worklist does not, newest first. Tapping a row opens its topic
*and* focuses the session in its IDE — the second step is what returns it to the active list, since
active means a window has it open. So there is no second, Telegram-only notion of active to drift
out of step with the panel.

The status glyphs are unchanged but now pinned by a test against
[`docs/STATUS-INDICATORS.md`](docs/STATUS-INDICATORS.md), which gained a Telegram column. Amber is
your turn wherever you read it.

### Telegram as a remote interface to your sessions

Your sessions now appear as **topics** in a Telegram forum group. Open a topic to read that session's
turns as they happen, and type in it to send a message straight into the agent. Off by default —
`sessionSitter.telegram.remoteControl`.

```
GROUP "Session Sitter"  (Topics enabled)

  # General                            ← the live list
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

Topics were chosen over a menu message or a card-per-session because the thread *is* the selection:
there is no "which session am I talking to?" state to get out of sync, unread badges are per session,
and each session keeps its own scrollback. Supervision cards for a session now land in that session's
topic instead of one undifferentiated feed.

A topic appears automatically for every active session, and on demand for the quiet ones (see the
entry above for which sessions count as active). Its name leads with the status, so the topic list
doubles as a status board in the same amber / green / grey language the panel uses. A topic is
**closed** — never deleted — after `sessionSitter.telegram.idleTopicCloseHours` of quiet, reopening by
itself if the session revives.

`/new` starts a session, offering the workspaces that currently have a window open. That list comes
from the live window registry rather than a configured allowlist, so it can never offer a target
nothing could run in.

**What can be written to.** Reading works for all four agents. Writing does not, and the limit is in
the agent rather than here:

| Agent | Read | Write |
|---|:---:|---|
| Bob | ✅ | ✅ any task, live or historical |
| Claude | ✅ | ⚠️ sessions open in their own window |
| Codex | ✅ | ❌ no message API exists |
| VS Code Chat | ✅ | ❌ no message API exists |

A read-only topic says so in its header rather than accepting your message and dropping it.

**Claude targeting, and one deliberate refusal.** Injecting a message means writing to a session's CLI
transport, and the sessionId↔channel link is not exposed by every Claude build. It is now searched for
at send time — the channel map key, the channel's own properties, `query.initConfig` — and falls back
to the sole open channel where there is nothing to confuse it with. When several are open and none
matches, **nothing is sent** and the topic says why. Delivering a prompt to the wrong agent is worse
than not delivering it, because the wrong agent acts on it.

**One bot per machine.** A bot token has a single update stream and reading it is destructive, so two
machines sharing one steal each other's messages. Give each machine its own bot and add them all to the
same group; the fleet view is the union of their topics. This removes any need for cross-machine
plumbing — coordination is intra-machine only. Keep the token in the environment or a `.env` file
rather than VS Code settings, because Settings Sync would copy one machine's token to all of them.

**Fixed along the way: windows no longer fight over Telegram.** Every window with `autoSupervise` on
and a state dir set was polling `getUpdates` with the same token and one shared offset file, so replies
were already being split between windows at random. It half-worked because the state dir is shared, but
for Claude the decision was then applied to the *wrong* session. Reading is now held by one window per
machine under a renewable lease, and an inbound reply is routed to the window that owns the session it
belongs to.

**Ownership is claimed by what a window holds, not by path.** A window claims a session it actually has
open, from the ids the window registry already publishes; failing that, the window whose workspace is
the longest containing folder; failing that, nobody and the session is read-only. The path tier gets
this repository's own worktree convention right — a session in `<repo>/.claude/worktrees/feat` belongs
to the worktree's window if one is open — and a separator check stops `/work/app` claiming
`/work/app-legacy`.

**New settings**

| Setting | Default | Purpose |
|---|---|---|
| `sessionSitter.telegram.remoteControl` | `false` | The master switch. |
| `sessionSitter.telegram.allowedUserIds` | `[]` | Telegram user ids permitted to drive it. **Empty authorises nobody** — a group is not a private chat, and rejected ids are logged so you can copy them in. |
| `sessionSitter.telegram.idleTopicCloseHours` | `24` | How long a session may be quiet before its topic is closed. |

The bot token and chat id are reused from the existing `sessionSitter.supervisor.telegram*` settings,
so supervision cards and the conversation with a session share one group.

Setup, the failure table, and the exact write limits: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## 0.8.0

### The session list can hold still, and it sorts six ways

The list was always sorted by recency, so every status change reshuffled it. Reading a list of a
dozen sessions across five checkouts meant the row you were aiming at moved under the cursor — and
recency tells you nothing about *which* session a row is, which is the question you actually have
when several of them look alike.

A **⇅** button in the toolbar now picks the order, and the choice is written to
`sessionSitter.sessionSort`, so it survives a reload and applies in every window:

| Order | Rows hold still |
|---|---|
| `recent` — newest activity first (the default, unchanged) | no |
| `hostWorkspace` — machine, then workspace, then title | yes |
| `workspace` — workspace, then title, across machines | yes |
| `source` — agent (Claude, Bob, Codex, Chat), then workspace | yes |
| `title` — A to Z | yes |
| `status` — waiting on you, then running, then idle | no |

"Holds still" is a property of the comparators, not a hope: every one of them is total, falling
through to the session id, because a comparator that ties leaves those rows in whatever sequence
the scan produced — and that sequence changes between passes. The modes live in one place
(`sessionSort.ts`) and the panel builds its menu from the list the extension host sends, so the
panel cannot offer an order the sorter does not implement.

The cap on the list (20 rows, 50 in History) is still applied by **recency**, before the display
sort. Sorting by title and then taking the first 20 would drop the sessions you touched most
recently, which is the opposite of what a worklist is for.

### Each workspace can have its own colour

Every workspace pill was the theme's badge colour — one colour for every project, which is no help
at all when the panel lists sessions from five checkouts. `sessionSitter.workspaceColors` maps a
workspace to a colour:

```jsonc
"sessionSitter.workspaceColors": {
  "session-sitter": "green",
  "/home/you/work/payments": "#c0392b",
  "scratch-*": "slate",
  "*": "auto"
}
```

A key is a workspace name, a full path, or a glob over either, and the first matching key wins — the
same rule `sessionSitter.autoRespond` already uses. A value is a hex colour, one of seventeen built-in
names, or `auto`, which hashes the workspace into the palette: the same project gets the same colour
in every window and on every machine, with nothing to configure. The label colour is picked for
contrast automatically, so a light fill still reads.

The default is unchanged: a workspace with no rule keeps the theme colour. A value that is not a
colour is ignored rather than fatal, so a typo shows up as "this project is not coloured" instead of
a broken panel.

Both settings are read by the extension host on every push and take effect as soon as you edit them
— including for peer sessions, so the same project looks the same wherever it is running.

## 0.7.3

### The project has a logo

There was no picture anywhere. The README opened with a bare `<h1>`, the marketplace tile fell back
to the grey default placeholder, and the GitHub repo card was text on grey. For a tool whose whole
pitch is a panel you look at, that is a bad first impression — and the marketplace ranks and renders
an extension with no icon worse than one with any icon at all.

The mark is three agents tucked in a cradle over the red / amber / green supervision light: it is
sitting with your sessions, and it grades what they pause on. `package.json` now declares
`icon` and a `galleryBanner` in the badge's navy, so the marketplace tile and its header are
branded. The README header is a wordmark that swaps with the reader's light or dark theme.

Every asset is original artwork and lives in [docs/branding/](docs/branding/) with the palette and a
regeneration script. It borrows no vendor's mark, and the palette avoids Claude's orange on purpose
— the extension supervises Claude Code, IBM Bob and Codex alike, so looking like any one of them
would be both a licensing problem and a lie about what this is.

The marketplace icon is a copy at `resources/logo.png` rather than a reference into `docs/`, because
`.vscodeignore` keeps `docs/` out of the `.vsix`. `resources/icon.svg` is untouched: the activity-bar
glyph has to stay monochrome `currentColor` so VS Code can tint it to the user's theme.

## 0.7.2

### Activity rows and Telegram cards now say which session, and which machine

A decision card named its session by id and nothing else. Every id looks the same, so the panel
listed a column of interventions with no way to tell which session each one landed in — and with
several machines reporting into one Telegram chat, a card could not even be attributed to a host.
Approving from your phone meant guessing.

Each record now carries the session's name (its panel title, else its project name) and the short
name of the machine it ran on. The activity row shows `🗂 <name>` with `🖥 <host>` and keeps the id in
its tooltip; the Telegram `session:` line reads `session: <name> @ <host> (<id>)`. Both tiers set
them: the supervisor takes the name from the transcript it just classified, and a deterministic
`autoRespond` decision takes it from the session list, so a rule card is as attributable as an AI
one. A peer's session is credited to the peer's machine, not to this one.

One formatter serves the card and the feed, and it falls back to the id rather than to an empty
label — so a record written before these fields existed still reads exactly as it used to.

## 0.7.1

### Peer sessions landed in History instead of the session list

0.7.0 pulled a peer's sessions correctly and then hid them. A session reaches the active list only
when some **live window** reports it open, and that set was built from `readLiveWindows`, which
reads this machine's registry directory and tests liveness with `process.kill` — neither of which
can say anything about a process on another host. So a peer session was never "reported open" and
fell through to the status fallback, which an idle session waiting at a prompt fails. The session
was pulled, tagged, and filed under History, which looks exactly like a session that was never
found at all.

The peer's own window entries now count as reporters alongside the local ones. They are the right
authority: the probe resolves liveness with `kill -0` on the machine that owns the pid, so a peer
window entry is as trustworthy about its machine as a local entry is about this one. An unreachable
peer publishes no windows, so it vouches for nothing.

### Your own machine is no longer probed, or reported unreachable

An IDE records this host's own LAN address as an `ssh-remote` target as readily as any other, and a
machine has no reason to hold an authorized key for itself — so the extension probed itself, failed
on publickey, and named the user's own machine as unreachable in the panel, every pass, forever.

Self-detection could not be left to the probe's `machineId` reply, because that answer only arrives
after the SSH that is failing. Discovery now recognises this host up front, by its interface
addresses and its own name, and drops it before any connection is attempted. Host names are
compared on whole labels, never as substrings: hiding a real peer is worse than probing one extra
host.

## 0.7.0

### Sessions from your other machines, with no configuration

Two IDE windows attached to two different machines showed two different session lists, and there
was no way to see one from the other. Nothing was broken: every session source is rooted at
`os.homedir()`, and this extension runs in the *remote* extension host on purpose so it can reach
the remote filesystem. One extension host per machine means one `$HOME` per machine, so "across
windows" had always quietly meant "across windows on this machine".

The panel now also shows sessions from peer machines, tagged with the machine they live on, and
clicking one focuses the window on **its own** machine.

There is nothing to configure. The IDE already records every remote window you have opened as an
`ssh-remote+user@host` entry in its own state store, so peers are read from there — a local file
read, no SSH traffic, and it yields the exact address the IDE itself connects with. Peers are then
probed over SSH with one connection each, reused via `ControlMaster` and refreshed on a slower timer
than the local scan, so a peer on a slow link can never stall the local session list.

Reachability is one-way in practice: this machine may reach a server that cannot reach back through
NAT. So each window shows what it can reach and names what it cannot, rather than letting an
unreachable machine look like a machine with nothing running. SSH runs with `BatchMode=yes`
throughout — a host that would prompt for a password is reported unreachable instead of wedging a
background timer on a prompt nobody can see — and a failing peer backs off exponentially.

Supervision stays local to the machine that owns the session, which is also the machine that can
act on it.

Set `sessionSitter.remotePeers` to `off` to disable all of it: no discovery, no polling, and no SSH
connection of any kind.

## 0.6.3

### Deterministic decisions are reported without any configuration

Ask a Bob session to run `date`, watch Session Sitter click **Allow once** for you, then look at
the **Supervision activity** panel and at Telegram: nothing. The decision happened and left no
trace anywhere.

The cause was one setting standing in for two unrelated things. `sessionSitter.supervisorStateDir`
gated the AI supervisor — correctly, since it shells out to a classifier CLI and must stay opt-in —
but it also gated every *reporting* destination, because records live under that directory. A
`sessionSitter.autoRespond` rule needs no supervisor and no settings at all, so on a default
install the rules fired and the reporter was never built: `onRuleDecision` was `undefined`,
`AutoResponder.report()` returned immediately, and the panel had no feed to read. The only hint was
one line in an Output channel nobody had open — and the on-disk log that would have said so also
lived under the state dir that did not exist.

The two are now separate. The state dir always resolves, falling back to the extension's own global
storage, so a rule decision is always recorded and always shows up in the activity feed. What still
gates the supervisor (and the outbox that serves it) is whether you *set* the setting, not whether a
path happens to resolve — defaulting a path must never start a classifier nobody asked for. The
activation log now names the state dir in use, which also makes the multi-window case diagnosable:
on a remote setup the panel and the deciding window must read the same settings.

Telegram is the one part that genuinely needs configuring. When rule notifications are on but no
channel is set up, the log now says so explicitly instead of leaving the silence unexplained.

## 0.6.2

### A session you interrupted no longer sits in the active list forever

A Claude session last touched a month ago stayed in **Sessions** instead of falling back to
History. Two things combined to keep it there.

**A `type: "user"` record is not always the user typing.** Status is inferred from the tail of
the transcript, and any user-type record was read as "you sent a message, Claude has not replied
yet" — status `waiting`. But Claude Code writes several other things as user-type records: every
tool result (carrying `toolUseResult`), injected context such as skill loads and scheduled prompts
(`isMeta`), and the `[Request interrupted by user]` marker. The reported session ended on that
interrupt marker, written *after* the `last-prompt` terminal record, so the backward scan returned
`waiting` before it ever reached the marker that says "this session is done". A transcript never
written to again reports `waiting` forever.

The scan now skips those three kinds of record and keeps looking backward, so it reaches the real
signal behind them. A genuine prompt still reports `waiting`, and a tool result still reports
`active` while the tool is in flight.

**The non-idle fallback had no age bound.** A Claude or Bob session counts as active when its
extension host reports it open, *or* when its status is not idle. That second clause exists to
survive a momentary probe failure (a WSL2 / inspector hiccup), but it applied at any age — so one
mis-read status pinned a session in the worklist indefinitely. The fallback is now bounded to two
hours, matching the recency window already used for Codex and VS Code Chat. A live report from a
probe stays authoritative at any age.

## 0.6.1

### Switching to a Claude session now focuses it where it already is

Clicking a Claude session that was open in the **side bar** opened a *second* view of it as a new
editor tab, instead of focusing the one already on screen.

`claude-vscode.primaryEditor.open` reads like "focus this session", but it is not. It calls Claude's
`createPanel`, which reveals an existing panel only when its `sessionPanels` map holds the session
id, and otherwise **creates a new panel**. A session living in the side bar is never in
`sessionPanels`, so switching to it always built a duplicate.

Switching now asks Claude where the session actually is before acting:

- **Open as an editor panel** → reveal that panel, in whatever editor group it sits in.
- **Held by this window with no panel, and `claudeCode.preferredLocation` is `sidebar`** → focus the
  side bar, which is where it is showing.
- **Closed or older session** → open it by id, reopening the conversation. Unchanged.

The same rule now applies to adding a session from **History**, which had the identical problem.

Known limit: Claude exposes no per-session side bar API and does not track which session its side bar
is showing, so in the second case Session Sitter can focus the side bar but not force it to a
specific session. This matches what Claude's own "Claude Code: Open" command does.

Internally, the open-sessions probe now reports Claude's `sessionPanels` and `sessionStates` maps
separately instead of merging them, because the difference between the two is what says *where* a
session lives. A merged set could not tell a live side bar session from a closed one.

## 0.6.0

**Every intervention is visible, and everything is configured from settings.**

### Deterministic rule decisions are now recorded and reported

Until now only the supervisor's decisions reached you. A `sessionSitter.autoRespond` rule that
auto-approved a tool prompt, auto-rejected one, or sent a canned reply changed what your agent did
and left no trace outside the log.

Every applied rule now writes a supervision record under `<stateDir>/records/` — the same file
shape the supervisor writes, with `decided_by: "rule"` and a `rule` trace naming the pattern that
fired — and posts a **one-way update** to your messaging channel.

- The **Supervision activity** panel tags each card **⚙ rule** or **🧠 AI**, and shows the rule
  pattern that fired.
- The light follows the outcome: approve → 🟢, reject → 🔴, canned text reply → 🟡.
- A rule decision is never an interactive card. The decision is already made; there is nothing to
  ask.
- This needs only `sessionSitter.supervisorStateDir`. Rule decisions are recorded and reported even
  with `sessionSitter.autoSupervise: false`, because no classifier is involved.
- New `sessionSitter.supervisor.notifyRuleDecisions` (default `true`) keeps them out of Telegram
  while still recording them.

A decision is reported only once it actually reached the agent: a failed resolve or a failed send
reports nothing. Reporting can never delay or break applying a decision — a broken record write or
a dead channel is logged and dropped.

### Supervisor configuration moved into settings.json

The supervisor used to read its engine, credentials, channel and timeouts from the environment or a
`.env` file. All of it is now a `sessionSitter.supervisor.*` setting, editable in the Settings UI:

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

**Not breaking.** The environment and `.env` are still read as a fallback for any setting you have
not set, so an existing install keeps working untouched. Precedence is: an explicitly-set setting >
process environment > `.env` files > built-in default. VS Code stores settings in plain text, so
leaving a credential setting empty and keeping the environment variable is a supported choice.

The standalone supervisor CLI (`node out/supervisor/cli.js`) has no settings to read and is
unchanged — environment plus flags.

### Also

- New command **Session Sitter: Open Settings**, and the panel's **☰** menu now offers
  **All settings…**, **Auto-respond rules…** and **Supervisor settings…** separately.
- One messaging channel per window, shared by the supervisor and the rule reporter — two Telegram
  consumers on one bot would fight over `getUpdates`.

## 0.5.0

**The project is now Session Sitter.** Same extension, one name, and one settings namespace.

### Breaking: every setting moved

Two namespaces collapsed into `sessionSitter.*`. The old names are **not** read, so an existing
configuration needs renaming — a stale key is silently ignored, which looks like the feature simply
not working.

| Before 0.5.0 | 0.5.0 |
|---|---|
| `claudeSessionSwitcher.autoRespond` | `sessionSitter.autoRespond` |
| `claudeSessionSwitcher.probelessActiveWindowMinutes` | `sessionSitter.probelessActiveWindowMinutes` |
| `reckon.supervisorStateDir` | `sessionSitter.supervisorStateDir` |
| `reckon.autoSupervise` | `sessionSitter.autoSupervise` |
| `reckon.supervisorRepoPath` | `sessionSitter.supervisorRepoPath` |
| `reckon.dataRepoPath` | `sessionSitter.dataRepoPath` |
| `reckon.knowledge.user` · `.project` · `.team` | `sessionSitter.knowledge.user` · `.project` · `.team` |
| `reckon.knowledge.registryPath` | `sessionSitter.knowledge.registryPath` |
| `reckon.uploadScriptPath` | **removed** — set `sessionSitter.dataRepoPath` instead |
| `reckon.pythonPath` | **removed** — it was already unused |

Command ids moved the same way: `claudeSessionSwitcher.refresh` → `sessionSitter.refresh`, and so
on for all 17.

### Breaking: two paths on disk

| Before 0.5.0 | 0.5.0 |
|---|---|
| `~/.claude/session-switcher/` | `~/.claude/session-sitter/` |
| `<stateDir>/session-switcher.log` | `<stateDir>/session-sitter.log` |

The first is cross-window focus state and is rebuilt within a minute, so there is nothing to move.

**Your supervision state carries over untouched.** Records, transcripts, the outbox and the
messaging offset all keep their format — point `sessionSitter.supervisorStateDir` at the same
directory and pending decisions resume with their deadlines intact.

### Also in this release

- The extension id is `eranra.session-sitter`; the panel is titled **Session Sitter**; the output
  channel and the command category match.
- **`ci/check-naming.sh`** fails the build on any leftover of a previous name, in code or in prose.
  No allowlist except this file.
- **`ci/check-settings.mjs`** asserts that every setting the code reads is declared in
  `package.json`, and vice versa. It was written after the rename produced exactly that drift —
  the code read one namespace while the declarations used another, and nothing failed: every
  `config.get()` just returned its fallback. A compiler cannot catch that; comparing the two sides
  can.

## 0.1.0

- Consolidated a private supervision runtime into this extension as **TypeScript only** — roughly
  2,600 lines of Python (a traffic-light supervisor, a session-corpus uploader, a secret masker and
  a knowledge loader) ported to `src/supervisor/` and `src/corpus/`, with the behavior contracts
  intact.
- Added traffic-light supervision of the actions an agent pauses on, the Bob and Claude
  extension-host bridges, the supervision activity feed, and approval rules alongside the existing
  text rules.
- Added CI (compile, lint, 602 tests on Node 20 and 22, packaging, docs links, spellcheck, guards),
  a release pipeline, and a Makefile.

## 0.0.x

Session panel for Claude Code and IBM Bob IDE: live status, one-click switching, cross-window
focus, hover preview, history. Later added Codex CLI and VS Code Chat as sources, full-transcript
export, and the Copy transcript submenu.
