# Telegram remote control

Drive your sessions from Telegram: see what is running, read a session, and type into it from your
phone. Off by default.

Each **active** session becomes a **topic** in a Telegram forum group, so the thread you are typing
in *is* the session you are talking to. There is no "which session am I addressing?" state to get
wrong.

```
GROUP "Session Sitter"  (Topics enabled)

  # General                            ← the active list, /sessions /history /new /who /help
  # 🟠 sitter / sort order · claude              2
  # 🔄 payments / refund flow · bob
  # ⚪ scratch / spike · codex@laptop2
```

Open a topic and you get that session's turns as they happen, its supervision cards, and a text box
that sends straight into the agent.

Every name reads the same way: **status, workspace, title, then the agent and the machine.** The
status icon leads because "what needs me?" is the question the sidebar is being asked. The workspace
comes next because it says which piece of work this is. Which agent it is, and which machine it runs
on, are worth knowing but never worth reading first — and the machine is shown only when it is not
this one.

---

## Setup

Five steps, once per machine.

**1. Create a group and turn on Topics.**
Make a Telegram **group** (not a channel), open *Manage group → Topics*, and enable it. Topics cannot
be enabled in a one-to-one chat, which is why this needs a group even for a single user.

**2. Create a bot, and disable its privacy mode.**
Talk to [@BotFather](https://t.me/BotFather): `/newbot` for the token, then `/setprivacy` → **Disable**.

Privacy mode is on by default and hides ordinary messages from the bot — it would see `/sessions` but
not the text you type in a session topic. With it on, the feature appears to work and silently
ignores everything you say to an agent.

**3. Add the bot to the group as an admin with *Manage Topics*.**
It creates, renames and closes a topic per session, none of which is possible without that right.

**4. Give this machine its token and the group id.**

```bash
# ~/.supervisor.env, or the environment
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-1001234567890
```

The group id is negative. That is normal.

**5. List who may drive it, and turn it on.**

```jsonc
{
  "sessionSitter.telegram.remoteControl": true,
  "sessionSitter.telegram.allowedUserIds": ["123456789"]
}
```

**Without the allowlist nothing is acted on.** To find your id, turn the feature on, send any message
in the group, and read the *Session Sitter* Output panel — the id of each rejected sender is logged
for you to copy in.

---

## Use one bot per machine

A bot token has a **single** message stream, and reading it removes each message from that stream. Two
machines polling the same token do not each get a copy: every message goes to whichever asked first.
Your reply then reaches the wrong machine, or appears to be ignored.

So give each machine its own bot, and add them all to the same group. Each bot handles the sessions on
its own machine, and the group shows the union — the fleet view emerges without any machine talking to
another.

This is also why the token belongs in the environment or a `.env` file rather than in VS Code
settings: **Settings Sync would copy one machine's token to all of them**, recreating exactly this
problem, invisibly. The setting is still read first if you set it, and the log says which source was
used.

A machine with no bot still appears in the list — its sessions are pulled over SSH by the existing
peer discovery — but they are marked read-only, because only that machine can write to them.

---

## What you can do

### In General

| Command | Effect |
|---|---|
| `/sessions` | Redraw the list of active sessions. One pinned message, edited in place. |
| `/history` | The earlier sessions. Tap one to bring it back into the active list. |
| `/new` | Start a session: pick a workspace, then Claude or Bob. |
| `/who` | Which window owns which session, and why. Explains a read-only row. |
| `/help` | The commands, and the current write limits. |

The list is ordered by workspace and then title, **not** by time. It is edited in place, and a time
ordering would reshuffle every row on every poll. A row moves only when a session appears,
disappears, or changes status.

Once you have asked for it, the list **keeps itself current** — it is redrawn whenever the fleet
changes, so a session that leaves the worklist leaves the list without you tapping Refresh. The
ticking ages are deliberately not treated as a change: Telegram rate-limits edits to a pinned
message, and re-drawing every few seconds to move "2m" to "3m" would spend that budget on nothing.

### The list holds the active sessions, and only those

The group shows the same sessions the **Sessions panel** shows, and nothing else. A machine
accumulates hundreds of past sessions; a list of hundreds answers no question, because you cannot
find the one that needs you in it.

Both surfaces apply one rule, in [`sessionActivity.ts`](../src/sessionActivity.ts), so they cannot
disagree about the same fleet:

- **Claude / Bob** — active when a live window reports the session open. Failing that, active while
  it is blocked on you (at any age — a session waiting for your approval is stuck, not stale), or
  while it was working recently.
- **Codex / VS Code Chat** — no liveness signal exists for these, so recency is the only honest
  proxy: active while updated inside `sessionSitter.probelessActiveWindowMinutes`.

**A session that leaves the active list has its topic closed**, right then — not after a timeout.
Closed, never deleted: the scrollback and the search stay. A topic is also closed after
`sessionSitter.telegram.idleTopicCloseHours` of quiet even while its session is still active, so a
session sitting open in a window for a week does not hold a thread open beside the live ones.

A closed topic **reopens when there is a new turn to post**. Reopening on "the session is still
active" instead would fight the idle rule — closed every quiet period, reopened on the next pass,
forever — and new turns are the thing you would actually have missed. A topic you open by hand is
left alone for ten minutes whichever list its session is in, so tapping a `/history` row never leads
to a thread that closes under you.

### `/history` — bringing a session back

`/history` lists what the active list does not, newest first, one button per session. Tapping one:

1. opens (or creates) its topic, so you can read it immediately, and
2. focuses the session in its IDE on its own machine.

The second step is what actually returns it to the active list, because "active" means a window has
it open. So the panel and the Telegram list agree about it again from the next pass — nothing is
pinned into the list by hand, and there is no second notion of "active" to get out of step.

If no window on the machine owns the session, the topic is still created and says so: you can read
it, but there is nothing to focus and nothing to write to.

### In a session topic

Type anything and it is sent into that session as a user message. The topic answers with `✅` or with
the reason it could not.

Two buttons on the topic header:

- **Full transcript** — uploaded as a Markdown file. A transcript is far past Telegram's
  4096-character message cap, so it cannot be a message.
- **Focus in IDE** — brings the session to the front on its own machine, reusing the same
  cross-window and cross-machine handshake a click in the panel uses.

---

## What can be written to

Reading works everywhere. Writing does not, and the limit is in the agent, not here.

| Agent | Read | Write |
|---|:---:|---|
| **Bob** | ✅ | ✅ Any task, live or historical |
| **Claude** | ✅ | ⚠️ Sessions open in their own window |
| **Codex** | ✅ | ❌ No message API exists |
| **VS Code Chat** | ✅ | ❌ No message API exists |

A Codex or Chat topic says it is read-only in its header rather than accepting your message and
dropping it.

### The Claude limit, precisely

Session Sitter injects a message by writing to a session's CLI transport. Finding *which* transport
belongs to a given session is done by searching, at the moment of sending, for a channel that carries
that session id.

- **Found** → the message goes to that session.
- **Not found, one Claude session open in that window** → it goes there. There is nothing to confuse
  it with.
- **Not found, several open** → **nothing is sent**, and the topic says so.

That last case is a deliberate refusal. Delivering your prompt to the wrong agent is worse than not
delivering it, because the wrong agent acts on it. Close the other sessions in that window, or use
**Focus in IDE**.

Routing helps more than it sounds: a command goes to the window that owns the session, so the count
that matters is Claude sessions in *that* window, not on the machine.

---

## How it decides which window is responsible

One window owns a session, and only its owner writes to it. Ownership is worked out independently by
every window from the shared window registry, so they agree without coordinating.

1. **A window has it open.** Taken from the live agent state each window already publishes
   (`openClaudeSessionIds`, `openBobTaskIds`). Exact.
2. **Otherwise, the longest containing workspace.** Covers idle and history sessions. This is why a
   session in `<repo>/.claude/worktrees/feat` is owned by the window on the worktree if one is open,
   and by the window on the parent repo if not.
3. **Otherwise, nobody.** The session is read-only, and the topic says which machine it is on.

Ties break on the lowest process id, so every window computes the same owner.

---

## Topics come and go

A topic is created automatically for any session that **needs you or is running** — `approval`,
`question`, `finished` or `working`. The three quiet states get one only when you tap the session in
the list, because auto-creating a topic per historical session would put weeks of them in the sidebar.

The status leads every topic name, so the topic list doubles as a status board. Same amber / green /
grey language as the panel — see [`STATUS-INDICATORS.md`](STATUS-INDICATORS.md):

| Icon | Status | Meaning |
|:---:|---|---|
| 🟠 | `approval` | Paused on a permission prompt — approve or reject |
| ❓ | `question` | Asked you something — answer it |
| 🟢 | `finished` | Done, and you have not read it |
| 🔄 | `working` | Running a tool or writing a reply — nothing to do |
| ⚫ | `seen` | Done, and you have read it |
| ⚪ | `dormant` | Nothing happening, or no signal to tell |

A quiet session's topic is **closed**, never deleted, after
`sessionSitter.telegram.idleTopicCloseHours` (default 24). Closing keeps the scrollback and the
search; if the session becomes active again its topic reopens by itself.

---

## Two limits worth knowing

**Telegram's rate limit.** A bot may send on the order of 20 messages a minute to one group. A busy
agent produces far more turns than that. So mirroring posts **user prompts and assistant text only**
— no tool-by-tool noise — and a burst collapses into one line:

```
… 26 earlier turns not shown — use Full transcript
🧑 run the tests
🤖 3 failed in sessionSort.test.ts
```

Queuing the burst instead would put the group minutes behind the session, which is worse than saying
what was skipped.

**Starting a session is not confirmable.** Neither Claude nor Bob returns an id when told to open a
conversation — the id appears only once the CLI writes its first record. So `/new` reports that the
window was opened, and the session's topic appears a poll or two later once it exists.

---

## When something does not work

Every failure is stated in the topic. Silence is never the answer. If it is, check these.

| Symptom | Cause |
|---|---|
| Commands work, typed text does nothing | Privacy mode is still on for the bot. `/setprivacy` → Disable. |
| Nothing happens at all | `allowedUserIds` is empty, or your id is not in it. The Output panel logs each rejected id. |
| "Topics are not enabled in this group" | The chat is a group without Topics, or a channel. Enable Topics. |
| Messages reach the wrong machine, or vanish | Two machines share a bot token. Give each its own. |
| `⚠ No open window is responsible for that session` | Its workspace has no window open. Open it. |
| `⚠ Its window has N Claude sessions open` | The Claude limit above. |
| Topics stop updating after a window closes | Another window takes over reading within about 30 seconds. |

The Output panel (*Session Sitter*) and `<stateDir>/session-sitter.log` carry the detail.

---

## Alongside supervision

Both features share the group, and the remote interface makes supervision better in two ways.

**A decision card lands in its session's topic**, beside the conversation it is about, instead of in
one shared feed where you had to read each card's session line to tell them apart. Answer it there —
tap a button or reply with text — exactly as before.

**Windows no longer fight over your replies.** Every window with supervision on used to poll Telegram
with the same token and one shared offset file, so replies were already being split between windows at
random. It mostly worked, but a Claude decision could be applied to the wrong session. Now one window
per machine reads, and a reply is routed to the window that owns the session it concerns.

You do not have to configure any of this. It follows from turning the interface on.

---

## Where the state lives

Beside the existing window registry, under your home directory:

```
~/.claude/session-sitter/
  windows/<pid>.json     which sessions each window has open  (already existed)
  bus/telegram.lock      the lease: which window reads Telegram
  bus/cmd/, bus/res/     commands to the owning window, and their outcomes
  bus/topics/<id>.json   session ↔ topic, and how far mirroring got
```

Nothing here is secret and all of it is disposable — deleting it costs you the topic mapping, and new
topics are created on the next pass.

---

## See also

- [`CONFIGURATION.md`](CONFIGURATION.md#telegram-remote-control) — every setting
- [`SUPERVISION.md`](SUPERVISION.md) — decision cards, which post into their own session's topic
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit
