import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { queryBobDb } from './BobDatabase';
import { bobRowToSession } from './sessionRows';
import { discoverPeers } from './remote/PeerDiscovery';
import { SshRunner } from './remote/SshRunner';
import {
  RemoteSessionSource,
  type PeerStatus,
  type RemoteOwner,
} from './remote/RemoteSessionSource';
import { REMOTE_FOCUS_PY } from './remote/remoteFocus';
import type { WindowEntry } from './WindowRegistry';
import { FullTranscript, readBobTranscript } from './SessionExporter';
import {
  claudeStatusFromTail,
  type JsonlRecord,
  type SessionStatus,
} from './sessionStatus';

/**
 * How often peer machines are re-probed. Slower than the 5 s local poll on purpose: each pass is
 * network work, and with ControlMaster keeping the connection warm this is still responsive.
 */
const REMOTE_POLL_MS = 20_000;

/**
 * Whether to pull sessions from peer machines (`sessionSitter.remotePeers`).
 *
 * **Fails closed.** If the setting cannot be read — an unexpected host, a configuration API that
 * is absent or throws — the answer is no. The alternative would be opening SSH connections from a
 * host we could not even query for consent, which is precisely where the extension should do the
 * least. Only an explicit, readable `auto` turns it on.
 */
export function remotePeersEnabled(
  readSetting: () => string | undefined = () =>
    vscode.workspace.getConfiguration('sessionSitter').get<string>('remotePeers'),
): boolean {
  try {
    return (readSetting() ?? 'auto') !== 'off';
  } catch {
    return false;
  }
}

/** Which session sources this extension knows about. */
export type SessionSourceId = 'claude' | 'bob' | 'codex' | 'chat';

/**
 * Directory holding VS Code's per-user state (`workspaceStorage/` lives here), where
 * VS Code Chat sessions are stored. Platform-specific; exported so it can be unit-tested
 * without a real home directory.
 *
 * Was macOS-only. Linux matters in practice: the supervision runtime targets WSL, where
 * `~/Library/…` does not exist and Chat sessions would silently never be found.
 */
export function vscodeUserDir(
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(homedir, '.config', 'Code', 'User');
}

export interface MessageExchange {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

// Structured turn for full-transcript export. All fields optional so partial
// turns (e.g. a user message without a completed assistant response yet) are
// representable.
interface TranscriptTurn {
  userText?: string;
  assistantText?: string;
  timestamp?: Date;
}

interface TranscriptMeta {
  title: string;
  source: 'Claude' | 'Bob' | 'Codex' | 'Chat';
  sessionId: string;
}

export interface ClaudeSession {
  sessionId: string;    // UUID from filename (e.g. "d61ee3f8-38ea-4316-8b4e-c90a8dd2e45e")
  projectName: string;  // last path segment of cwd (e.g. "my-project")
  projectPath: string;  // full cwd from first user record
  title: string;        // AI-generated title if available, otherwise first user message (≤60 chars)
  updatedAt: Date;      // file mtime (last write time)
  // Whose turn it is, and why. Derived in `sessionStatus.ts`; see docs/STATUS-INDICATORS.md.
  status: SessionStatus;
  source: 'claude' | 'bob' | 'codex' | 'chat'; // which AI IDE this session belongs to
  // Set only when this session lives on another machine, to the peer that owns it
  // ("user@host"). Absent means local — so every existing local code path is unaffected.
  peer?: string;
}


// Read ~/.claude/sessions/*.json and return session IDs whose Claude process
// is still running. Each file stores the PID and the kernel start-time
// (procStart) of the Claude process so we can distinguish a live session
// from a recycled PID.  Only interactive VS Code sessions are included.
export async function getActiveSessionIds(): Promise<Set<string>> {
  const active = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  let files: string[];
  try {
    files = (await fs.promises.readdir(sessionsDir)).filter(f => f.endsWith('.json'));
  } catch {
    return active;
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - DAY_MS;

  for (const file of files) {
    try {
      const raw = await fs.promises.readFile(path.join(sessionsDir, file), 'utf8');
      const data = JSON.parse(raw) as {
        pid?: number;
        sessionId?: string;
        procStart?: string | number;
        entrypoint?: string;
        startedAt?: number;
      };
      if (typeof data.pid !== 'number' || !data.sessionId) { continue; }
      if (data.entrypoint !== 'claude-vscode') { continue; }
      // Exclude processes started before the 24-hour window — these are
      // background sessions from a previous VS Code session that was never
      // properly closed, not sessions the user opened today.
      if (typeof data.startedAt === 'number' && data.startedAt < cutoff) { continue; }
      try {
        process.kill(data.pid, 0); // throws if process is dead
        // Verify the PID hasn't been recycled by comparing kernel start-times.
        const stat = await fs.promises.readFile(`/proc/${data.pid}/stat`, 'utf8');
        const actualStart = stat.split(' ')[21];
        if (String(data.procStart) === actualStart) {
          active.add(data.sessionId);
        }
      } catch {
        // Dead or unreadable — skip
      }
    } catch {
      // Malformed session file — skip
    }
  }
  return active;
}

// One row of Bob's `messages` table, as both Bob readers below consume it.
interface BobMessageRow {
  role: string;
  data: string;
  created_at: number;
}

// Bob's message rows for one task, oldest first. A constant — every value is bound as a
// parameter (see BobDatabase.queryBobDb).
const BOB_MESSAGES_SQL =
  "SELECT role, data, created_at FROM messages WHERE task_id=? "
  + "AND role IN ('user','assistant') ORDER BY created_at";

// The most recent non-archived Bob tasks that have a first message.
const BOB_TASKS_SQL =
  'SELECT id, project_id, title, status, first_message, created_at, updated_at, env '
  + 'FROM tasks WHERE time_archived IS NULL AND first_message IS NOT NULL '
  + 'ORDER BY updated_at DESC LIMIT 100';

// Fingerprint used to skip firing the event when nothing changed.
function sessionsFingerprint(sessions: ClaudeSession[]): string {
  return sessions.map(s => `${s.sessionId}:${s.status}:${s.title}:${s.updatedAt.getTime()}`).join('|');
}

export class SessionManager implements vscode.Disposable {
  private readonly _onDidChangeSessions = new vscode.EventEmitter<ClaudeSession[]>();
  readonly onDidChangeSessions: vscode.Event<ClaudeSession[]> = this._onDidChangeSessions.event;

  private _sessions: ClaudeSession[] = [];
  private _sessionFilePaths = new Map<string, string>();
  private _sessionSources = new Map<string, SessionSourceId>();
  private readonly _watcher: vscode.FileSystemWatcher;
  private readonly _projectsDir: string;
  private readonly _bobDbPath: string;
  private readonly _codexSessionsDir: string;
  private readonly _codexIndexPath: string;
  private readonly _vscodeUserDir: string;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pollTimer: ReturnType<typeof setInterval>;
  // Present only when peer pulling is enabled; see `_startRemotePolling`.
  private _remote: RemoteSessionSource | undefined;
  private _remoteRunner: SshRunner | undefined;
  private _remoteTimer: ReturnType<typeof setInterval> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this._projectsDir = path.join(os.homedir(), '.claude', 'projects');
    this._bobDbPath = path.join(os.homedir(), '.bob', 'db', 'bob.db');
    this._codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    this._codexIndexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
    this._vscodeUserDir = vscodeUserDir();

    // Initial scan
    void this._scanSessions().then(sessions => {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    });

    // FileSystemWatcher as fast path (may not fire reliably in WSL2)
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(this._projectsDir),
      '**/*.jsonl'
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => {
      if (this._debounceTimer !== undefined) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        void this._runScan();
      }, 250);
    };

