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
 * ## Three routes, tried strongest first
 *
 * A channel carries no session id. Claude builds it as
 * `{in, query, pid, resolvePid, vscodeMcpServer, mcpServers, …}` and keys it by a
 * `channelId` the webview invents, so searching channels for the id — which is all
 * this used to do — never matched, and any window with two Claude sessions open
 * refused every send. The link exists, but it runs through the *surface* that owns
 * the session, by object identity:
 *
 * 1. **Ownership.** `sessionPanels: Map<sessionId, WebviewPanel>` gives the tab (it
 *    is self-pruning, and setting a session on a panel deletes that panel's previous
 *    entry, so one panel means one session). Otherwise `sessionStates:
 *    Map<sessionId, {info, author}>` gives the authoring surface — the panel for a
 *    tab, the comm object itself for the sidebar. A comm stores the panel it hosts
 *    as \`panelTab\`. Matching the surface against each comm — by identity, against
 *    the comm itself and against every own property, so a rename of \`panelTab\`
 *    does not break it — narrows the search to that comm's channels. One channel
 *    there is the answer: 'ok:owner'.
 *
 *    The two halves have different floors, and both degrade quietly. \`panelTab\` and
 *    \`sessionPanels\` go back at least to Claude 2.1.237, so tabs resolve there.
 *    \`author\` arrived in 2.1.238 — 2.1.237 stores a flat \`{sessionId, state,
 *    title}\` with no owner — so on that build a sidebar session has no ownership
 *    link and falls through to the steps below.
 * 2. **Id search.** Within that narrowed set (or window-wide if ownership found
 *    nothing), compare the id against the channel map key, the channel's own scalar
 *    properties, and \`query.initConfig\`'s. Nothing exposes it today; this stays so
 *    that a future Claude build which does starts working with no change here.
 * 3. **Sole channel.** One channel in scope, so there is nothing to confuse it with.
 *
 * ## What the ownership route refuses to do
 *
 * \`sessionStates\` accumulates — entries go only when their surface is disposed, not
 * when a surface switches session — so several ids can share one author while only
 * one of them is live. When that happens, or when two comms claim one surface, the
 * route declines rather than pick, and the send falls through to the id search.
 *
 * ## The one thing it must never do
 *
 * When nothing resolves and several channels are in scope, it refuses. Writing a
 * user's prompt into the wrong agent is the single unacceptable failure for this
 * feature, and it is worse than doing nothing, because the wrong agent will act on
 * it.
 *
 * The returned status distinguishes how it resolved, so callers can tell the user
 * whether targeting worked or whether they got the only session going.
 */
export function buildTargetedInjectFn(sessionId: string, text: string): string {
  const payload = JSON.stringify(buildClaudeUserMessage(text));
  return `function(){
    try {
      ${RESOLVE_CHANNEL_JS}
      var payload = ${JSON.stringify(payload)};
      var r = __resolveChannel(this, ${JSON.stringify(sessionId)});
      if (r.status) return r.status;
      var t = r.entry.ch && r.entry.ch.query && r.entry.ch.query.transport;
      if (!t || typeof t.write !== 'function') return 'no-transport';
      t.write(payload + String.fromCharCode(10));
      return 'ok:' + r.how;
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/**
 * The shared session→channel resolution, as a JavaScript snippet injected into
 * Claude's ext-host. Defines `__resolveChannel(mgr, want)`, which returns either
 * `{status}` (nothing to send to, or a refusal) or `{how, entry}` where `entry` is
 * `{id, ch, comm}`. The three routes are documented on `buildTargetedInjectFn`.
 *
 * It is a string constant rather than two copies because the read-only probe has to
 * report the decision this makes, not a paraphrase of it — a probe that agreed with
 * a separate implementation would confirm nothing about the sender.
 */
const RESOLVE_CHANNEL_JS = `
    function __resolveChannel(mgr, want) {
      var comms = [];
      if (mgr && mgr.allComms && mgr.allComms.forEach) {
        mgr.allComms.forEach(function(c){ if (c) comms.push(c); });
      }
      var chans = [];
      for (var ci = 0; ci < comms.length; ci++) {
        (function(comm){
          if (comm.channels && comm.channels.forEach) {
            comm.channels.forEach(function(ch, id){
              chans.push({ id: String(id), ch: ch, comm: comm });
            });
          }
        })(comms[ci]);
      }
      if (chans.length === 0) return { status: 'no-channel' };

      // ── Route 1: the surface that owns this session ────────────────────────
      // Only accepted when the link is unambiguous in both directions: one surface
      // for this session, and one comm for that surface.
      var countIn = function(map, pred){
        var n = 0;
        if (map && typeof map.forEach === 'function') {
          map.forEach(function(v){ if (pred(v)) n++; });
        }
        return n;
      };

      var owner = null;
      try {
        var panels = mgr.sessionPanels;
        if (panels && typeof panels.get === 'function') {
          var panel = panels.get(want) || null;
          if (panel && countIn(panels, function(p){ return p === panel; }) === 1) {
            owner = panel;
          }
        }
      } catch (x) {}
      if (!owner) {
        try {
          var states = mgr.sessionStates;
          if (states && typeof states.get === 'function') {
            var st = states.get(want);
            var author = (st && st.author) || null;
            if (author && countIn(states, function(v){ return !!v && v.author === author; }) === 1) {
              owner = author;
            }
          }
        } catch (x) {}
      }

      var ownerComm = null;
      if (owner) {
        var isOwnedBy = function(comm){
          if (comm === owner) return true;
          try {
            var names = Object.getOwnPropertyNames(comm);
            for (var i = 0; i < names.length; i++) {
              var v;
              try { v = comm[names[i]]; } catch (x) { continue; }
              if (v === owner) return true;
            }
          } catch (x) {}
          return false;
        };
        var hits = 0;
        for (var oi = 0; oi < comms.length; oi++) {
          if (isOwnedBy(comms[oi])) { ownerComm = comms[oi]; hits++; }
        }
        if (hits !== 1) { ownerComm = null; }
      }

      var scope = chans;
      if (ownerComm) {
        var narrowed = [];
        for (var ni = 0; ni < chans.length; ni++) {
          if (chans[ni].comm === ownerComm) narrowed.push(chans[ni]);
        }
        // An owning comm with no channel yet (Claude still launching) narrows to
        // nothing; that must not strand the send, so keep the window-wide view.
        if (narrowed.length > 0) scope = narrowed;
      }

      if (scope !== chans && scope.length === 1) return { how: 'owner', entry: scope[0] };

      // ── Route 2: a channel that names the session id ───────────────────────
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
      for (var i = 0; i < scope.length; i++) {
        var entry = scope[i];
        var ch = entry.ch;
        var hit = entry.id === want
          || mentions(ch)
          || mentions(ch && ch.query && ch.query.initConfig);
        if (hit) matches.push(entry);
      }
      if (matches.length === 1) return { how: 'matched', entry: matches[0] };
      if (matches.length > 1) return { status: 'ambiguous-match:' + matches.length };

      // ── Route 3: nothing to confuse it with ───────────────────────────────
      if (scope.length === 1) return { how: 'sole', entry: scope[0] };
      return { status: 'ambiguous:' + scope.length };
    }
`;

/**
 * Build a read-only function that reports, for every session Claude's manager knows,
 * which channel a send would resolve to and by which route — writing nothing.
 *
 * This exists because the ownership route depends on undocumented internals
 * (`sessionPanels`, `sessionStates[].author`, a comm's `panelTab`). A rename in a
 * Claude release turns targeting back into a refusal, and the only honest way to
 * check is to ask the live manager. It runs the same `__resolveChannel` the sender
 * runs, so what it prints is the decision, not a description of one.
 */
export function buildResolutionProbeFn(): string {
  return `function(){
    try {
      ${RESOLVE_CHANNEL_JS}
      var mgr = this;
      var ids = [], seen = {};
      var addKeys = function(map){
        if (map && typeof map.forEach === 'function') {
          map.forEach(function(_v, k){
            if (typeof k === 'string' && !seen[k]) { seen[k] = true; ids.push(k); }
          });
        }
      };
      try { addKeys(mgr.sessionPanels); } catch (x) {}
      try { addKeys(mgr.sessionStates); } catch (x) {}

      var comms = [];
      if (mgr.allComms && mgr.allComms.forEach) {
        mgr.allComms.forEach(function(c){
          if (!c) return;
          var e = { channelIds: [], objectProps: [], hasPanelTab: false };
          try { if (c.channels && c.channels.forEach) c.channels.forEach(function(_ch, id){ e.channelIds.push(String(id)); }); } catch (x) {}
          try {
            var names = Object.getOwnPropertyNames(c);
            for (var i = 0; i < names.length; i++) {
              var v; try { v = c[names[i]]; } catch (x) { continue; }
              if (v && typeof v === 'object') e.objectProps.push(names[i]);
            }
            e.hasPanelTab = !!c.panelTab;
          } catch (x) {}
          comms.push(e);
        });
      }

      var sessions = [];
      for (var i = 0; i < ids.length; i++) {
        var want = ids[i], r;
        try { r = __resolveChannel(mgr, want); } catch (x) { r = { status: 'err:' + String(x) }; }
        var row = { sessionId: want, inPanels: false, authorKind: 'none' };
        try { row.inPanels = !!(mgr.sessionPanels && mgr.sessionPanels.get && mgr.sessionPanels.get(want)); } catch (x) {}
        try {
          var st = mgr.sessionStates && mgr.sessionStates.get && mgr.sessionStates.get(want);
          var author = st && st.author;
          if (author) {
            var isComm = false;
            if (mgr.allComms && mgr.allComms.forEach) mgr.allComms.forEach(function(c){ if (c === author) isComm = true; });
            row.authorKind = isComm ? 'comm' : 'surface';
          }
        } catch (x) {}
        if (r.status) { row.verdict = 'refused:' + r.status; }
        else {
          var t = r.entry.ch && r.entry.ch.query && r.entry.ch.query.transport;
          row.verdict = (t && typeof t.write === 'function')
            ? ('would-send:' + r.how + ' → channel ' + r.entry.id)
            : ('refused:no-transport (' + r.how + ' → channel ' + r.entry.id + ')');
        }
        sessions.push(row);
      }
      return JSON.stringify({ commCount: comms.length, comms: comms, sessions: sessions });
    } catch (e) { return JSON.stringify({ err: String(e) }); }
  }`;
}

/**
 * Debug: report what a send to every session Claude's manager knows would resolve
 * to, as pretty JSON (or a diag). Read-only. This is the check for the ownership
 * route: it depends on Claude internals (`sessionPanels`, `sessionStates[].author`,
 * a comm's `panelTab`), and if a release moves them, `verdict` says
 * `refused:ambiguous:N` and `hasPanelTab` says why.
 */
export async function dumpClaudeTargeting(log: (msg: string) => void): Promise<string> {
  const { raw, diag } = await callOnClaudeManager(buildResolutionProbeFn(), log);
  if (typeof raw !== 'string') { return `// could not reach Claude manager: ${diag}`; }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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
  if (status === 'ok:owner' || status === 'ok:matched') { return 'Sent to this session.'; }
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
    return `Could not tell which of the ${n} Claude sessions in its window is this one, so nothing `
      + 'was sent. Use Focus in IDE to bring it up, then send again.';
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
