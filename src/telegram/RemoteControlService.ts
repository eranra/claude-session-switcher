/**
 * Telegram remote control, as it runs inside one VS Code window.
 *
 * Every window runs one of these. What a given window does depends on two independent facts:
 *
 *  - **Which sessions it owns** (`ownership.ts`) — it mirrors those into topics and applies commands
 *    aimed at them. This is the per-window responsibility the feature is built around.
 *  - **Whether it holds the reader lease** (`lease.ts`) — exactly one window per machine reads
 *    `getUpdates`, because a bot token has one destructive update stream. The reader also renders
 *    the General list and reports command results.
 *
 * Writing is not leased. Each window posts its own sessions' messages, so nothing is centralised
 * that does not have to be.
 *
 * ## The loop
 *
 * One self-scheduling pass, not a fixed interval, because `getUpdates` long-polls and overlapping
 * passes would double-consume updates — the same reason `SupervisionService` is written this way.
 * Each pass: refresh the lease, mirror owned sessions, take bus commands for owned sessions, and
 * (as reader) poll Telegram, route intents, and report results.
 *
 * ## What it will not do
 *
 * It never sends a message to a session it cannot positively identify. A prompt delivered to the
 * wrong agent is worse than one not delivered, because the wrong agent acts on it. Where targeting
 * is impossible the user is told, in the topic, with the reason.
 */

import * as os from 'os';
import type { ClaudeSession, SessionManager } from '../SessionManager';
import type { MessageSender } from '../agents/BobSender';
import { readLiveWindows, type WindowEntry } from '../WindowRegistry';
import type { ApiFn } from '../supervisor/telegram';
import {
  applyCommand, commandIsMine, type SessionLauncher, type TargetedClaudeSender,
} from './applyCommand';
import {
  claimCommand, dropCommand, expiredCommands, newCommandId, postCommand, postResult,
  readPendingCommands, takeResults, leasePath, sweep, type BusCommand,
} from './bus';
import { idleCloseMs, startupBlocker, type RemoteControlConfig } from './config';
import { ForumApi, type ReplyMarkup } from './forum';
import { classifyUpdate, decodeCallback, encodeCallback, type Intent } from './intent';
import { ReaderLease, LEASE_RENEW_MS } from './lease';
import { resolveOwner, resolveOwners, writeBlockedReason, type Ownership } from './ownership';
import {
  deservesTopic, planMirror, renderFleetList, renderHelp, renderTopicHeader, renderWho, topicName,
  type ListEntry,
} from './render';
import { TopicStore, topicsToClose, type TopicRecord } from './topics';
import { routeUpdate } from './updateRouter';

/** Seconds `getUpdates` waits before returning empty, so a tap arrives near-instantly. */
const LONG_POLL_SECONDS = 10;
/** Pause between passes when this window is not the reader (nothing to long-poll on). */
const IDLE_PASS_MS = 3_000;
/** Abandoned command and result files older than this are swept. */
const SWEEP_AFTER_MS = 10 * 60_000;
/** Sent texts remembered per session, so the mirror does not echo them back. */
const ECHO_MEMORY = 5;

export interface RemoteControlDeps {
  config: RemoteControlConfig;
  sessionManager: SessionManager;
  bobSender: MessageSender;
  claudeSender: TargetedClaudeSender;
  launcher: SessionLauncher;
  api: ApiFn;
  log: (msg: string) => void;
  pid?: number;
  hostname?: string;
  homedir?: string;
  now?: () => number;
  /**
   * Where to put updates that belong to supervision rather than to this feature.
   *
   * This feature owns the single read on the bot token, so supervision cannot poll for itself
   * without the two stealing each other's replies. Supplying this sink is what lets both run on one
   * token in one window; `updateRouter.ts` decides which side each update belongs to.
   */
  supervisionSink?: (update: Record<string, unknown>) => void;
  /**
   * Message ids of supervision cards currently awaiting an answer, so a reply to one is recognised
   * as a decision rather than treated as text for a session.
   *
   * Without it, answering a card by replying to it *inside* a session topic would be read as a prompt
   * and typed into the agent instead of resolving the decision.
   */
  supervisionMessageIds?: () => Promise<ReadonlySet<string>>;
}

