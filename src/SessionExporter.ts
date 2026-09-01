import * as fs from 'fs';
import * as path from 'path';
import { queryBobDb } from './BobDatabase';
import { PendingApproval } from './agents/BobApprover';
import { bobStatus, isQuestionTool } from './sessionStatus';

// ── Full-transcript export contract ──────────────────────────────────────────
// This extension is the single reader of Bob/Claude sessions. It exports the full
// transcript (tool calls + the pending approval) to STATE_DIR/history/<id>.json, which
// the Python supervisor consumes. Keep these field names (camelCase) in sync with
// supervisor/transcript.py.

export const EXPORT_SCHEMA_VERSION = '1.0';

export interface ExportToolCall {
  id: string;
  name: string;
  arguments: unknown;
  permission: string | null;
}

export interface ExportToolResult {
  callId: string;
  name: string;
  permission: string | null;
  isError: boolean;
  content: string;
}

export interface ExportTurn {
  index: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: string | null;
  toolCalls?: ExportToolCall[];
  toolResult?: ExportToolResult;
}

export interface ExportPendingAction {
  kind: 'tool_call' | 'question' | 'unknown';
  name: string | null;
  arguments: unknown;
  permission: string | null;
  description: string;
  turnIndex: number | null;
  // The live Bob approval requestId, when this pending action is read from a blocked prompt
  // via the inspector (BobApprover.listAllPending). Lets the supervisor reject it via the emitter.
  requestId?: string | null;
}

export interface FullTranscript {
  schemaVersion: string;
  sessionId: string;
  source: 'bob' | 'claude';
  user: string | null;
  projectName: string;
  projectPath: string;
  status: string;
  approvalConfig: unknown;
  title: string;
  turns: ExportTurn[];
  pendingAction: ExportPendingAction | null;
  waitingReason: string;
}

// Raw shapes we read out of Bob's `messages.data` JSON blob.
interface BobRow {
  role: string;
  data: string;
  created_at: number;
}

interface BobTaskRow {
  id: string;
  title: string;
  status: string;
  env: string;
  approval_config: string | null;
  project_id: string;
}

// Bob wraps genuine user prompts in <user_query>…</user_query> inside <environment_details>.
export function cleanUserContent(text: string): string {
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) { return m[1].trim(); }
  return text.trim();
}

function extractText(content: unknown): string {
  if (typeof content === 'string') { return content.trim(); }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b && b.type === 'text' && typeof b.text === 'string') { parts.push(b.text); }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function parseToolCalls(data: Record<string, unknown>): ExportToolCall[] {
  const raw = data.toolCalls;
  if (!Array.isArray(raw)) { return []; }
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map(c => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      arguments: c.arguments ?? {},
      permission: typeof c.permission === 'string' ? c.permission : null,
    }));
}

function parseToolResult(data: Record<string, unknown>): ExportToolResult | undefined {
  const usage = data.toolUsage as Record<string, unknown> | undefined;
  if (!usage) { return undefined; }
  const sig = (usage.signature ?? {}) as Record<string, unknown>;
  return {
    callId: String(sig.id ?? ''),
    name: String(sig.name ?? ''),
    permission: typeof usage.permission === 'string' ? usage.permission : null,
    isError: Boolean(sig.isError),
    content: extractText(data.content),
  };
}

/**
 * Pure transform: Bob task + ordered message rows → the export contract. No I/O, so it is
 * directly unit-testable.
 */
/** Map a live in-memory pending approval (read via the inspector) to the export shape,
 *  carrying the `requestId` so the supervisor can reject it through Bob's emitter. */
export function pendingFromApproval(p: PendingApproval, agentLabel = 'Bob'): ExportPendingAction {
  let args: unknown;
  try { args = JSON.parse(p.argsText); } catch { args = { _raw: p.argsText }; }
  // Both agents' question tools must map to 'question' so the supervisor relays them for a
  // real answer instead of auto-approving (an approved question with no selection makes the
  // agent report "the user didn't provide any answer"). One shared predicate with the status
  // module, so the row's 'question' state and the supervisor's handling can never disagree.
  const isQuestion = isQuestionTool(p.toolName);
  const kind: ExportPendingAction['kind'] = isQuestion ? 'question' : 'tool_call';
  return {
    kind,
    name: p.toolName || null,
    arguments: args,
    permission: p.permission || null,
    description: kind === 'question'
      ? `${agentLabel} is asking the user a question via ${p.toolName}.`
      : `${agentLabel} is waiting to run ${p.toolName}.`,
    turnIndex: null,
    requestId: p.requestId,
  };
}

