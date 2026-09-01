# Telegram remote control — design

**Date:** 2026-09-01
**Status:** implemented

Turn Telegram into a working remote interface to the sessions Session Sitter manages: see what is
running, read a session, type into it, and start new ones. Off by default.

---

## The problem

Session Sitter already knows about every session on every machine, and already talks to Telegram for
supervision decisions. But the Telegram side is one-way and one-purpose: it asks a question about a
blocked action and takes an answer. You cannot look at your sessions from your phone, read one, or say
anything to one.

Some of the pieces exist. `TelegramChannel` has inline keyboards, long-polling and callback routing.
`SessionManager` reads full transcripts for all four agents. `SupervisorOutbox` is a durable queue for
applying an action back into an agent. A free-text message already reaches *a* Bob session through an
`@active` sentinel.

What is missing is everything to do with **which** session: selecting one, showing one, and delivering
a message to the one you picked.

---

## Constraints found in the code

Four facts shaped every decision below. Three were discovered by reading, not assumed.

**1. A bot token has one update stream, and reading it is destructive.** `getUpdates` hands each
update to whichever caller asked first. This is not a design preference to work around; Telegram
provides no per-topic filter and no way to fan one stream out.

**2. That is already a live defect.** Every window builds its own `TelegramChannel`
(`extension.ts:247`), and every window with `autoSupervise` on and a state dir set polls
(`extension.ts:283`) — same token, same `telegram_offset.txt`. Replies were being split between windows
at random. It half-worked because the state dir is shared, so a window that grabbed another's reply
could still find that record; but for Claude the decision was then applied to the *wrong* session,
because `ClaudeSender` writes to whatever channel that window has open.

**3. Write paths are uneven.** Bob takes a task id and reaches any task from any window. Claude cannot
be targeted: `ClaudeSender.buildInjectFn` writes to the sole open channel and returns `ambiguous:N`
otherwise, because the sessionId↔channel link was not found on the extension side. Codex and Chat have
no write path at all.

**4. Cross-machine is read-only.** Peer sessions arrive over SSH (`RemoteSessionSource`); nothing sends
into them.

Constraint 3 is the sharp one. The feature's core promise — "write to the session I picked" — is the
one capability the codebase did not have for Claude.

---

## Options considered

### How to present many sessions

| Option | Verdict |
|---|---|
| **Forum topics, one per session** | **Chosen.** The thread *is* the selection, so there is no mode state to desynchronise. Per-session unread badges, per-session scrollback, and supervision cards land beside the conversation they concern. Costs a one-time group setup with Topics and `can_manage_topics`. |
| One console message, edited in place | Cheapest, works in the existing 1:1 chat, closest to what exists. But one session in view at a time, and editing one message throws the transcript away. |
| Flat chat, one live card per session | No group needed and several sessions visible, but reply-targeting is fiddly on mobile, cards scroll away, and text with no reply is ambiguous — the exact failure to avoid. |

### Where the bot lives

| Option | Verdict |
|---|---|
| **One bot per machine** | **Chosen.** Independent update streams, so nothing is stolen. Coordination is intra-machine only — one lock file on a local filesystem. Deletes the SSH command hop, remote writes and any fleet-wide coordinator. Costs one bot per machine, with privacy mode disabled. |
| One bot, receive-only dispatcher per machine | Keeps a single bot and needs no new BotFather setup, but cross-machine still needs the SSH hop. |
| One bot per workspace window | Maximum autonomy, no coordination anywhere — but a token must exist before a window can use it, so an unprepared workspace has no presence at all. |
| One fleet-wide gateway | Keeps one bot, but is the most machinery and a single point of failure. |

### Handling the Claude targeting gap

Rather than block the design on a probe of Claude's internals, targeting is **discovered at run time**:
search for a channel carrying the wanted session id, fall back to the sole channel, refuse when
ambiguous. That covers both possible outcomes of the probe with no branch in the design, and starts
working by itself if a future Claude build exposes the id.

---

## The design

### Roles

Two independent layers. A window's behaviour depends on both.