export class RemoteControlService {
  private readonly forum: ForumApi;
  private readonly topics: TopicStore;
  private readonly lease: ReaderLease;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running = false;

  /** Update offset for `getUpdates`. Held in memory by the reader; a handover re-reads from 0+1. */
  private offset = 0;
  /** The General list message, so it is edited rather than reposted. */
  private listMessageId: number | undefined;
  /** Sessions shown in the last rendered list, so a button index resolves back to a session. */
  private lastListed: ClaudeSession[] = [];
  /** Workspaces offered by the last `/new` menu, indexed the same way. */
  private lastNewMenu: Array<{ workspace: string; pid: number }> = [];
  /** Text recently injected per session, so the mirror does not echo the user's own prompt. */
  private readonly recentlySent = new Map<string, string[]>();
  /** True once a non-forum group has been reported, so it is said once and not every pass. */
  private warnedNotAForum = false;
  private lastSweep = 0;

  constructor(private readonly deps: RemoteControlDeps) {
    this.pid = deps.pid ?? process.pid;
    this.hostname = deps.hostname ?? os.hostname();
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
    this.forum = new ForumApi(deps.api, deps.config.chatId, deps.log);
    this.topics = new TopicStore(deps.homedir);
    this.lease = new ReaderLease({
      leasePath: leasePath(deps.homedir),
      pid: this.pid,
      host: this.hostname,
      now: this.now,
      log: deps.log,
    });
  }

