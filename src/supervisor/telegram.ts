/**
 * Real Telegram Bot API channel: decision cards with icon + description + choices + timer.
 *
 * Ported from the Python supervisor (`telegram.py`. Uses `fetch` (Node 18+) — no new dependency.
 *
 * - `send(record, notification, interactive=true)`: an ORANGE/RED decision goes out as an
 *   interactive card (inline-keyboard choices + "reply with text" + a countdown). GREEN/YELLOW
 *   go out non-interactively as a one-way update card.
 * - `pollResponses(pending)`: correlates button taps (callback_data `<requestId>|<idx>`) and
 *   text replies back to the pending records, so the user's answer drives the next decision.
 * - `refreshTimers(pending)`: best-effort `editMessageText` to tick the countdown down.
 *
 * Card and keyboard building are pure functions so they are testable without any network; the
 * HTTP call is a single injectable `api` callable.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DeliveryError,
  InboundResponse,
  MessagingChannel,
  SendResult,
  SUPERVISOR_LABEL,
} from './messaging';
import { SupervisionRecord, SupervisionState } from './models';
import { sessionRefLine } from './sessionIdentity';
import { Clock, minutesUntil, nowUtc, toIso } from './timeutil';

export const LIGHT_ICON: Record<string, string> = {
  green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴',
};
export const DEFAULT_OPTIONS = ['✅ Approve', '⛔ Reject'];

/**
 * A text message that is not a reply to a live decision card is a general instruction from the
 * user — forward it straight to the active agent session (correlationId set to this sentinel).
 */
export const ACTIVE_SESSION = '@active';

/** api(method, payload) -> parsed JSON. Injectable for tests. */
export type ApiFn = (method: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface ReplyMarkup {
  inline_keyboard: InlineButton[][];
}

export function optionsFor(record: SupervisionRecord): string[] {
  const a = record.assessment ?? {};
  // Keep button labels short so they render cleanly and reliably as inline buttons.
  const raw = Array.isArray(a.human_options) ? a.human_options : [];
  const opts = raw
    .map(o => String(o).trim().slice(0, 28))
    .filter(o => o.length > 0);
  return opts.length ? opts.slice(0, 4) : DEFAULT_OPTIONS;
}

function timerLine(minutesLeft: number | null, deadlineIso: string | null): string {
  if (minutesLeft === null) { return '⏳ Waiting for your decision.'; }
  const until = deadlineIso ? ` (until ${deadlineIso.slice(11, 16)} UTC)` : '';
  return `⏳ ${Math.max(0, minutesLeft)} min to respond${until} — no reply → safe fallback.`;
}

/** Return [text, replyMarkup]. `replyMarkup` is null for a one-way update. */
export function buildCard(
  record: SupervisionRecord,
  notification: string,
  opts: { interactive?: boolean; minutesLeft?: number | null; deadlineIso?: string | null } = {},
): [string, ReplyMarkup | null] {
  const interactive = opts.interactive ?? true;
  const minutesLeft = opts.minutesLeft ?? null;
  const deadlineIso = opts.deadlineIso ?? null;

  const a = record.assessment ?? {};
  const light = String(a.traffic_light ?? '');
  const icon = LIGHT_ICON[light] ?? '';
  const summary = String(a.summary ?? '').trim();
  const userIntent = String(a.user_intent ?? '').trim();
  const agentIntent = String(a.agent_intent ?? '').trim();
  const header = `${icon} ${light.toUpperCase()} — ${summary}`.replace(/^[\s—]+|[\s—]+$/g, '');
  const lines: string[] = [
    header,
    '',
    `${SUPERVISOR_LABEL} ${interactive ? 'decision needed' : 'update'}`,
    sessionRefLine(record),
  ];
  if (userIntent) { lines.push(`🧑 request: ${userIntent}`); }
  if (agentIntent) { lines.push(`🤖 wants to: ${agentIntent}`); }
  if (interactive) { lines.push(`reply id: ${record.request_id}`); }
  lines.push('', notification.trim());
  let text = lines.join('\n').trim();

  if (!interactive) { return [text, null]; }

  const options = optionsFor(record);
  const keyboard: InlineButton[][] = options.map((o, i) => (
    [{ text: o, callback_data: `${record.request_id}|${i}` }]
  ));
  text = `${text}\n\n${timerLine(minutesLeft, deadlineIso)}\nOr reply with text.`;
  return [text, { inline_keyboard: keyboard }];
}

/**
 * Toggle a label into `draft.answers[qkey]`. Single-select replaces the list; multi-select adds
 * the label, or removes it when already present. Mutates and returns the draft (as the original
 * did, so a caller can keep the same object identity).
 */
export function applyToggle(
  draft: { answers?: Record<string, string[]> },
  qkey: string,
  label: string,
  multi: boolean,
): { answers: Record<string, string[]> } {
  if (!draft.answers) { draft.answers = {}; }
  const answers = draft.answers;
  const current = [...(answers[qkey] ?? [])];
  if (!multi) {
    answers[qkey] = [label];
  } else if (current.includes(label)) {
    answers[qkey] = current.filter(x => x !== label);
  } else {
    answers[qkey] = [...current, label];
  }
  return draft as { answers: Record<string, string[]> };
}

/** Resolve a `q<idx>` + option index to its label from the record's question spec. */
export function questionOptionLabel(
  record: SupervisionRecord, qkey: string, optidx: string,
): string | null {
  if (!/^q\d+$/.test(qkey) || !/^\d+$/.test(optidx)) { return null; }
  const spec = record.question_spec ?? {};
  const questions = Array.isArray(spec.questions) ? spec.questions : [];
  const qi = Number(qkey.slice(1));
  const oi = Number(optidx);
  if (qi >= questions.length) { return null; }
  const q = questions[qi] as Record<string, unknown>;
  const options = Array.isArray(q?.options) ? q.options : [];
  if (oi >= options.length) { return null; }
  const opt = options[oi];
  if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
    return String((opt as Record<string, unknown>).label ?? '');
  }
  return String(opt);
}