export function buildTranscript(
  task: BobTaskRow, rows: BobRow[], livePending?: PendingApproval,
): FullTranscript {
  let projectPath = '';
  try {
    const env = JSON.parse(task.env || '{}') as {
      workspace?: string;
      staticEnvInfo?: { primaryWorkspace?: string };
    };
    projectPath = env.staticEnvInfo?.primaryWorkspace ?? env.workspace ?? '';
  } catch { /* leave empty */ }
  if (!projectPath && task.project_id?.startsWith('file:')) {
    projectPath = task.project_id.slice('file:'.length);
  }

  let approvalConfig: unknown = null;
  if (task.approval_config) {
    try { approvalConfig = JSON.parse(task.approval_config); } catch { approvalConfig = task.approval_config; }
  }

  const turns: ExportTurn[] = [];
  rows.forEach((row, index) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* keep empty */ }
    const role = String(data.role ?? row.role) as ExportTurn['role'];
    let text = extractText(data.content);
    if (role === 'user') { text = cleanUserContent(text); }

    const turn: ExportTurn = {
      index,
      role: role === 'user' || role === 'assistant' || role === 'tool' ? role : 'assistant',
      text,
      timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
    const calls = parseToolCalls(data);
    if (calls.length) { turn.toolCalls = calls; }
    const result = parseToolResult(data);
    if (result) { turn.toolResult = result; }
    turns.push(turn);
  });

  // A live approval read from Bob's memory (the true interrupt point) wins over what we can
  // infer from the DB, which lags behind an in-flight/blocked task.
  const pendingAction = livePending ? pendingFromApproval(livePending) : derivePendingAction(turns);
  // The same vocabulary the panel uses. This used to map a non-running task to 'waiting' while
  // `bobRowToSession` mapped the identical row to 'idle', so the exported transcript and the row
  // in the list disagreed about the very session the supervisor was being asked to judge.
  const status = bobStatus(
    task.status, pendingAction ? (pendingAction.kind === 'question' ? 'question' : 'approval') : undefined);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sessionId: task.id,
    source: 'bob',
    user: null, // resolved by the supervisor (git user / CLI override), not stored in bob.db
    projectName: projectPath ? path.basename(projectPath) : '',
    projectPath,
    status,
    approvalConfig,
    title: task.title || '',
    turns,
    pendingAction,
    waitingReason: pendingAction
      ? `Awaiting approval for ${pendingAction.name ?? pendingAction.kind}.`
      : 'Session is paused awaiting the user.',
  };
}

/** The action Bob is paused on: the last assistant tool call without a following result. */
export function derivePendingAction(turns: ExportTurn[]): ExportPendingAction | null {
  const resolvedCallIds = new Set<string>();
  for (const t of turns) {
    if (t.toolResult?.callId) { resolvedCallIds.add(t.toolResult.callId); }
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== 'assistant' || !t.toolCalls?.length) { continue; }
    // The pending action is the last tool call still awaiting a result. If every call in
    // this turn is already resolved, keep looking further back.
    const call = [...t.toolCalls].reverse().find(c => !resolvedCallIds.has(c.id));
    if (!call) { continue; }
    const isQuestion = isQuestionTool(call.name);
    const kind = isQuestion ? 'question' : 'tool_call';
    return {
      kind,
      name: call.name || null,
      arguments: call.arguments ?? null,
      permission: call.permission,
      description:
        isQuestion
          ? `The agent is asking the user a question via ${call.name}.`
          : `Bob is waiting to run ${call.name}.`,
      turnIndex: t.index,
    };
  }
  return null;
}

const BOB_TASK_SQL =
  'SELECT id, title, status, env, approval_config, project_id FROM tasks WHERE id=?';
const BOB_MESSAGES_SQL =
  'SELECT role, data, created_at FROM messages WHERE task_id=? ORDER BY created_at';