  /** Start the loop, or explain why it cannot start. Never throws. */
  start(): void {
    const blocker = startupBlocker(this.deps.config);
    if (!this.deps.config.enabled) {
      this.log('remote control: disabled (sessionSitter.telegram.remoteControl=false)');
      return;
    }
    if (blocker !== null) {
      this.log(`remote control: not started — ${blocker}`);
      return;
    }
    this.log(
      `remote control: started on ${this.hostname} pid ${this.pid} — `
      + `chat=${this.deps.config.chatId} authorised=${this.deps.config.allowedUserIds.length}`,
    );
    this.schedule(0);
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    void this.lease.release();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) { return; }
    this.timer = setTimeout(() => { void this.pass(); }, delayMs);
  }

  /**
   * One full pass. A single failing pass must never kill the loop — a thrown error here would stop
   * every message being consumed, and every session going quiet, with nothing to say why.
   */
  private async pass(): Promise<void> {
    if (this.stopped || this.running) { return; }
    this.running = true;
    let isReader = false;
    try {
      isReader = await this.lease.tryAcquire();
      const windows = await readLiveWindows({ homedir: this.deps.homedir });
      const sessions = this.deps.sessionManager.getSessions();
      const owners = resolveOwners(sessions, windows);

      await this.mirrorOwnedSessions(sessions, owners);
      await this.applyMyCommands(sessions, owners);
      if (isReader) {
        await this.readerPass(sessions, owners, windows);
      }
      await this.maybeSweep();
    } catch (err) {
      this.log(`remote control: pass error (continuing): ${String(err)}`);
    } finally {
      this.running = false;
      // The reader's long poll already blocked inside the pass, so it comes straight back.
      this.schedule(isReader ? 0 : IDLE_PASS_MS);
    }
  }

  // ------------------------------------------------------------------ mirroring (every window)

  /**
   * Keep a topic for each session this window owns, and append its new turns.
   *
   * Only *active* sessions get a topic created automatically — an idle history session gets one on
   * demand, because auto-creating for everything would put weeks of history in the sidebar and make
   * the group unusable.
   */
  private async mirrorOwnedSessions(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    const mine = sessions.filter(s => owners.get(s.sessionId)?.pid === this.pid);
    for (const session of mine) {
      const existing = await this.topics.bySession(session.sessionId);
      if (existing === null) {
        if (!deservesTopic(session.status)) { continue; } // quiet history: on demand only
        await this.createTopicFor(session, owners.get(session.sessionId));
        continue;
      }
      await this.refreshTopic(session, existing);
    }
    await this.closeIdleTopics();
  }

  /** Create the topic and post its header. Returns the record, or null when creation failed. */
  private async createTopicFor(
    session: ClaudeSession, owner: Ownership | undefined,
  ): Promise<TopicRecord | null> {
    const name = topicName(session);
    const created = await this.forum.createTopic(name);
    if (!created.ok) {
      if (created.notAForum === true && !this.warnedNotAForum) {
        this.warnedNotAForum = true;
        this.log(
          'remote control: this chat is not a forum, so per-session topics cannot be created. '
          + 'Enable Topics in the group settings; the session list still works.',
        );
        await this.forum.send(
          'Topics are not enabled in this group, so each session cannot get its own thread. '
          + 'Turn on Topics in the group settings and the sessions will appear as threads.',
          null,
        );
      } else {
        this.log(`remote control: createTopic failed for ${session.sessionId}: ${created.error}`);
      }
      return null;
    }
    const resolved = owner ?? { pid: null, basis: 'none' as const, workspace: '' };
    const record: TopicRecord = {
      threadId: created.value,
      sessionId: session.sessionId,
      source: session.source,
      name,
      // Start the cursor at the current transcript length: a topic created now is a window onto
      // what happens next, not a replay of everything that already happened.
      mirroredTurns: (await this.turnsOf(session.sessionId)).length,
      closed: false,
      lastActivityAt: session.updatedAt.getTime(),
      createdAt: this.now(),
    };
    await this.topics.save(record);
    await this.forum.send(
      renderTopicHeader(session, resolved, writeBlockedReason(session, resolved)),
      record.threadId,
      this.sessionButtons(session),
    );
    this.log(`remote control: topic ${record.threadId} created for ${session.sessionId}`);
    return record;
  }

  /** Post new turns, rename on a status change, and reopen a topic whose session came back. */
  private async refreshTopic(session: ClaudeSession, record: TopicRecord): Promise<void> {
    let changed = false;

    if (record.closed && deservesTopic(session.status)) {
      const reopened = await this.forum.reopenTopic(record.threadId);
      if (reopened.ok) { record.closed = false; changed = true; }
    }

    const wanted = topicName(session);
    if (wanted !== record.name) {
      const renamed = await this.forum.renameTopic(record.threadId, wanted);
      if (renamed.ok) { record.name = wanted; changed = true; }
    }

    const turns = await this.turnsOf(session.sessionId);
    const plan = planMirror(turns, record.mirroredTurns);
    const sentTexts = this.recentlySent.get(session.sessionId) ?? [];
    for (const message of plan.messages) {
      // Skip the echo of a prompt this window just injected — it is already visible as the user's
      // own Telegram message, and posting it again reads as a duplicate send.
      const body = message.replace(/^🧑 /, '');
      if (message.startsWith('🧑 ') && sentTexts.some(s => s.trim() === body.trim())) { continue; }
      const posted = await this.forum.send(message, record.threadId);
      if (!posted.ok) {
        this.log(`remote control: mirror post failed on ${record.threadId}: ${posted.error}`);
        // Leave the cursor where it is so the turn is retried, unless we are being rate limited —
        // in which case retrying the same turn forever would wedge the topic.
        if (posted.retryAfterSeconds === undefined) { return; }
      }
    }
    if (plan.nextCursor !== record.mirroredTurns) {
      record.mirroredTurns = plan.nextCursor;
      changed = true;
    }
    if (record.lastActivityAt !== session.updatedAt.getTime()) {
      record.lastActivityAt = session.updatedAt.getTime();
      changed = true;
    }
    if (changed) { await this.topics.save(record); }
  }

  /** Close topics whose sessions have been quiet. Closed, never deleted — scrollback survives. */
  private async closeIdleTopics(): Promise<void> {
    const all = await this.topics.all();
    const stale = topicsToClose(all, this.now(), idleCloseMs(this.deps.config));
    for (const record of stale) {
      const closed = await this.forum.closeTopic(record.threadId);
      if (closed.ok) {
        record.closed = true;
        await this.topics.save(record);
        this.log(`remote control: closed idle topic ${record.threadId}`);
      }
    }
  }

  private async turnsOf(sessionId: string) {
    try {
      return await this.deps.sessionManager.getRecentExchanges(sessionId);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ commands (every window)

  /** Take and run any bus command aimed at a session this window owns. */
  private async applyMyCommands(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    const pending = await readPendingCommands(this.deps.homedir);
    if (pending.length === 0) { return; }
    const ownedIds = new Set(
      sessions.filter(s => owners.get(s.sessionId)?.pid === this.pid).map(s => s.sessionId));

    for (const cmd of pending) {
      if (!commandIsMine(cmd, this.pid, ownedIds)) { continue; }
      if (!await claimCommand(cmd.cmdId, this.pid, this.deps.homedir)) { continue; }
      if (cmd.kind === 'sendText') { this.rememberSent(cmd.sessionId, cmd.text); }
      const result = await applyCommand(cmd, {
        pid: this.pid,
        bobSender: this.deps.bobSender,
        claudeSender: this.deps.claudeSender,
        launcher: this.deps.launcher,
        now: this.now,
        log: this.log,
      });
      await postResult(result, this.deps.homedir);
    }
  }

  private rememberSent(sessionId: string, text: string): void {
    const list = this.recentlySent.get(sessionId) ?? [];
    list.push(text);
    while (list.length > ECHO_MEMORY) { list.shift(); }
    this.recentlySent.set(sessionId, list);
  }

  // ------------------------------------------------------------------ reader only

  private async readerPass(
    sessions: ClaudeSession[], owners: Map<string, Ownership>, windows: WindowEntry[],
  ): Promise<void> {
    await this.reportResults();
    await this.reportUnroutable();
    await this.pollUpdates(sessions, owners, windows);
  }

  /** Post each finished command's outcome into the topic it came from. */
  private async reportResults(): Promise<void> {
    for (const result of await takeResults(this.deps.homedir)) {
      const prefix = result.ok ? '✅' : '⚠';
      await this.forum.send(`${prefix} ${result.detail}`, result.threadId || null);
    }
  }

  /**
   * Report commands nobody claimed.
   *
   * This is the case where the user typed into a topic whose session has no live window — the
   * message would otherwise just disappear. Saying so is the whole point.
   */
  private async reportUnroutable(): Promise<void> {
    const pending = await readPendingCommands(this.deps.homedir);
    for (const cmd of expiredCommands(pending, this.now())) {
      await dropCommand(cmd.cmdId, this.deps.homedir);
      await this.forum.send(
        '⚠ No open window is responsible for that session, so nothing was sent. '
        + 'Open its workspace in VS Code and try again.',
        cmd.threadId || null,
      );
    }
  }

  private async pollUpdates(
    sessions: ClaudeSession[], owners: Map<string, Ownership>, windows: WindowEntry[],
  ): Promise<void> {
    let resp: Record<string, unknown>;
    try {
      resp = await this.deps.api('getUpdates', {
        offset: this.offset + 1, timeout: LONG_POLL_SECONDS,
      });
    } catch (err) {
      // Surfaced, never swallowed: a silent getUpdates failure is indistinguishable from an idle
      // chat, so every message would appear to be ignored with no explanation anywhere.
      this.log(`remote control: getUpdates failed: ${String(err)}`);
      await new Promise(resolve => setTimeout(resolve, LEASE_RENEW_MS));
      return;
    }
    const updates = Array.isArray(resp.result) ? resp.result : [];
    if (updates.length === 0) { return; }

    // This window holds the ONLY read on this token, so supervision's updates arrive here too and
    // have to be handed on. Attribution is by callback prefix and by where a message was typed —
    // see `updateRouter.ts`.
    const sessionThreadIds = new Set((await this.topics.all()).map(t => t.threadId));
    let supervisionMessageIds: ReadonlySet<string> = new Set<string>();
    try {
      supervisionMessageIds = await this.deps.supervisionMessageIds?.() ?? new Set<string>();
    } catch (err) {
      // An unreadable record store must not stop updates being routed; the worst case is one card
      // answered by a text reply being treated as a prompt.
      this.log(`remote control: could not read live supervision cards: ${String(err)}`);
    }

    for (const raw of updates) {
      const update = (raw ?? {}) as Record<string, unknown>;
      const id = typeof update.update_id === 'number' ? update.update_id : this.offset;
      this.offset = Math.max(this.offset, id);

      if (routeUpdate(update, { sessionThreadIds, supervisionMessageIds }) === 'supervision') {
        if (this.deps.supervisionSink !== undefined) {
          this.deps.supervisionSink(update);
        }
        continue;
      }

      const intent = classifyUpdate(update, {
        chatId: this.deps.config.chatId,
        allowedUserIds: this.deps.config.allowedUserIds,
      });
      await this.handleIntent(intent, sessions, owners, windows);
    }
  }

  private async handleIntent(
    intent: Intent,
    sessions: ClaudeSession[],
    owners: Map<string, Ownership>,
    windows: WindowEntry[],
  ): Promise<void> {
    switch (intent.kind) {
      case 'ignore':
        return;

      case 'unauthorized':
        // Logged with the id and nothing else. The id is what the user needs in order to add
        // someone; the message body is not ours to read.
        this.log(
          `remote control: ignored a message from unauthorised Telegram user ${intent.userId}. `
          + 'Add it to sessionSitter.telegram.allowedUserIds to permit it.',
        );
        return;

      case 'help':
        await this.forum.send(renderHelp(), null);
        return;

      case 'listSessions':
        await this.renderList(sessions, owners);
        return;

      case 'who':
        await this.forum.send(renderWho(this.entriesOf(sessions, owners), this.hostname), null);
        return;

      case 'newSessionMenu':
        await this.sendNewMenu(windows);
        return;

      case 'sendToTopic':
        await this.routeTopicText(intent.threadId, intent.text, sessions, owners);
        return;

      case 'unroutableText':
        await this.forum.send(
          'That was sent to General, which is not a session. Open a session topic and type there, '
          + 'or use /sessions to see what is running.',
          null,
        );
        return;

      case 'callback':
        await this.handleCallback(intent, sessions, owners, windows);
        return;
    }
  }

  private entriesOf(sessions: ClaudeSession[], owners: Map<string, Ownership>): ListEntry[] {
    return sessions.map(session => ({
      session,
      owner: owners.get(session.sessionId) ?? { pid: null, basis: 'none' as const, workspace: '' },
    }));
  }

  /** Render (or edit) the single General list message. */
  private async renderList(
    sessions: ClaudeSession[], owners: Map<string, Ownership>,
  ): Promise<void> {
    this.lastListed = sessions.slice(0, 24); // button indexes address this snapshot
    const body = renderFleetList(this.entriesOf(this.lastListed, owners), this.hostname, this.now());
    const markup = this.listButtons();
    if (this.listMessageId !== undefined) {
      const edited = await this.forum.edit(this.listMessageId, body, markup);
      if (edited.ok) { return; }
      // The message may have been deleted in the app; fall through and post a fresh one.
      this.listMessageId = undefined;
    }
    const sent = await this.forum.send(body, null, markup);
    if (sent.ok) {
      this.listMessageId = sent.value;
      await this.forum.pin(sent.value);
    }
  }

  private listButtons(): ReplyMarkup {
    const rows = this.lastListed.slice(0, 8).map((session, index) => ([{
      text: `${session.projectName} / ${session.title}`.slice(0, 40),
      callback_data: encodeCallback({ kind: 'openSession', index }),
    }]));
    rows.push([
      { text: '⟳ Refresh', callback_data: encodeCallback({ kind: 'refresh' }) },
      { text: '＋ New', callback_data: encodeCallback({ kind: 'newMenu' }) },
    ]);
    return { inline_keyboard: rows };
  }

  private sessionButtons(session: ClaudeSession): ReplyMarkup {
    return {
      inline_keyboard: [[
        { text: '📄 Full transcript', callback_data: encodeCallback({ kind: 'transcript', sessionId: session.sessionId }) },
      ], [
        { text: '👁 Focus in IDE', callback_data: encodeCallback({ kind: 'focus', sessionId: session.sessionId }) },
      ]],
    };
  }

  /**
   * `/new` — one button per (workspace, window) on this machine.
   *
   * The list comes from the live window registry rather than a configured allowlist: a window is
   * what makes a workspace controllable, so this cannot offer a target that nothing could run.
   */
  private async sendNewMenu(windows: WindowEntry[]): Promise<void> {
    this.lastNewMenu = [];
    for (const w of windows) {
      for (const folder of w.workspaceFolders) {
        if (!this.lastNewMenu.some(e => e.workspace === folder)) {
          this.lastNewMenu.push({ workspace: folder, pid: w.pid });
        }
      }
    }
    if (this.lastNewMenu.length === 0) {
      await this.forum.send('No VS Code window is open on this machine, so there is nowhere to start a session.', null);
      return;
    }
    const rows = this.lastNewMenu.slice(0, 8).flatMap((entry, index) => {
      const name = entry.workspace.split(/[/\\]/).pop() ?? entry.workspace;
      return [[
        { text: `claude · ${name}`.slice(0, 40), callback_data: encodeCallback({ kind: 'launch', index, source: 'claude' }) },
        { text: `bob · ${name}`.slice(0, 40), callback_data: encodeCallback({ kind: 'launch', index, source: 'bob' }) },
      ]];
    });
    await this.forum.send('Start a new session where?', null, { inline_keyboard: rows });
  }

  /**
   * Free text typed in a session topic.
   *
   * When this window owns the session it could act directly, but the command still goes on the bus:
   * one path means one place where claiming, results and reporting are handled, and the owner picks
   * its own command up on the same pass.
   */
  private async routeTopicText(
    threadId: number,
    text: string,
    sessions: ClaudeSession[],
    owners: Map<string, Ownership>,
  ): Promise<void> {
    const record = await this.topics.byThread(threadId);
    if (record === null) {
      await this.forum.send(
        'This topic is not linked to a session, so there is nothing to send to. '
        + 'Use /sessions in General to pick one.',
        threadId);
      return;
    }
    const session = sessions.find(s => s.sessionId === record.sessionId);
    if (session === undefined) {
      await this.forum.send(
        'That session no longer exists, so nothing was sent.', threadId);
      return;
    }
    const owner = owners.get(session.sessionId) ?? { pid: null, basis: 'none' as const, workspace: '' };
    const blocked = writeBlockedReason(session, owner);
    if (blocked !== null) {
      await this.forum.send(`⚠ ${blocked}`, threadId);
      return;
    }
    await postCommand({
      cmdId: newCommandId(),
      kind: 'sendText',
      sessionId: session.sessionId,
      source: session.source,
      text,
      threadId,
      issuedAt: this.now(),
    }, this.deps.homedir);
  }

  private async handleCallback(
    intent: Extract<Intent, { kind: 'callback' }>,
    sessions: ClaudeSession[],
    owners: Map<string, Ownership>,
    windows: WindowEntry[],
  ): Promise<void> {
    const cb = decodeCallback(intent.data);
    await this.forum.answerCallback(intent.callbackId, 'Working…');
    switch (cb.kind) {
      case 'refresh':
        await this.renderList(sessions, owners);
        return;

      case 'newMenu':
        await this.sendNewMenu(windows);
        return;

      case 'history': {
        const idle = sessions.filter(s => !deservesTopic(s.status)).slice(0, 20);
        this.lastListed = idle;
        await this.forum.send(
          renderFleetList(this.entriesOf(idle, owners), this.hostname, this.now()),
          null,
          this.listButtons());
        return;
      }

      case 'openSession': {
        const session = this.lastListed[cb.index];
        if (session === undefined) {
          await this.forum.send('That list is out of date — use /sessions again.', null);
          return;
        }
        const existing = await this.topics.bySession(session.sessionId);
        if (existing !== null) {
          if (existing.closed) { await this.forum.reopenTopic(existing.threadId); }
          await this.forum.send('Here.', existing.threadId);
          return;
        }
        const owner = owners.get(session.sessionId);
        // Only its owner may create the topic, so the window that mirrors it is the window that
        // made it. A session with no owner gets one from the reader, read-only.
        if (owner?.pid === this.pid || owner?.pid === null || owner === undefined) {
          const created = await this.createTopicFor(session, owner);
          if (created === null) {
            await this.forum.send('Could not create a topic for that session.', null);
          }
        } else {
          await this.forum.send(
            `That session belongs to the window with pid ${owner.pid}; its topic will appear shortly.`,
            null);
        }
        return;
      }

      case 'launch': {
        const target = this.lastNewMenu[cb.index];
        if (target === undefined) {
          await this.forum.send('That menu is out of date — use /new again.', null);
          return;
        }
        await postCommand({
          cmdId: newCommandId(),
          kind: 'newSession',
          sessionId: '',
          source: cb.source,
          text: target.workspace,
          targetPid: target.pid,
          threadId: 0,
          issuedAt: this.now(),
        }, this.deps.homedir);
        return;
      }

      case 'focus': {
        const session = sessions.find(s => s.sessionId === cb.sessionId);
        if (session === undefined) { return; }
        const record = await this.topics.bySession(cb.sessionId);
        await postCommand({
          cmdId: newCommandId(),
          kind: 'focus',
          sessionId: cb.sessionId,
          source: session.source,
          text: '',
          threadId: record?.threadId ?? 0,
          issuedAt: this.now(),
        }, this.deps.homedir);
        return;
      }

      case 'transcript':
        await this.sendTranscript(cb.sessionId, intent.threadId);
        return;

      case 'closeTopic': {
        const closed = await this.forum.closeTopic(cb.threadId);
        if (closed.ok) {
          const record = await this.topics.byThread(cb.threadId);
          if (record !== null) { record.closed = true; await this.topics.save(record); }
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * Deliver a full transcript.
   *
   * A transcript is far past Telegram's 4096-character message limit, so it has to be a file
   * upload — which needs multipart/form-data that the JSON `ApiFn` cannot express. Without an
   * uploader wired in, the user is told so rather than getting silence.
   */
  private async sendTranscript(sessionId: string, threadId: number | null): Promise<void> {
    let markdown: string | null = null;
    try {
      markdown = await this.deps.sessionManager.exportFullTranscript(sessionId);
    } catch (err) {
      this.log(`remote control: transcript export failed for ${sessionId}: ${String(err)}`);
    }
    if (markdown === null) {
      await this.forum.send('Could not export that transcript.', threadId);
      return;
    }
    const sent = await this.forum.sendDocument(
      threadId, `${sessionId}.md`, markdown, 'Full transcript', this.uploader());
    if (!sent.ok) {
      this.log(`remote control: transcript upload failed: ${sent.error}`);
      await this.forum.send(
        'Could not upload the transcript file. It is available from the Sessions panel.', threadId);
    }
  }

  /**
   * Multipart uploader for `sendDocument`, built from the bot token.
   *
   * Separate from `ApiFn` because that abstraction is JSON-only, and widening it would touch the
   * supervision channel for no benefit there.
   */
  private uploader(): ((form: FormData) => Promise<Record<string, unknown>>) | undefined {
    const token = this.deps.config.botToken;
    if (!token) { return undefined; }
    return async (form: FormData) => {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST', body: form,
      });
      return await resp.json() as Record<string, unknown>;
    };
  }

  private async maybeSweep(): Promise<void> {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_AFTER_MS) { return; }
    this.lastSweep = now;
    await sweep(SWEEP_AFTER_MS, now, this.deps.homedir);
  }

  /**
   * Post a supervision card into its own session's topic when one exists.
   *
   * Called by the extension so a decision about a session appears beside the conversation with that
   * session, rather than in one undifferentiated feed. Returns false when there is no topic, and
   * the caller falls back to the existing channel.
   */
  async postToSessionTopic(sessionId: string, text: string): Promise<boolean> {
    if (!this.deps.config.enabled) { return false; }
    const record = await this.topics.bySession(sessionId);
    if (record === null) { return false; }
    const sent = await this.forum.send(text, record.threadId);
    return sent.ok;
  }

  /** Ownership of one session, for callers that need to know before acting. */
  ownerOf(session: ClaudeSession, windows: WindowEntry[]): Ownership {
    return resolveOwner(session, windows);
  }

  /** Publish a command from outside the loop (used by the debug command). */
  async issue(cmd: BusCommand): Promise<void> {
    await postCommand(cmd, this.deps.homedir);
  }
}
