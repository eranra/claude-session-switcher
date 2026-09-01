import * as vscode from 'vscode';
import { callOnClaudeManager } from './ClaudeInspector';
import { shouldAttemptSend, type MessageSender } from './BobSender';

/**
 * The user-message envelope Claude Code writes to the CLI subprocess stdin.
 * Confirmed from the extension bundle (v2.1.138): its own single-message helper
 * does `transport.write(JSON.stringify({type:"user",session_id:"",message:{role:
 * "user",content:[{type:"text",text}]},parent_tool_use_id:null}) + "\n")`.
 * `session_id: ""` is accepted — the CLI fills it in. Pure — unit-tested.
 */
export function buildClaudeUserMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

/**
 * Build the function injected into Claude's ext-host (with `this` = the manager).
 * v1 targeting: gather every channel across all comms; write only when there is
 * exactly ONE (the common single-conversation case). More than one → 'ambiguous'
 * (we cannot map sessionId→channel from the extension side; see the findings
 * note). The message envelope is computed in TS and embedded as a JSON literal,
 * so the injected code just appends a newline and writes it to the CLI stdin.
 */
export function buildInjectFn(text: string): string {
  const payload = JSON.stringify(buildClaudeUserMessage(text));
  return `function(){
    try {
      var payload = ${JSON.stringify(payload)};
      var chans = [];
      if (this.allComms && this.allComms.forEach) {
        this.allComms.forEach(function(c){
          if (c && c.channels && c.channels.forEach) c.channels.forEach(function(ch){ chans.push(ch); });
        });
      }
      if (chans.length === 0) return 'no-channel';
      if (chans.length > 1) return 'ambiguous:' + chans.length;
      var t = chans[0] && chans[0].query && chans[0].query.transport;
      if (!t || typeof t.write !== 'function') return 'no-transport';
      t.write(payload + String.fromCharCode(10));
      return 'ok';
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/**
 * Build a function that writes into the channel belonging to ONE named session.
 *
 * ## Why the mapping is discovered at run time
 *
 * `buildInjectFn` above can only write when a single channel is open, because the
 * sessionId↔channel link was not found on the extension side. That is fine for
 * supervision (which acts on whatever session raised the prompt) but not for remote
 * control, where the user picks a session and the message must land in *that* one.
 *
 * Rather than depend on a mapping we have not confirmed, this searches for it live:
 * the target id is compared against the channel map key, the channel's own scalar
 * properties, and `query.initConfig`'s scalar properties. Claude's own probe was
 * written to look in exactly those places. If a future Claude build exposes the id
 * under any of them, targeting starts working with no change here.
 *
 * ## The one thing it must never do
 *
 * When no channel matches and several are open, it refuses. Writing a user's prompt
 * into the wrong agent is the single unacceptable failure for this feature, and it
 * is worse than doing nothing, because the wrong agent will act on it. The sole
 * fallback — one channel open, so there is nothing to confuse it with — is the same
 * case `buildInjectFn` already relies on.
 *
 * The returned status distinguishes how it resolved, so callers can tell the user
 * whether targeting worked or whether they got the only session going.
 */
export function buildTargetedInjectFn(sessionId: string, text: string): string {
  const payload = JSON.stringify(buildClaudeUserMessage(text));
  return `function(){
    try {
      var payload = ${JSON.stringify(payload)};
      var want = ${JSON.stringify(sessionId)};
      var chans = [];
      if (this.allComms && this.allComms.forEach) {
        this.allComms.forEach(function(c){
          if (c && c.channels && c.channels.forEach) {
            c.channels.forEach(function(ch, id){ chans.push({ id: String(id), ch: ch }); });
          }
        });
      }
      if (chans.length === 0) return 'no-channel';

      var mentions = function(obj){
        if (!obj) return false;
        try {
          var names = Object.getOwnPropertyNames(obj);
          for (var i = 0; i < names.length; i++) {
            var v;
            try { v = obj[names[i]]; } catch (x) { continue; }
            if (typeof v === 'string' && v === want) return true;
          }
        } catch (x) {}
        return false;
      };

      var matches = [];
      for (var i = 0; i < chans.length; i++) {
        var entry = chans[i];
        var ch = entry.ch;
        var hit = entry.id === want
          || mentions(ch)
          || mentions(ch && ch.query && ch.query.initConfig);
        if (hit) matches.push(entry);
      }

      var chosen = null;
      var how = '';
      if (matches.length === 1) { chosen = matches[0].ch; how = 'matched'; }
      else if (matches.length > 1) { return 'ambiguous-match:' + matches.length; }
      else if (chans.length === 1) { chosen = chans[0].ch; how = 'sole'; }
      else { return 'ambiguous:' + chans.length; }

      var t = chosen && chosen.query && chosen.query.transport;
      if (!t || typeof t.write !== 'function') return 'no-transport';
      t.write(payload + String.fromCharCode(10));
      return 'ok:' + how;
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/** How a targeted send resolved. `ok:*` landed; everything else did not. */
export type ClaudeSendStatus = string;

/** True when the status means the message was written to a transport. */
export function sendLanded(status: ClaudeSendStatus): boolean {
  return status === 'ok' || status.startsWith('ok:');
}

/**
 * A user-facing sentence for a send status. Reported into the Telegram topic, so it
 * has to say what to do next rather than name an internal state.
 */
export function describeSendStatus(status: ClaudeSendStatus): string {
  if (status === 'ok:matched') { return 'Sent to this session.'; }
  if (status === 'ok:sole' || status === 'ok') {
    return 'Sent — this was the only Claude session open in its window.';
  }
  if (status === 'no-channel') {
    return 'That session is not open in its window. Use Focus in IDE to resume it first.';
  }
  if (status.startsWith('ambiguous-match:')) {
    return 'Several channels claim that session id, so nothing was sent.';
  }
  if (status.startsWith('ambiguous:')) {
    const n = status.slice('ambiguous:'.length);
    return `Its window has ${n} Claude sessions open and this build cannot tell them apart, `
      + 'so nothing was sent. Close the others, or use Focus in IDE.';
  }
  if (status === 'no-transport') { return 'That session has no live CLI to write to.'; }
  return `Not sent (${status}).`;
}

/**
 * Injects a user message into a running Claude Code session by reaching the live
 * manager via the V8 inspector and writing the message envelope to a channel's CLI
 * transport. Implements the same `MessageSender` interface the AutoResponder
 * consumes for Bob. Never throws — logs and no-ops on any failure.
 *
 * `send` keeps the original untargeted behaviour (sole channel only) so supervision
 * is unchanged. `sendToSession` targets one named session, discovering the
 * sessionId↔channel link at run time; see `buildTargetedInjectFn`.
 */
export class InspectorClaudeSender implements MessageSender {
  constructor(private readonly log: (msg: string) => void) {}

  async isAvailable(): Promise<boolean> {
    return !!vscode.extensions.getExtension('anthropic.claude-code');
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (!shouldAttemptSend(sessionId, text)) {
      this.log('claude send skipped: empty sessionId or text');
      return;
    }
    const result = await this.inject(text);
    if (result === 'ok') {
      this.log(`claude send: delivered to sole channel (session ${sessionId})`);
    } else {
      this.log(`claude send: not delivered (session ${sessionId}) → ${result}`);
    }
  }

  /**
   * Send `text` into the channel belonging to `sessionId`, and report how it went.
   *
   * Unlike `send`, this returns the status instead of only logging it: the caller has
   * to tell the user in Telegram whether their prompt actually landed, and a silent
   * failure there is indistinguishable from an agent that is simply thinking.
   */
  async sendToSession(sessionId: string, text: string): Promise<ClaudeSendStatus> {
    if (!shouldAttemptSend(sessionId, text)) { return 'empty-input'; }
    const { raw, diag } = await callOnClaudeManager(
      buildTargetedInjectFn(sessionId, text), this.log);
    const status = raw ?? `diag:${diag}`;
    this.log(`claude sendToSession(${sessionId}) → ${status}`);
    return status;
  }

  /** Run the injection and return the raw status string
   *  ('ok' | 'no-channel' | 'ambiguous:N' | 'no-transport' | 'err:…') or a reach
   *  diag (e.g. 'gB-not-found'). Exposed so the test command can surface it
   *  directly instead of only logging. Does not guard — callers pass fixed text. */
  async inject(text: string): Promise<string> {
    const { raw, diag } = await callOnClaudeManager(buildInjectFn(text), this.log);
    return raw ?? `diag:${diag}`;
  }
}