/** Query Bob's SQLite DB for a task + its messages and build the transcript. A `livePending`
 *  approval (read from Bob's memory via the inspector) is merged in as the pending action. */
export async function readBobTranscript(
  dbPath: string, sessionId: string, livePending?: PendingApproval,
): Promise<FullTranscript> {
  const tasks = await queryBobDb<BobTaskRow>(dbPath, BOB_TASK_SQL, [sessionId]);
  if (tasks.length === 0) {
    throw new Error(`bob session ${sessionId} not found in ${dbPath}`);
  }
  const messages = await queryBobDb<BobRow>(dbPath, BOB_MESSAGES_SQL, [sessionId]);
  return buildTranscript(tasks[0], messages, livePending);
}

/**
 * Writes a full transcript export to `<historyDir>/<sessionId>.json` for the supervisor.
 * Returns the written path.
 */
// ── Claude transcript export ────────────────────────────────────────────────
// Claude Code stores each session as a JSONL file (one record per line). We build
// the same FullTranscript contract from it so the supervisor consumes Bob and
// Claude identically.

/** Minimal session metadata the Claude transcript builder needs. */
export interface ClaudeSessionMeta {
  sessionId: string;
  projectName: string;
  projectPath: string;
  status: string;
  title: string;
}

interface ClaudeJsonlRecord {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Pure: Claude JSONL lines + session metadata → FullTranscript. A `livePending`
 *  approval (from ClaudeApprover, carrying the live requestId) becomes the pending
 *  action so the supervisor can resolve it. Unit-tested. */
export function buildClaudeTranscript(
  session: ClaudeSessionMeta, lines: string[], livePending?: PendingApproval,
): FullTranscript {
  const turns: ExportTurn[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    let rec: ClaudeJsonlRecord;
    try { rec = JSON.parse(trimmed) as ClaudeJsonlRecord; } catch { continue; }
    if (rec.type !== 'user' && rec.type !== 'assistant') { continue; }

    const content = rec.message?.content;
    const text = extractText(content);
    const turn: ExportTurn = {
      index: turns.length,
      role: rec.type,
      text,
      timestamp: rec.timestamp ?? null,
    };

    if (Array.isArray(content)) {
      const toolCalls: ExportToolCall[] = [];
      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown;
          tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b?.type === 'tool_use') {
          toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: b.input ?? {}, permission: null });
        } else if (b?.type === 'tool_result') {
          turn.toolResult = {
            callId: String(b.tool_use_id ?? ''),
            name: '',
            permission: null,
            isError: Boolean(b.is_error),
            content: extractText(b.content),
          };
        }
      }
      if (toolCalls.length) { turn.toolCalls = toolCalls; }
    }
    turns.push(turn);
  }

  const pendingAction = livePending ? pendingFromApproval(livePending, 'Claude') : derivePendingAction(turns);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    source: 'claude',
    user: null,
    projectName: session.projectName,
    projectPath: session.projectPath,
    status: session.status,
    approvalConfig: null,
    title: session.title || '',
    turns,
    pendingAction,
    waitingReason: pendingAction
      ? `Awaiting approval for ${pendingAction.name ?? pendingAction.kind}.`
      : 'Session is paused awaiting the user.',
  };
}

export class SessionExporter {
  constructor(private readonly bobDbPath: string) {}

  async exportBob(sessionId: string, historyDir: string, livePending?: PendingApproval): Promise<string> {
    const transcript = await readBobTranscript(this.bobDbPath, sessionId, livePending);
    return this.writeExport(transcript, historyDir);
  }

  /** Read a Claude session's JSONL file, build the transcript, and write the export. */
  async exportClaude(
    session: ClaudeSessionMeta, filePath: string, historyDir: string, livePending?: PendingApproval,
  ): Promise<string> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const transcript = buildClaudeTranscript(session, raw.split('\n'), livePending);
    return this.writeExport(transcript, historyDir);
  }

  writeExport(transcript: FullTranscript, historyDir: string): string {
    fs.mkdirSync(historyDir, { recursive: true });
    const outPath = path.join(historyDir, `${transcript.sessionId}.json`);
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2), 'utf8');
    fs.renameSync(tmp, outPath);
    return outPath;
  }
}
