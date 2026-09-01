import * as path from 'path';
import type { ClaudeSession } from './SessionManager';
import { bobStatus } from './sessionStatus';

/**
 * Turning raw agent-store rows into sessions.
 *
 * This lives outside `SessionManager` because the same rows now arrive from two places: the local
 * Bob database, and a peer machine's database read over SSH. Mapping them in one function is what
 * keeps a remote row rendering identically to a local one — if this logic were duplicated for the
 * remote path, the two would drift the first time either changed.
 *
 * Deliberately free of `vscode` and of any filesystem access, so it is pure and cheap to test.
 */

/** A row of Bob's `tasks` table, as selected by `BOB_TASKS_SQL`. */
export interface BobTaskRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  first_message: string;
  created_at: number;
  updated_at: number;
  env: string;
}

/**
 * Map one Bob task row to a session, or null when the row carries no usable title.
 *
 * `peer` tags a session that came from another machine; omit it for local rows.
 *
 * The status here is only what the row itself can support: `tasks.status` reads `running` whether
 * Bob is executing a tool or sitting on a permission prompt, so it cannot tell those apart. A live
 * pending approval is folded in later, once, by the view provider — see `resolveDisplayStatus`.
 */
export function bobRowToSession(row: BobTaskRow, peer?: string): ClaudeSession | null {
  const title = (row.title || row.first_message || '').slice(0, 60);
  if (!title) { return null; }

  const projectPath = bobProjectPath(row);
  const session: ClaudeSession = {
    sessionId: row.id,
    projectName: projectPath ? path.basename(projectPath) : '',
    projectPath,
    title,
    updatedAt: new Date(row.updated_at),
    // Bob's 'running' means actively processing; its 'active' means a finished task. The rule,
    // and that trap, live in sessionStatus.ts alongside Claude's.
    status: bobStatus(row.status),
    source: 'bob',
  };
  if (peer) { session.peer = peer; }
  return session;
}

/** Where a Bob task's workspace lives, preferring the richest source in its `env` blob. */
function bobProjectPath(row: BobTaskRow): string {
  try {
    const env = JSON.parse(row.env) as {
      workspace?: string;
      staticEnvInfo?: { primaryWorkspace?: string };
    };
    const fromEnv = env.staticEnvInfo?.primaryWorkspace ?? env.workspace ?? '';
    if (fromEnv) { return fromEnv; }
  } catch { /* fall through to project_id */ }
  // project_id is a "file:/path" URI.
  if (typeof row.project_id === 'string' && row.project_id.startsWith('file:')) {
    return row.project_id.slice('file:'.length);
  }
  return '';
}