/**
 * Render a (possibly multi-question / multi-select) question as toggle buttons plus a Submit
 * button. callback_data: `<rid>|q<idx>|<optidx>` per option, `<rid>|__submit` to commit. A ✓
 * marks a currently-chosen option (read from the answer draft).
 */
export function buildQuestionCard(record: SupervisionRecord): [string, ReplyMarkup] {
  const spec = record.question_spec ?? {};
  const draftAnswers = ((record.question_answer ?? {}).answers ?? {}) as Record<string, string[]>;
  const rid = record.request_id;
  const lines: string[] = [
    `❓ QUESTION — ${String(spec.prompt ?? '').slice(0, 80)}`.replace(/[\s—]+$/, ''),
    '',
    sessionRefLine(record),
  ];
  const keyboard: InlineButton[][] = [];
  const questions = Array.isArray(spec.questions) ? spec.questions : [];
  questions.forEach((qRaw, qi) => {
    const q = (qRaw ?? {}) as Record<string, unknown>;
    const qkey = `q${qi}`;
    const tag = q.multi_select ? ' [multi]' : '';
    lines.push(`\n${String(q.header || `Q${qi + 1}`)}: ${String(q.question ?? '')}${tag}`);
    const chosen = new Set(draftAnswers[qkey] ?? []);
    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((optRaw, oi) => {
      const label = (optRaw && typeof optRaw === 'object' && !Array.isArray(optRaw))
        ? String((optRaw as Record<string, unknown>).label ?? '')
        : String(optRaw);
      const mark = chosen.has(label) ? '✓ ' : '';
      keyboard.push([{ text: `${mark}${label}`, callback_data: `${rid}|${qkey}|${oi}` }]);
    });
  });
  keyboard.push([{ text: '✅ Submit answers', callback_data: `${rid}|__submit` }]);
  return [lines.join('\n'), { inline_keyboard: keyboard }];
}

/**
 * The real Bot API transport. Exported so the remote-control feature drives the same HTTP path —
 * including the timeout that must outlast a long poll — instead of growing a second one that
 * would drift from it.
 */
