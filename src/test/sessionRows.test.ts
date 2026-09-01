import { describe, expect, it } from 'vitest';
import { bobRowToSession, type BobTaskRow } from '../sessionRows';

// This mapping is shared by the local Bob scan and the remote peer path. Its whole purpose is
// that a peer's row renders identically to a local one, so these cases pin the shared behaviour.

function row(over: Partial<BobTaskRow> = {}): BobTaskRow {
  return {
    id: 'a06dd356048c25a8a7c23ed6e6113898',
    project_id: 'file:/home/vpcuser/proj',
    title: 'check whether the user has sudo',
    status: 'active',
    first_message: 'check whether the user has sudo',
    created_at: 1788100000000,
    updated_at: 1788180000000,
    env: JSON.stringify({ staticEnvInfo: { primaryWorkspace: '/home/vpcuser/proj' } }),
    ...over,
  };
}

describe('bobRowToSession', () => {
  it('maps a row to a local session with no peer tag', () => {
    const s = bobRowToSession(row());
    expect(s).not.toBeNull();
    expect(s?.sessionId).toBe('a06dd356048c25a8a7c23ed6e6113898');
    expect(s?.source).toBe('bob');
    expect(s?.peer).toBeUndefined();
  });

  it('tags a session with the peer that owns it', () => {
    expect(bobRowToSession(row(), 'vpcuser@olap.ibm.com')?.peer).toBe('vpcuser@olap.ibm.com');
  });

  it("treats Bob's 'running' as working and everything else as finished", () => {
    // Bob's 'active' means a finished task, which is the opposite of what the word suggests.
    expect(bobRowToSession(row({ status: 'running' }))?.status).toBe('working');
    expect(bobRowToSession(row({ status: 'active' }))?.status).toBe('finished');
  });

  it('does not try to guess a blocked state the row cannot see', () => {
    // `tasks.status` reads 'running' whether Bob is executing a tool or sitting on a permission
    // prompt. Distinguishing those needs the live pending approval, which the view provider folds
    // in — so this mapping must stay at 'working' rather than guessing.
    expect(bobRowToSession(row({ status: 'running' }))?.status).toBe('working');
  });

  it('falls back to the first message when there is no title', () => {
    expect(bobRowToSession(row({ title: '', first_message: 'do the thing' }))?.title)
      .toBe('do the thing');
  });

  it('drops a row with no usable title, the way an empty new chat has none', () => {
    // Observed on the real peer: a freshly opened Bob chat has an empty title and no first
    // message. The local scan hides those, so the remote path must hide them too.
    expect(bobRowToSession(row({ title: '', first_message: '' }))).toBeNull();
    expect(bobRowToSession(row({ title: '', first_message: null as unknown as string }))).toBeNull();
  });

  it('truncates a long title', () => {
    const long = 'x'.repeat(200);
    expect(bobRowToSession(row({ title: long }))?.title).toHaveLength(60);
  });

  it('prefers the primary workspace from env', () => {
    const s = bobRowToSession(row({
      project_id: 'file:/wrong',
      env: JSON.stringify({ staticEnvInfo: { primaryWorkspace: '/right' }, workspace: '/also-wrong' }),
    }));
    expect(s?.projectPath).toBe('/right');
    expect(s?.projectName).toBe('right');
  });

  it('falls back to workspace, then to project_id', () => {
    expect(bobRowToSession(row({ env: JSON.stringify({ workspace: '/from-workspace' }) }))?.projectPath)
      .toBe('/from-workspace');
    expect(bobRowToSession(row({ env: '{}', project_id: 'file:/from-id' }))?.projectPath)
      .toBe('/from-id');
  });

  it('survives malformed env json', () => {
    const s = bobRowToSession(row({ env: 'not json', project_id: 'file:/fallback' }));
    expect(s?.projectPath).toBe('/fallback');
  });

  it('leaves the project path empty when nothing supplies one', () => {
    const s = bobRowToSession(row({ env: 'not json', project_id: 'notafileuri' }));
    expect(s?.projectPath).toBe('');
    expect(s?.projectName).toBe('');
  });
});