| | Scope | Decided by |
|---|---|---|
| **Writing** to Telegram | Every window, for its own sessions | Ownership |
| **Reading** from Telegram | Exactly one window per machine | A renewable lease |

Writing needs no coordination: `sendMessage` is not exclusive and two windows own disjoint session
sets. Only reading is leased, keeping the shared component as small as constraint 1 allows.

```
                 ONE forum group
   ┌──────────────┬──────────────┬──────────────┐
   │  bot@desktop │  bot@laptop2 │  bot@builder │   independent update streams
   └──────┬───────┴──────┬───────┴──────┬───────┘
     desktop         laptop2        builder        ← no cross-machine plumbing
   ┌──┴──┬──┴──┐
   win A win B win C     one lease picks the reader; all three write freely
```

### Ownership — three tiers

Path matching alone is wrong in cases this repository creates on purpose, so:

1. **A window has it open** — from `openClaudeSessionIds` / `openBobTaskIds`, which `WindowRegistry`
   already publishes. Exact, and what makes a write land correctly.
2. **Longest containing workspace folder** — covers idle and history sessions, and gets the worktree
   case right (`<repo>/.claude/worktrees/feat` belongs to the worktree's window if one is open). A
   separator check stops `/work/app` claiming `/work/app-legacy`.
3. **Nobody** — read-only, and said so rather than silently swallowed.

Ties break on lowest pid, so every window computes the same owner without talking to the others.
Ownership is pure: the registry snapshot is a parameter.

### The bus

The reading window is usually not the owning window, so commands travel over a per-machine spool at
`~/.claude/session-sitter/bus/`, beside the existing `windows/` registry.

Commands are addressed by **session id, not by window**. The reader keeps no routing table: it drops a
file and the owner picks it up. Claiming is `rename('cmd/x.json' → 'cmd/x.taken.<pid>')` — the only
atomic claim primitive available across unrelated processes on one filesystem, so exactly one window
wins and none can steal another's work. Results are files too, because the window that applied a
command is not the window that reports to Telegram.

`newSession` is the one command addressed by pid, because the session it creates has no id yet.

A command unclaimed past its TTL is reported as having no owner — the case where typing into a topic
whose session has no live window would otherwise vanish.

### Topic state

One file per topic under `bus/topics/<threadId>.json`. Several windows write here, and a single
`topics.json` would be a lost-update race with no lock to arbitrate it; one file per thread means
writers never touch the same path.

Each record carries a `mirroredTurns` cursor, written after a successful post, so a restart resumes
instead of reposting a session's history — and a crash between post and write repeats at most one
message, which is the safe direction.

### The Telegram surface

- **General** — one pinned message, edited in place, grouped by machine then workspace. Grouped rather
  than time-sorted because an edited-in-place list must not reshuffle on every poll. Plus `/sessions`,
  `/new`, `/who`, `/help`.
- **A session topic** — named `🟡 claude · workspace / title` so the topic sidebar doubles as a status
  board. Header with path, host, session id and owning window; then turns as they happen; then
  supervision cards for that session. Buttons: *Full transcript* (a file upload, since a transcript is
  far past the 4096-char message cap) and *Focus in IDE* (reusing the panel's existing cross-window and
  cross-machine handshake).
- **Lifecycle** — auto-created for any session that needs you or is running (`approval`, `question`,
  `finished`, `working`), on demand for the quiet ones, **closed and never
  deleted** after an idle threshold, reopened if the session revives.

### One reader, two consumers

Supervision consumes inbound updates too, and constraint 1 does not stop applying just because a
second feature wants them. So when the remote interface is active it owns the read and supervision
drains a handover queue rather than calling `getUpdates`. With the interface off that path is
untouched.

Attribution is by callback payload — the only part of an update whose format each side controls.
Remote control's buttons carry an `rc|` prefix; supervision's are `<requestId>|<index>`. Text is
attributed by where it was typed: a session topic means a prompt, a reply to a live card means a
decision, General means neither.

An unattributable update goes to **supervision**. Its updates answer a question an agent is blocked
on with a timeout running, so the asymmetry matters: a misrouted remote-control message is reported
back within a second, while a swallowed supervision reply becomes a denied action minutes later.

Closing the loop the other way, a decision card for a session posts into that session's topic and
keeps its original buttons, so answering from inside the topic routes back to supervision. It falls
back to the plain channel when the session has no topic yet — normal, because a prompt can be raised
before the owning window's next pass creates one.

### Authorization

A group is not a private chat, and acting on a message means typing into a live coding agent. So
parsing is ordered chat id → sender id → content, and a message failing either of the first two checks
never reaches intent parsing. **An empty allowlist authorises nobody**: the alternative default turns a
half-finished setup into an open door, silently. Rejected ids are logged so the user can copy them in.

### The refusal

When several Claude channels are open and none carries the wanted session id, **nothing is sent**.
Delivering a prompt to the wrong agent is worse than not delivering it, because the wrong agent acts on
it. Routing to the owning window shrinks this case a lot — the count that matters is Claude sessions in
*that* window, not on the machine.

### Rate limiting as a design constraint

A bot may send on the order of 20 messages a minute to one group; a busy agent produces far more turns.
The mirror therefore posts user prompts and assistant text only — no tool-by-tool noise — and a burst
collapses to one "… N earlier turns not shown" line while the cursor advances past all of it. Queuing
instead would put the group minutes behind the sessions it reports on.

---

## Error handling

Every failure is **stated in the topic**. Silence is never the outcome.

| Failure | Behaviour |
|---|---|
| No owner for a session | Read-only, naming the machine |
| Command unclaimed past TTL | Reported into the topic, then dropped |
| Claude target ambiguous | Explicit refusal with what to do instead |
| Telegram 429 | `retry_after` honoured; the mirror batches harder |
| Chat is not a forum | Detected specifically and explained once, not as a generic API error |
| Reader window dies | Lease expires (or its pid is found dead), another window takes over and resumes from the per-topic cursor |
| Transport throws | Returned as a value; mirroring is best-effort and never blocks an agent |

Two machines sharing a token cannot be detected in-band — bots do not see each other's messages. It is
documented, and reading the token from `.env` rather than settings makes it unlikely, since Settings
Sync is the way it would otherwise happen.

---

## Testing

The codebase already had the right seam: `TelegramChannel` takes an injectable `ApiFn`, and
`buildCard` is pure and tested. Everything new follows that shape — 215 tests, no network, no live
agent:

| Area | Covered |
|---|---|
| `ownership` | three tiers, the worktree case, the `app`/`app-legacy` trap, pid tie-breaks, peer sessions |
| `lease` | acquire, renew, concurrent race, expiry takeover, dead-holder takeover, release safety |
| `bus` | round-trips, one-winner claim races, expiry, exactly-once results, temp-file safety, sweep |
| `topics` | round-trips, per-thread isolation, cross-window visibility, malformed files, close policy |
| `render` | every Telegram limit, burst collapsing, stable ordering, echo suppression |
| `intent` | the authorization boundary, refusal ordering, unknown commands, callback payload sizes |
| `forum` | not-a-forum detection, `retry_after`, General vs topic addressing, transport failures |
| `applyCommand` | per-agent routing, every refusal path, thrown senders becoming results |
| `claudeTargeting` | the injected function run against a fake manager — including all three refusals |

The inspector-based senders cannot be unit-tested; they stay behind `MessageSender` and the layer above
uses fakes. The injected Claude function is the exception: it is a JavaScript string whose `this` is
Claude's manager, so `new Function` plus a fake manager covers the part that decides which session gets
the message.

---

## What this does not do

Stated so it is not discovered later:

- **Codex and VS Code Chat cannot be written to.** Neither exposes a message API. Read-only, and their
  topics say so.
- **A machine with no bot has no interactive presence.** Its sessions still list, read-only, via
  existing SSH peer discovery.
- **`/new` cannot confirm a session started.** Neither agent returns an id until the CLI writes its
  first record, so it reports that the window was opened and the topic follows a poll or two later.
- **History is not mirrored by default.** Weeks of sessions would be hundreds of topics; idle sessions
  get a topic on demand.