export function defaultApi(token: string): ApiFn {
  const base = `https://api.telegram.org/bot${token}`;
  return async (method, payload) => {
    // Must exceed the getUpdates long-poll timeout so the socket doesn't close mid-wait.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const resp = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return await resp.json() as Record<string, unknown>;
    } catch (err) {
      throw new DeliveryError(`telegram ${method} failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface TelegramChannelOptions {
  token: string;
  chatId: string;
  offsetPath: string;
  timeoutMinutes?: number;
  api?: ApiFn;
  clock?: Clock;
  /**
   * Long-poll seconds. Makes getUpdates return the INSTANT a tap/reply arrives (so end-to-end
   * is sub-second), while still returning after N seconds when idle so timeouts get checked.
   */
  longPollSeconds?: number;
  log?: (msg: string) => void;
  /**
   * Take updates from here instead of calling `getUpdates`.
   *
   * A bot token has ONE update stream and reading it is destructive, so when the Telegram remote
   * control is active it owns the read and forwards this channel the updates that belong to
   * supervision. Two pollers on one token would each see a random half of the replies — which is the
   * defect the remote control's reader lease exists to prevent, and it would be pointless to
   * reintroduce it here.
   *
   * When set, offset tracking is the source's responsibility: this channel must not advance an offset
   * for updates it did not fetch.
   */
  updateSource?: () => Array<Record<string, unknown>>;
}

export class TelegramChannel implements MessagingChannel {
  private readonly chatId: string;
  private readonly offsetPath: string;
  private readonly timeoutMinutes: number;
  private readonly api: ApiFn;
  private readonly clock: Clock;
  private readonly longPoll: number;
  private readonly log: (msg: string) => void;
  private readonly updateSource: (() => Array<Record<string, unknown>>) | undefined;

  constructor(opts: TelegramChannelOptions) {
    this.updateSource = opts.updateSource;
    this.chatId = opts.chatId;
    this.offsetPath = opts.offsetPath;
    this.timeoutMinutes = opts.timeoutMinutes ?? 30;
    this.api = opts.api ?? defaultApi(opts.token);
    this.clock = opts.clock ?? nowUtc;
    this.longPoll = opts.longPollSeconds ?? 0;
    this.log = opts.log ?? (() => { /* silent */ });
  }

  /** Clear any stale webhook so getUpdates works (a webhook makes it 409). Best-effort. */
  async ensurePollingReady(): Promise<void> {
    try {
      await this.api('deleteWebhook', { drop_pending_updates: false });
    } catch { /* best-effort */ }
  }

  // ------------------------------------------------------------------ outbound

  async send(
    record: SupervisionRecord, notification: string, interactive = true,
  ): Promise<SendResult> {
    // A multi-question / multi-select question renders as a toggle + Submit card.
    let text: string;
    let replyMarkup: ReplyMarkup | null;
    if (interactive && record.state === SupervisionState.ORANGE_AWAITING_QUESTION && record.question_spec) {
      [text, replyMarkup] = buildQuestionCard(record);
    } else {
      [text, replyMarkup] = buildCard(record, notification, {
        interactive,
        minutesLeft: interactive ? this.timeoutMinutes : null,
        deadlineIso: null,
      });
    }
    const payload: Record<string, unknown> = { chat_id: this.chatId, text };
    if (replyMarkup !== null) { payload.reply_markup = replyMarkup; }
    const resp = await this.api('sendMessage', payload);
    if (resp.ok !== true) {
      throw new DeliveryError(`telegram sendMessage not ok: ${JSON.stringify(resp)}`);
    }
    const result = (resp.result ?? {}) as Record<string, unknown>;
    return { messageId: String(result.message_id ?? ''), sentAt: toIso(this.clock()) };
  }

  // ------------------------------------------------------------------ inbound

  async pollResponses(pending: SupervisionRecord[]): Promise<InboundResponse[]> {
    const byId = new Map(pending.map(r => [r.request_id, r]));
    const byMessage = new Map(
      pending.filter(r => r.notification_id).map(r => [String(r.notification_id), r]));
    // Fallback target for a plain text reply with no reply-to: the most recently notified
    // awaiting card (there is normally exactly one live decision at a time).
    const latest = pending.length
      ? pending.reduce((best, r) =>
        ((r.notified_at ?? r.created_at) > (best.notified_at ?? best.created_at) ? r : best))
      : null;

    const out: InboundResponse[] = [];

    // Handed our updates by the remote control, which owns the single read on this token. It also
    // owns the offset, so nothing here touches it.
    if (this.updateSource !== undefined) {
      for (const u of this.updateSource()) {
        const update = (u ?? {}) as Record<string, unknown>;
        const uid = typeof update.update_id === 'number' ? update.update_id : 0;
        const resolved = await this.resolveUpdate(update, uid, byId, byMessage, latest);
        if (resolved !== null) { out.push(resolved); }
      }
      return out;
    }

    const offset = await this.readOffset();
    let resp: Record<string, unknown>;
    try {
      resp = await this.api('getUpdates', { offset: offset + 1, timeout: this.longPoll });
    } catch (err) {
      // Surface it — a silent getUpdates failure looks identical to "no replies" and makes
      // every decision time out. (Most common cause: another consumer/webhook on this bot.)
      this.log(`telegram getUpdates failed: ${String(err)}`);
      return out;
    }
    const updates = Array.isArray(resp.result) ? resp.result : [];
    let maxSeen = offset;
    for (const u of updates) {
      const update = (u ?? {}) as Record<string, unknown>;
      const uid = typeof update.update_id === 'number' ? update.update_id : offset;
      maxSeen = Math.max(maxSeen, uid);
      const resolved = await this.resolveUpdate(update, uid, byId, byMessage, latest);
      if (resolved !== null) { out.push(resolved); }
    }
    if (maxSeen > offset) { await this.writeOffset(maxSeen); }
    return out;
  }

  private async resolveUpdate(
    u: Record<string, unknown>,
    uid: number,
    byId: Map<string, SupervisionRecord>,
    byMessage: Map<string, SupervisionRecord>,
    latest: SupervisionRecord | null,
  ): Promise<InboundResponse | null> {
    const cq = u.callback_query;
    if (cq && typeof cq === 'object' && !Array.isArray(cq)) {
      const q = cq as Record<string, unknown>;
      const data = String(q.data ?? '');
      const sep = data.indexOf('|');
      const rid = sep >= 0 ? data.slice(0, sep) : data;
      const rest = sep >= 0 ? data.slice(sep + 1) : '';
      const rec = byId.get(rid) ?? latest;
      try { // acknowledge the tap immediately so the button's spinner clears
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Recorded ✓' });
      } catch { /* best-effort */ }
      if (rec === null || rec === undefined) { return null; } // stale tap on an already-resolved card

      // Question card taps: "__submit" commits; "q<idx>|<optidx>" toggles an option. The
      // orchestrator owns the answer draft, so we emit toggle/submit sentinels.
      if (rec.question_spec !== null) {
        if (rest === '__submit') {
          return {
            updateId: String(uid), correlationId: rec.request_id,
            text: '__submit', receivedAt: toIso(this.clock()),
          };
        }
        const sep2 = rest.indexOf('|');
        const qkey = sep2 >= 0 ? rest.slice(0, sep2) : rest;
        const optidx = sep2 >= 0 ? rest.slice(sep2 + 1) : '';
        const label = questionOptionLabel(rec, qkey, optidx);
        if (label === null) { return null; }
        return {
          updateId: String(uid), correlationId: rec.request_id,
          text: `__toggle|${qkey}|${label}`, receivedAt: toIso(this.clock()),
        };
      }

      const opts = optionsFor(rec);
      const label = /^\d+$/.test(rest) && Number(rest) < opts.length ? opts[Number(rest)] : data;
      return {
        updateId: String(uid), correlationId: rec.request_id, text: label,
        receivedAt: toIso(this.clock()),
      };
    }

    const msg = u.message;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)
      && typeof (msg as Record<string, unknown>).text === 'string') {
      const m = msg as Record<string, unknown>;
      const text = (m.text as string).trim();
      // Reply to a live card → decision; otherwise a general instruction for the agent.
      const replyTo = (m.reply_to_message ?? {}) as Record<string, unknown>;
      const rec = (replyTo.message_id !== undefined
        ? byMessage.get(String(replyTo.message_id))
        : undefined) ?? latest;
      const correlation = rec ? rec.request_id : ACTIVE_SESSION;
      return {
        updateId: String(uid), correlationId: correlation, text,
        receivedAt: toIso(this.clock()),
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ timers

  /** Best-effort countdown tick via editMessageText. Failures are ignored. */
  async refreshTimers(pending: SupervisionRecord[]): Promise<void> {
    const now = this.clock();
    for (const rec of pending) {
      if (!rec.notification_id || !rec.timeout_deadline) { continue; }
      const minutesLeft = minutesUntil(rec.timeout_deadline, now);
      const source = rec.original_orange_assessment ?? rec.assessment ?? {};
      const notification = String(source.human_notification ?? '');
      const [text, replyMarkup] = buildCard(rec, notification, {
        interactive: true, minutesLeft, deadlineIso: rec.timeout_deadline,
      });
      const messageId = Number(rec.notification_id);
      if (!Number.isFinite(messageId)) { continue; }
      const payload: Record<string, unknown> = {
        chat_id: this.chatId, message_id: messageId, text,
      };
      if (replyMarkup !== null) { payload.reply_markup = replyMarkup; }
      try {
        await this.api('editMessageText', payload);
      } catch { /* best-effort; the deadline text still stands and the timeout still fires */ }
    }
  }

  // ------------------------------------------------------------------ offset

  private async readOffset(): Promise<number> {
    try {
      const raw = (await fs.promises.readFile(this.offsetPath, 'utf8')).trim();
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private async writeOffset(value: number): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.offsetPath), { recursive: true });
      await fs.promises.writeFile(this.offsetPath, String(value), 'utf8');
    } catch { /* best-effort */ }
  }
}