    this._watcher.onDidCreate(refresh);
    this._watcher.onDidChange(refresh);
    this._watcher.onDidDelete(refresh);

    // Watch Bob DB WAL file for changes (written on every transaction commit)
    const bobDbDir = path.dirname(this._bobDbPath);
    const bobDbName = path.basename(this._bobDbPath);
    const bobPattern = new vscode.RelativePattern(
      vscode.Uri.file(bobDbDir),
      `${bobDbName}-wal`,
    );
    const bobWatcher = vscode.workspace.createFileSystemWatcher(bobPattern);
    bobWatcher.onDidCreate(refresh);
    bobWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => bobWatcher.dispose() });

    // Watch ~/.codex/session_index.jsonl for changes (Codex CLI updates it on every session write).
    const codexIndexDir = path.dirname(this._codexIndexPath);
    const codexIndexName = path.basename(this._codexIndexPath);
    const codexPattern = new vscode.RelativePattern(vscode.Uri.file(codexIndexDir), codexIndexName);
    const codexWatcher = vscode.workspace.createFileSystemWatcher(codexPattern);
    codexWatcher.onDidCreate(refresh);
    codexWatcher.onDidChange(refresh);
    context.subscriptions.push({ dispose: () => codexWatcher.dispose() });

    // Watch chatSessions/*.jsonl across all workspaces. Shared debounced `refresh`.
    const chatPattern = new vscode.RelativePattern(
      vscode.Uri.file(this._vscodeUserDir),
      'workspaceStorage/*/chatSessions/*.jsonl',
    );
    const chatWatcher = vscode.workspace.createFileSystemWatcher(chatPattern);
    chatWatcher.onDidCreate(refresh);
    chatWatcher.onDidChange(refresh);
    chatWatcher.onDidDelete(refresh);
    context.subscriptions.push({ dispose: () => chatWatcher.dispose() });

    // Polling fallback: re-scan every 5 s so status indicators and new sessions
    // stay current even when the FileSystemWatcher is silent (common in WSL2).
    this._pollTimer = setInterval(() => { void this._runScan(); }, 5_000);

    this._startRemotePolling();

    context.subscriptions.push(this);
  }

  /**
   * Start pulling sessions from peer machines, unless the user has turned it off.
   *
   * Deliberately on its own timer, slower than the local 5 s poll: `_scanSessions` awaits its
   * sources in sequence, so a peer probe on that path would stall the local session list behind
   * the network. This timer only refreshes a cache that the merge reads synchronously.
   */
  private _startRemotePolling(): void {
    // 'off' means no discovery, no timer, and no ssh connection of any kind.
    if (!remotePeersEnabled()) { return; }

    const runner = new SshRunner();
    // Shared with `focusRemoteSession`, so focus reuses the same warm ControlMaster connection.
    this._remoteRunner = runner;
    this._remote = new RemoteSessionSource({
      runner,
      discover: () => discoverPeers(),
      // The real parser, so a peer's session is titled by exactly the code that titles a local one.
      parseSessionFile: (filePath) => this._parseSessionFile(filePath),
    });

    const pull = async () => {
      try {
        await this._remote?.refresh();
        await this._runScan();
      } catch { /* a peer failure must never break the local panel */ }
    };
    void pull();
    this._remoteTimer = setInterval(() => { void pull(); }, REMOTE_POLL_MS);
  }

  /** Reachability of each peer machine, for display in the panel. */
  getPeerStatuses(): PeerStatus[] {
    return this._remote?.getPeerStatuses() ?? [];
  }

  /**
   * Live window entries published by peer machines.
   *
   * The panel unions these with `readLiveWindows` when deciding which sessions are open. Without
   * them a peer session can never be reported open — `readLiveWindows` sees only this machine —
   * so an idle peer session would always be filed under History.
   */
  getPeerWindows(): WindowEntry[] {
    return this._remote?.getPeerWindows() ?? [];
  }

  /** The peer window that owns a workspace path, for focusing a session on its own machine. */
  findRemoteOwnerWindow(projectPath: string): RemoteOwner | null {
    return this._remote?.findOwnerWindow(projectPath) ?? null;
  }

  /**
   * Bring the peer window that owns a session to the front, on its own machine.
   *
   * Returns false when this session is not on a peer, when no live peer window owns its
   * workspace, or when the peer window entry predates the fields the handshake needs.
   */
  async focusRemoteSession(sessionId: string): Promise<boolean> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session?.peer || !session.projectPath) { return false; }

    const owner = this.findRemoteOwnerWindow(session.projectPath);
    // An older build on the peer may not publish these, and without them there is nothing to talk to.
    if (!owner?.window.ipcSocket || !owner.window.ideCli) { return false; }

    const cfg = Buffer.from(JSON.stringify({
      pid: owner.window.pid,
      sessionId,
      ideCli: owner.window.ideCli,
      ipcSocket: owner.window.ipcSocket,
      folder: owner.window.workspaceFolders[0],
    }), 'utf8').toString('base64');

    try {
      await this._remoteRunner?.run(owner.peer, ['python3', '-', cfg], { stdin: REMOTE_FOCUS_PY });
      return true;
    } catch {
      return false;
    }
  }

  getSessions(): ClaudeSession[] {
    return [...this._sessions];
  }

  /** Path to Bob's SQLite DB (used by the supervision export bridge). */
  getBobDbPath(): string {
    return this._bobDbPath;
  }

  /** On-disk path for a session's source file (Claude/Codex/Chat JSONL; the id itself for
   *  Bob). Used by the supervision export. Undefined if the session isn't known. */
  getSessionFilePath(sessionId: string): string | undefined {
    return this._sessionFilePaths.get(sessionId);
  }

  /**
   * Full-fidelity transcript (tool calls + the pending approval) for the supervisor.
   * This extension is the single reader of the agents' stores; the supervisor consumes this
   * export contract rather than touching bob.db. Bob-only — Claude goes through
   * `SessionExporter.exportClaude`, which reads the session's JSONL file directly.
   */
  async getFullTranscript(sessionId: string): Promise<FullTranscript> {
    const source = this._sessionSources.get(sessionId);
    if (source && source !== 'bob') {
      throw new Error(`getFullTranscript: ${source} sessions are not supported (Bob only)`);
    }
    return readBobTranscript(this._bobDbPath, sessionId);
  }

  /**
   * Resolve the upload source file for a session:
   * - Claude sessions: returns the existing .jsonl file path.
   * - Bob sessions: serialises recent exchanges to a temp .bob.json file.
   * Returns { filePath, cleanup } or null if the session cannot be found.
   */
  async exportSessionAsJson(
    sessionId: string,
  ): Promise<{ filePath: string; cleanup: () => void } | null> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session) { return null; }

    if (session.source === 'claude' || session.source === 'codex') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      return { filePath, cleanup: () => { /* nothing to clean up */ } };
    }

    if (session.source === 'chat') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const exchanges = await this._getChatRecentExchanges(filePath);
      const envelope = {
        session_id: sessionId,
        harness: 'chat',
        username: os.userInfo().username,
        created_at: session.updatedAt.toISOString(),
        title: session.title,
        messages: exchanges.map(e => ({
          role: e.role,
          content: e.text,
          timestamp: e.timestamp ?? new Date().toISOString(),
        })),
      };
      const tmpFile = path.join(os.tmpdir(), `chat-session-${sessionId}.chat.json`);
      await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
      return {
        filePath: tmpFile,
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
      };
    }

    // Bob session — build a minimal .bob.json envelope from DB data.
    const exchanges = await this._getBobRecentExchanges(sessionId);
    const envelope = {
      session_id: sessionId,
      harness: 'bob',
      username: os.userInfo().username,
      created_at: session.updatedAt.toISOString(),
      title: session.title,
      messages: exchanges.map(e => ({
        role: e.role,
        content: e.text,
        timestamp: e.timestamp ?? new Date().toISOString(),
      })),
    };

    const tmpFile = path.join(os.tmpdir(), `bob-session-${sessionId}.bob.json`);
    await fs.promises.writeFile(tmpFile, JSON.stringify(envelope, null, 2), 'utf8');
    return {
      filePath: tmpFile,
      cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
    };
  }

  /**
   * Return the full transcript of a session as handoff-clean markdown, or
   * null if the session cannot be found. Dispatches by _sessionSources.
   * User + assistant prose only — tool_use / tool_result / scaffolding stripped.
   */
  async exportFullTranscript(sessionId: string): Promise<string | null> {
    const session = this._sessions.find(s => s.sessionId === sessionId);
    if (!session) { return null; }

    if (session.source === 'codex') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getCodexFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Codex session',
        source: 'Codex',
        sessionId,
      });
    }

    if (session.source === 'claude') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getClaudeFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Claude session',
        source: 'Claude',
        sessionId,
      });
    }

    if (session.source === 'bob') {
      const turns = await this._getBobFullTranscript(sessionId);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Bob session',
        source: 'Bob',
        sessionId,
      });
    }

    if (session.source === 'chat') {
      const filePath = this._sessionFilePaths.get(sessionId);
      if (!filePath) { return null; }
      const turns = await this._getChatFullTranscript(filePath);
      return this._renderTranscriptAsMarkdown(turns, {
        title: session.title || 'Chat session',
        source: 'Chat',
        sessionId,
      });
    }

    return null;
  }

  private _renderTranscriptAsMarkdown(turns: TranscriptTurn[], meta: TranscriptMeta): string {
    const header = [
      `# ${meta.title}`,
      '',
      `*Copied from ${meta.source} · session \`${meta.sessionId}\` · ${turns.length} turn${turns.length === 1 ? '' : 's'}.*`,
      '',
      '---',
      '',
    ];
    const body: string[] = [];
    turns.forEach((turn, i) => {
      const when = turn.timestamp ? turn.timestamp.toISOString().replace('T', ' ').slice(0, 19) : '(no timestamp)';
      body.push(`## Turn ${i + 1}  ·  ${when}`, '');
      if (turn.userText) {
        body.push('**User:**', '', turn.userText, '');
      }
      if (turn.assistantText) {
        body.push(`**Assistant (${meta.source}):**`, '', turn.assistantText, '');
      }
      body.push('---', '');
    });
    return header.concat(body).join('\n');
  }


  async getRecentExchanges(sessionId: string): Promise<MessageExchange[]> {
    const filePath = this._sessionFilePaths.get(sessionId);
    if (!filePath) { return []; }

    if (this._sessionSources.get(sessionId) === 'bob') {
      return this._getBobRecentExchanges(filePath);
    }

    if (this._sessionSources.get(sessionId) === 'codex') {
      return this._getCodexRecentExchanges(filePath);
    }

    if (this._sessionSources.get(sessionId) === 'chat') {
      return this._getChatRecentExchanges(filePath);
    }


    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return [];
    }

    const TAIL = 32768;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];

      for (let i = lines.length - 1; i >= 0 && collected.length < 6; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const record = JSON.parse(trimmed) as JsonlRecord;

          if (record.type === 'user') {
            const content = record.message?.content;
            let text: string | null = null;
            if (typeof content === 'string' && content.trim().length > 0) {
              text = content.trim();
            } else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                  text = b.text.trim();
                  break;
                }
              }
            }
            if (text !== null) {
              const truncated = text.length > 150 ? text.slice(0, 150) + '…' : text;
              collected.push({ role: 'user', text: truncated, timestamp: record.timestamp });
            }

          } else if (record.type === 'assistant') {
            const content = record.message?.content;
            let text: string | null = null;
            if (Array.isArray(content)) {
              for (const block of content) {
                const b = block as { type?: string; text?: string };
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                  text = b.text.trim();
                  break;
                }
              }
            } else if (typeof content === 'string' && content.trim().length > 0) {
              text = content.trim();
            }
            if (text !== null) {
              const truncated = text.length > 250 ? text.slice(0, 250) + '…' : text;
              collected.push({ role: 'assistant', text: truncated, timestamp: record.timestamp });
            }
          }
        } catch {
          // Malformed line — skip
        }
      }

      return collected.reverse();
    } finally {
      await fh.close();
    }
  }

  dispose(): void {
    if (this._debounceTimer !== undefined) {
      clearTimeout(this._debounceTimer);
    }
    clearInterval(this._pollTimer);
    if (this._remoteTimer !== undefined) {
      clearInterval(this._remoteTimer);
    }
    this._watcher.dispose();
    this._onDidChangeSessions.dispose();
  }

  private async _getBobRecentExchanges(taskId: string): Promise<MessageExchange[]> {
    let rows: BobMessageRow[];
    try {
      rows = await queryBobDb<BobMessageRow>(this._bobDbPath, BOB_MESSAGES_SQL, [taskId]);
    } catch {
      return [];
    }

    const collected: MessageExchange[] = [];
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as { content?: unknown };
        let text: string | null = null;
        const content = d.content;
        if (typeof content === 'string' && content.trim()) {
          text = content.trim();
        } else if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text?.trim()) { text = b.text.trim(); break; }
          }
        }
        if (text === null) { continue; }
        const role = row.role === 'user' ? 'user' : 'assistant';
        const maxLen = role === 'user' ? 150 : 250;
        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        collected.push({ role, text: truncated, timestamp: new Date(row.created_at).toISOString() });
      } catch { /* skip malformed */ }
    }

    return collected.slice(-6);
  }

  // Return every message for a Bob task, chronologically. Uses the same
  // messages(role, data, created_at) schema as _getBobRecentExchanges — the
  // `data` column is a JSON blob containing {content}. Full history, no cap.
  private async _getBobFullTranscript(taskId: string): Promise<TranscriptTurn[]> {
    let rows: BobMessageRow[];
    try {
      rows = await queryBobDb<BobMessageRow>(this._bobDbPath, BOB_MESSAGES_SQL, [taskId]);
    } catch {
      return [];
    }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    for (const row of rows) {
      let text: string | null = null;
      try {
        const d = JSON.parse(row.data) as { content?: unknown };
        const content = d.content;
        if (typeof content === 'string' && content.trim()) {
          text = content.trim();
        } else if (Array.isArray(content)) {
          const parts: string[] = [];
          for (const block of content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text?.trim()) { parts.push(b.text.trim()); }
          }
          if (parts.length > 0) { text = parts.join('\n\n'); }
        }
      } catch { /* skip malformed row */ }

      if (!text) { continue; }
      const ts = typeof row.created_at === 'number' ? new Date(row.created_at) : undefined;

      if (row.role === 'user') {
        if (pending) { turns.push(pending); }
        pending = { userText: text, timestamp: ts };
      } else if (row.role === 'assistant') {
        if (!pending) { pending = { timestamp: ts }; }
        pending.assistantText = pending.assistantText
          ? `${pending.assistantText}\n\n${text}`
          : text;
        if (!pending.timestamp) { pending.timestamp = ts; }
      }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Run a full scan and fire onDidChangeSessions only when something changed.
  private async _runScan(): Promise<void> {
    const sessions = await this._scanSessions();
    if (sessionsFingerprint(sessions) !== sessionsFingerprint(this._sessions)) {
      this._sessions = sessions;
      this._onDidChangeSessions.fire([...this._sessions]);
    }
  }

  private async _scanSessions(): Promise<ClaudeSession[]> {
    // Build the id->path and id->source maps into LOCAL maps and swap them in atomically at
    // the end, mirroring how `_sessions` is swapped. Clearing the live maps at the start of a
    // scan and repopulating them asynchronously lets a concurrent reader (e.g. the 5 s
    // supervision sweep calling `getSessionFilePath`) hit the emptied map mid-scan and see
    // `undefined` — which made the Claude supervision export report "no target session" on
    // every aligned tick. Never mutate the live maps in place.
    const filePaths = new Map<string, string>();
    const sources = new Map<string, SessionSourceId>();
    const claudeSessions = await this._scanClaudeSessions(filePaths, sources);
    const bobSessions = await this._scanBobSessions(filePaths, sources);
    const codexSessions = await this._scanCodexSessions(filePaths, sources);
    const chatSessions = await this._scanChatSessions(filePaths, sources);
    // Read synchronously from the cache the remote timer fills — never awaited on the network
    // here, so a slow or unreachable peer cannot delay the local session list.
    //
    // Remote ids are intentionally left out of `filePaths` and `sources`: those maps drive the
    // supervision export, which acts on the machine that owns the session. Registering a peer
    // session there would invite supervision to act on a transcript it cannot control.
    const remoteSessions = this._remote?.getSessions() ?? [];
    const merged = [
      ...claudeSessions, ...bobSessions, ...codexSessions, ...chatSessions, ...remoteSessions,
    ];
    merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    this._sessionFilePaths = filePaths;
    this._sessionSources = sources;
    return merged;
  }

  private async _scanClaudeSessions(
    // Defaulted so each scanner is independently callable (unit tests drive them one at a
    // time); `_scanSessions` always passes the maps it will swap in atomically.
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    const jsonlFiles = await this._findJsonlFiles(this._projectsDir);
    for (const filePath of jsonlFiles) {
      try {
        const session = await this._parseSessionFile(filePath);
        if (session !== null) {
          sessions.push(session);
          filePaths.set(session.sessionId, filePath);
          sources.set(session.sessionId, 'claude');
        }
      } catch {
        // Silently skip files that fail to parse
      }
    }

    return sessions;
  }

  private async _scanBobSessions(
    // Defaulted so each scanner is independently callable (unit tests drive them one at a
    // time); `_scanSessions` always passes the maps it will swap in atomically.
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    // Bob IDE stores its sessions in SQLite; `queryBobDb` is the single read-only shim.
    let rows: Array<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      first_message: string;
      created_at: number;
      updated_at: number;
      env: string;
    }>;
    try {
      rows = await queryBobDb(this._bobDbPath, BOB_TASKS_SQL);
    } catch {
      return []; // DB absent or python3 unavailable
    }

    const sessions: ClaudeSession[] = [];
    for (const row of rows) {
      try {
        // Shared with the remote path in `sessionRows.ts`, so a peer's row renders identically.
        const session = bobRowToSession(row);
        if (!session) { continue; }
        filePaths.set(session.sessionId, session.sessionId); // store id as key for lookup
        sources.set(session.sessionId, 'bob');
        sessions.push(session);
      } catch { /* skip malformed row */ }
    }
    return sessions;
  }

  // Codex CLI stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
  // with an index at ~/.codex/session_index.jsonl mapping id -> {thread_name, updated_at}.
  private async _scanCodexSessions(
    // Defaulted so each scanner is independently callable (unit tests drive them one at a
    // time); `_scanSessions` always passes the maps it will swap in atomically.
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    const index = await this._readCodexIndex();

    let rolloutFiles: string[];
    try {
      rolloutFiles = await this._findCodexRollouts(this._codexSessionsDir);
    } catch {
      return [];
    }

    const sessions: ClaudeSession[] = [];
    for (const filePath of rolloutFiles) {
      try {
        // Read line 0 (session_meta) only — Codex embeds long base_instructions
        // fields so line 0 can be well over 4 KB; must read progressively.
        const firstLine = await this._readFirstLine(filePath);
        if (!firstLine.trim()) { continue; }

        const record = JSON.parse(firstLine) as {
          type?: string;
          payload?: { id?: string; cwd?: string };
        };
        if (record.type !== 'session_meta') { continue; }

        const sessionId = record.payload?.id;
        const cwd = record.payload?.cwd ?? '';
        if (!sessionId) { continue; }

        const idx = index.get(sessionId);
        const stat = await fs.promises.stat(filePath);
        const updatedAt = idx?.updatedAt ?? stat.mtime;
        const title = (idx?.threadName ?? (cwd ? path.basename(cwd) : '')).slice(0, 60);
        if (!title) { continue; }

        filePaths.set(sessionId, filePath);
        sources.set(sessionId, 'codex');
        sessions.push({
          sessionId,
          projectPath: cwd,
          projectName: cwd ? path.basename(cwd) : '',
          title,
          updatedAt,
          // Codex exposes no liveness signal of any kind — no extension host to ask, nothing in
          // the rollout that says whether it is mid-turn. 'dormant' is the honest answer, and its
          // tooltip says so rather than implying the session is finished.
          status: 'dormant',
          source: 'codex',
        });
      } catch { /* skip malformed rollout */ }
    }
    return sessions;
  }

  // Read the tail of a Codex rollout .jsonl and return the last <= 6 role-bearing
  // response_item records as MessageExchanges (user or assistant text only).
  private async _getCodexRecentExchanges(filePath: string): Promise<MessageExchange[]> {
    let stat: { size: number };
    try {
      stat = await fs.promises.stat(filePath);
    } catch { return []; }

    const TAIL = 32768;
    const offset = Math.max(0, stat.size - TAIL);
    const size = stat.size - offset;
    const buf = Buffer.alloc(size);

    const fh = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      const chunk = buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      const collected: MessageExchange[] = [];

      for (let i = lines.length - 1; i >= 0 && collected.length < 6; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) { continue; }
        try {
          const rec = JSON.parse(trimmed) as {
            timestamp?: string;
            type?: string;
            payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (rec.type !== 'response_item') { continue; }
          const role = rec.payload?.role;
          if (role !== 'user' && role !== 'assistant') { continue; }
          const first = (rec.payload?.content ?? []).find(
            b => typeof b.text === 'string' && b.text.trim().length > 0,
          );
          const text = first?.text?.trim();
          if (!text) { continue; }
          const cap = role === 'user' ? 150 : 250;
          const truncated = text.length > cap ? text.slice(0, cap) + '…' : text;
          collected.push({ role, text: truncated, timestamp: rec.timestamp });
        } catch { /* skip malformed line */ }
      }
      return collected.reverse();
    } finally {
      await fh.close();
    }
  }

  // Walk every line of a Codex rollout and pair user/assistant response_item
  // records into TranscriptTurns. Different from _getCodexRecentExchanges
  // which tail-slices; this returns the full history.
  private async _getCodexFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as {
          timestamp?: string;
          type?: string;
          payload?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        };
        if (rec.type !== 'response_item') { continue; }
        const role = rec.payload?.role;
        if (role !== 'user' && role !== 'assistant') { continue; }
        const text = (rec.payload?.content ?? [])
          .filter(b => typeof b.text === 'string' && b.text.trim().length > 0)
          .map(b => b.text!.trim())
          .join('\n')
          .trim();
        if (!text) { continue; }
        const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
        if (role === 'user') {
          if (pending) { turns.push(pending); }
          pending = { userText: text, timestamp: ts };
        } else {
          if (!pending) { pending = { timestamp: ts }; }
          pending.assistantText = pending.assistantText
            ? `${pending.assistantText}\n\n${text}`
            : text;
          if (!pending.timestamp) { pending.timestamp = ts; }
        }
      } catch { /* skip malformed line */ }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Walk every event in a Claude Code .jsonl and pair user/assistant events
  // into TranscriptTurns. Drops tool_use / tool_result / thinking parts.
  private async _getClaudeFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const turns: TranscriptTurn[] = [];
    let pending: TranscriptTurn | null = null;

    const extractText = (content: unknown): string => {
      if (typeof content === 'string') { return content.trim(); }
      if (!Array.isArray(content)) { return ''; }
      const parts = content
        .filter((p): p is { type: string; text?: string } =>
          typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text',
        )
        .map(p => (typeof p.text === 'string' ? p.text : ''))
        .filter(t => t.trim().length > 0)
        .map(t => t.trim());
      return parts.join('\n\n');
    };

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string; content?: unknown };
        };
        if (rec.type !== 'user' && rec.type !== 'assistant') { continue; }
        const text = extractText(rec.message?.content);
        if (!text) { continue; }
        const ts = rec.timestamp ? new Date(rec.timestamp) : undefined;
        if (rec.type === 'user') {
          if (pending) { turns.push(pending); }
          pending = { userText: text, timestamp: ts };
        } else {
          if (!pending) { pending = { timestamp: ts }; }
          pending.assistantText = pending.assistantText
            ? `${pending.assistantText}\n\n${text}`
            : text;
          if (!pending.timestamp) { pending.timestamp = ts; }
        }
      } catch { /* skip malformed line */ }
    }
    if (pending) { turns.push(pending); }
    return turns;
  }

  // Reconstruct the `v` state of a VS Code Chat session by replaying its
  // snapshot (kind:0) + deltas (kind:1 assign, kind:2 array push).
  private _replayChatDeltas(lines: string[]): {
    requests?: Array<{
      timestamp?: number;
      message?: { text?: string };
      response?: Array<{ value?: unknown }>;
      result?: { metadata?: { renderedUserMessage?: Array<{ type?: number; text?: string }> } };
    }>;
  } {
    const applyDelta = (
      state: Record<string, unknown> | unknown[],
      keyPath: Array<string | number>,
      value: unknown,
      isPush: boolean,
    ): void => {
      if (!keyPath.length) { return; }
      let parent: Record<string, unknown> | unknown[] = state;
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i];
        if (Array.isArray(parent) && typeof k === 'number') {
          while (parent.length <= k) { parent.push({}); }
          parent = parent[k] as Record<string, unknown> | unknown[];
        } else if (!Array.isArray(parent) && typeof k === 'string') {
          if (!(k in parent)) {
            parent[k] = typeof keyPath[i + 1] === 'number' ? [] : {};
          }
          parent = parent[k] as Record<string, unknown> | unknown[];
        }
      }
      const last = keyPath[keyPath.length - 1];
      if (isPush) {
        let arr: unknown;
        if (Array.isArray(parent) && typeof last === 'number') {
          arr = parent[last];
        } else if (!Array.isArray(parent) && typeof last === 'string') {
          if (!(last in parent)) { parent[last] = []; }
          arr = parent[last];
        }
        if (Array.isArray(arr) && Array.isArray(value)) { arr.push(...value); }
        else if (Array.isArray(arr)) { arr.push(value); }
      } else if (Array.isArray(parent) && typeof last === 'number') {
        while (parent.length <= last) { parent.push(undefined); }
        parent[last] = value;
      } else if (!Array.isArray(parent) && typeof last === 'string') {
        parent[last] = value;
      }
    };

    let state: Record<string, unknown> | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const rec = JSON.parse(trimmed) as { kind?: number; k?: Array<string | number>; v?: unknown };
        if (rec.kind === 0) {
          state = (rec.v as Record<string, unknown>) ?? {};
        } else if (state && (rec.kind === 1 || rec.kind === 2)) {
          applyDelta(state, rec.k ?? [], rec.v, rec.kind === 2);
        }
      } catch { /* skip malformed */ }
    }
    return (state ?? {}) as ReturnType<typeof this._replayChatDeltas>;
  }

  private async _getChatFullTranscript(filePath: string): Promise<TranscriptTurn[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const state = this._replayChatDeltas(raw.split('\n'));
    const requests = state.requests ?? [];

    const USER_REQUEST_RE = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/;

    const turns: TranscriptTurn[] = [];
    for (const req of requests) {
      if (!req) { continue; }
      const rendered = req.result?.metadata?.renderedUserMessage ?? [];
      const combined = rendered
        .filter(p => p && p.type === 1 && typeof p.text === 'string')
        .map(p => p.text!)
        .join('\n');
      const unwrapMatch = combined.match(USER_REQUEST_RE);
      const userText = (unwrapMatch ? unwrapMatch[1] : (req.message?.text ?? combined)).trim();

      const assistantText = (req.response ?? [])
        .filter(el => el && typeof el.value === 'string')
        .map(el => el.value as string)
        .join('')
        .trim();

      const timestamp = typeof req.timestamp === 'number' ? new Date(req.timestamp) : undefined;

      if (userText || assistantText) {
        turns.push({
          userText: userText || undefined,
          assistantText: assistantText || undefined,
          timestamp,
        });
      }
    }
    return turns;
  }

  // Read a file's first line by reading progressively until we hit a newline
  // or the cap. Used by scanners whose line 0 has an unbounded upper size —
  // Codex rollouts routinely exceed 4 KB (embedded base_instructions); VS Code
  // Chat snapshot lines can grow with long conversations. Cap defaults to 1 MB
  // to catch malformed files without OOM.
  private async _readFirstLine(filePath: string, maxBytes = 1_048_576): Promise<string> {
    const CHUNK = 8192;
    const fd = await fs.promises.open(filePath, 'r');
    try {
      const chunks: string[] = [];
      let offset = 0;
      while (offset < maxBytes) {
        const buf = Buffer.alloc(CHUNK);
        const { bytesRead } = await fd.read(buf, 0, CHUNK, offset);
        if (bytesRead === 0) { break; }
        const chunk = buf.subarray(0, bytesRead).toString('utf8');
        const nl = chunk.indexOf('\n');
        if (nl >= 0) {
          chunks.push(chunk.slice(0, nl));
          return chunks.join('');
        }
        chunks.push(chunk);
        offset += bytesRead;
      }
      return chunks.join('');
    } finally {
      await fd.close();
    }
  }

  private async _readCodexIndex(): Promise<Map<string, { threadName: string; updatedAt: Date }>> {
    const map = new Map<string, { threadName: string; updatedAt: Date }>();
    try {
      const raw = await fs.promises.readFile(this._codexIndexPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const rec = JSON.parse(trimmed) as { id?: string; thread_name?: string; updated_at?: string };
          if (rec.id && rec.thread_name && rec.updated_at) {
            map.set(rec.id, { threadName: rec.thread_name, updatedAt: new Date(rec.updated_at) });
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* file may not exist */ }
    return map;
  }

  // Read the snapshot line of a VS Code Chat .jsonl and reconstruct the last
  // <= 3 request/response pairs as MessageExchanges (user text + concatenated
  // string `value` fields of the response array).
  private async _getChatRecentExchanges(filePath: string): Promise<MessageExchange[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch { return []; }

    const firstNl = raw.indexOf('\n');
    const firstLine = firstNl >= 0 ? raw.slice(0, firstNl) : raw;
    if (!firstLine.trim()) { return []; }

    let snapshot: {
      v?: { requests?: Array<{
        message?: { text?: string };
        response?: Array<{ kind?: string; value?: unknown }>;
        timestamp?: number;
      }> };
    };
    try {
      snapshot = JSON.parse(firstLine);
    } catch { return []; }

    const requests = snapshot.v?.requests ?? [];
    const collected: MessageExchange[] = [];

    // Take up to the last 3 requests → up to 6 exchanges.
    const startIdx = Math.max(0, requests.length - 3);
    for (let i = startIdx; i < requests.length; i++) {
      const r = requests[i];
      const iso = typeof r.timestamp === 'number' ? new Date(r.timestamp).toISOString() : undefined;

      const userText = r.message?.text?.trim();
      if (userText) {
        const cap = 150;
        const truncated = userText.length > cap ? userText.slice(0, cap) + '…' : userText;
        collected.push({ role: 'user', text: truncated, timestamp: iso });
      }

      const responseText = (r.response ?? [])
        .filter(el => typeof el.value === 'string')
        .map(el => el.value as string)
        .join('')
        .trim();
      if (responseText) {
        const cap = 250;
        const truncated = responseText.length > cap ? responseText.slice(0, cap) + '…' : responseText;
        collected.push({ role: 'assistant', text: truncated, timestamp: iso });
      }
    }
    return collected;
  }

  // Scan VS Code Chat sessions across all workspaces. Each workspaceStorage/<hash>
  // may contain a chatSessions/*.jsonl plus a workspace.json that names the folder.
  private async _scanChatSessions(
    // Defaulted so each scanner is independently callable (unit tests drive them one at a
    // time); `_scanSessions` always passes the maps it will swap in atomically.
    filePaths: Map<string, string> = new Map(), sources: Map<string, SessionSourceId> = new Map(),
  ): Promise<ClaudeSession[]> {
    const wsRoot = path.join(this._vscodeUserDir, 'workspaceStorage');
    let workspaceHashes: string[];
    try {
      const entries = await fs.promises.readdir(wsRoot, { withFileTypes: true });
      workspaceHashes = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch { return []; }

    const sessions: ClaudeSession[] = [];
    for (const hash of workspaceHashes) {
      const chatDir = path.join(wsRoot, hash, 'chatSessions');
      let chatFiles: string[];
      try {
        const entries = await fs.promises.readdir(chatDir, { withFileTypes: true });
        chatFiles = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(chatDir, e.name));
      } catch { continue; }

      // Resolve workspace folder path once per hash.
      let projectPath = '';
      let projectName = '(no workspace)';
      try {
        const wsMeta = await fs.promises.readFile(path.join(wsRoot, hash, 'workspace.json'), 'utf8');
        const parsed = JSON.parse(wsMeta) as { folder?: string };
        if (parsed.folder?.startsWith('file://')) {
          projectPath = decodeURIComponent(parsed.folder.slice('file://'.length));
          projectName = path.basename(projectPath) || '(no workspace)';
        }
      } catch { /* keep fallback */ }

      for (const filePath of chatFiles) {
        try {
          const firstLine = await this._readFirstLine(filePath);
          if (!firstLine.trim()) { continue; }

          const rec = JSON.parse(firstLine) as {
            kind?: number;
            v?: { sessionId?: string; requests?: Array<{ message?: { text?: string } }> };
          };
          if (rec.kind !== 0) { continue; }
          const sessionId = rec.v?.sessionId;
          if (!sessionId) { continue; }

          const firstText = rec.v?.requests?.[0]?.message?.text?.trim();
          const title = (firstText && firstText.length > 0
            ? firstText
            : `Chat in ${projectName}`).slice(0, 60);

          const stat = await fs.promises.stat(filePath);
          filePaths.set(sessionId, filePath);
          sources.set(sessionId, 'chat');
          sessions.push({
            sessionId,
            projectPath,
            projectName,
            title,
            updatedAt: stat.mtime,
            // Same as Codex: no liveness signal to read, so we do not pretend to have one.
            status: 'dormant',
            source: 'chat',
          });
        } catch { /* skip malformed chat file */ }
      }
    }
    return sessions;
  }

  private async _findCodexRollouts(root: string): Promise<string[]> {
    const results: string[] = [];
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const st = await fs.promises.stat(full);
            if (st.mtime.getTime() >= ninetyDaysAgo) { results.push(full); }
          } catch { /* skip */ }
        }
      }
    };
    await walk(root);
    return results;
  }

  private async _findJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'subagents') {
          results.push(...(await this._findJsonlFiles(fullPath)));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable — return empty
    }
    return results;
  }

  private async _parseSessionFile(filePath: string): Promise<ClaudeSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');

    const stat = await fs.promises.stat(filePath);
    const updatedAt = stat.mtime;

    // VS Code plugin sessions can have large attachment records before the first
    // user message. Read in 16 KB chunks up to 256 KB, collecting:
    //   - firstUserText + projectPath  (from the first user record)
    //   - aiTitle                      (from the ai-title record Claude Code writes)
    // Use aiTitle as the display title when available — it matches what VS Code
    // shows in the editor tab — and fall back to the raw first user message.
    const CHUNK_SIZE = 16384;
    const MAX_BYTES  = 262144;

    const fh = await fs.promises.open(filePath, 'r');
    try {
      let fileOffset = 0;
      let leftover = '';
      let firstUserText: string | null = null;
      let projectPath = '';
      let aiTitle: string | null = null;

      outer: while (fileOffset < MAX_BYTES) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, fileOffset);
        if (bytesRead === 0) { break; }
        fileOffset += bytesRead;

        const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
        const lines = chunk.split('\n');
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          try {
            const record = JSON.parse(trimmed) as JsonlRecord;

            if (record.type === 'user' && firstUserText === null) {
              const content = record.message?.content;
              let text: string | null = null;
              if (typeof content === 'string' && content.trim().length > 0) {
                text = content.trim();
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  const b = block as { type?: string; text?: string };
                  if (
                    block !== null &&
                    typeof block === 'object' &&
                    b.type === 'text' &&
                    typeof b.text === 'string' &&
                    (b.text ?? '').trim().length > 0
                  ) {
                    text = (b.text ?? '').trim();
                    break;
                  }
                }
              }
              if (text !== null) {
                firstUserText = text;
                projectPath = typeof record.cwd === 'string' && record.cwd.length > 0
                  ? record.cwd : '';
              }
            }

            if (record.type === 'ai-title' &&
                typeof record.aiTitle === 'string' &&
                record.aiTitle.trim().length > 0) {
              aiTitle = record.aiTitle.trim();
            }

          } catch {
            // Malformed JSON line — skip
          }
        }

        // Stop once we have both pieces; ai-title appears shortly after the
        // first assistant reply so we never need to read far.
        if (firstUserText !== null && aiTitle !== null) { break outer; }
      }

      if (firstUserText === null) {
        return null;
      }

      const title = (aiTitle ?? firstUserText).slice(0, 60);
      const projectName = projectPath ? path.basename(projectPath) : '';
      const status = await this._readStatus(fh, stat.size, updatedAt);
      // The caller (_scanClaudeSessions) records the id->path/source mapping into the local
      // maps it swaps in atomically; parsing must not mutate the live shared maps.
      return { sessionId, projectName, projectPath, title, updatedAt, status, source: 'claude' as const };
    } finally {
      await fh.close();
    }
  }

  /**
   * Read the tail of a Claude transcript and hand it to the classifier.
   *
   * Split deliberately: this method does the I/O — how much of the file to read, how to survive a
   * partial line at the window's edge — and `claudeStatusFromTail` does the deciding. All six
   * states are then unit-testable without a transcript on disk, and the rules live in one file
   * next to Bob's, instead of buried in a private method here.
   */
  private async _readStatus(
    fh: Awaited<ReturnType<typeof fs.promises.open>>,
    fileSize: number,
    updatedAt: Date,
  ): Promise<SessionStatus> {
    // Nothing has been written yet, so there is nothing to claim about it.
    if (fileSize === 0) { return 'dormant'; }

    const TAIL = 32768; // 32 KB covers large file-history-snapshot records
    const offset = Math.max(0, fileSize - TAIL);
    const size = fileSize - offset;
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, offset);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');

    const records: JsonlRecord[] = [];
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      // The first line of the window is usually a fragment. Skipping unparsable lines is what
      // makes reading a fixed-size tail safe.
      try { records.push(JSON.parse(trimmed) as JsonlRecord); } catch { /* partial line */ }
    }

    return claudeStatusFromTail(records, updatedAt.getTime(), Date.now());
  }
}

