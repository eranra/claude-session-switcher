import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { RemoteSessionSource } from '../remote/RemoteSessionSource';
import type { PeerAddress } from '../remote/PeerDiscovery';
import type { ClaudeSession } from '../SessionManager';

const olap: PeerAddress = {
  user: 'vpcuser', host: 'olap.ibm.com', raw: 'vpcuser@olap.ibm.com',
};

const bobRow = {
  id: 'a06dd356048c25a8a7c23ed6e6113898',
  project_id: 'file:/home/vpcuser/proj',
  title: 'check whether the user has sudo',
  status: 'running',
  first_message: 'check whether the user has sudo',
  created_at: 1788100000000,
  updated_at: 1788180000000,
  env: JSON.stringify({ staticEnvInfo: { primaryWorkspace: '/home/vpcuser/proj' } }),
};

const remoteWindow = {
  pid: 2795794,
  workspaceFolders: ['/home/vpcuser/proj'],
  ideCli: '/home/vpcuser/.bobide-server/bin/abc/bin/remote-cli/bobide',
  ipcSocket: '/run/user/1000/vscode-ipc-c0e76347.sock',
  openBobTaskIds: [bobRow.id],
  openClaudeSessionIds: ['2457b752-c8fe-4a70-bbb1-4d1d9842aeb6'],
  updatedAt: 1788180000000,
};

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    machineId: 'olapevolve:1000',
    windows: [remoteWindow],
    bobRows: [bobRow],
    claudeFiles: [],
    ...over,
  });
}

function sourceWith(run: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) {
  return new RemoteSessionSource({
    runner: { run } as never,
    discover: async () => [olap],
    parseSessionFile: async () => null,
    localMachineId: 'my-wsl-box:1000',
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-remote-test-')),
    ...over,
  });
}

describe('RemoteSessionSource', () => {
  it('turns a peer bob row into a session tagged with that peer', async () => {
    const src = sourceWith(vi.fn().mockResolvedValue(payload()));
    await src.refresh();

    const sessions = src.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(bobRow.id);
    expect(sessions[0].title).toBe('check whether the user has sudo');
    expect(sessions[0].source).toBe('bob');
    expect(sessions[0].peer).toBe('vpcuser@olap.ibm.com');
    // 'running' in Bob's schema means actively working.
    expect(sessions[0].status).toBe('working');
    expect(sessions[0].projectPath).toBe('/home/vpcuser/proj');
  });

  it('reports the peer as reachable', async () => {
    const src = sourceWith(vi.fn().mockResolvedValue(payload()));
    await src.refresh();
    expect(src.getPeerStatuses()).toEqual([
      { peer: 'vpcuser@olap.ibm.com', reachable: true, sessionCount: 1 },
    ]);
  });

  it('marks a peer unreachable when ssh fails, and surfaces why', async () => {
    const src = sourceWith(vi.fn().mockRejectedValue(new Error('Permission denied (publickey)')));
    await src.refresh();

    expect(src.getSessions()).toEqual([]);
    const [status] = src.getPeerStatuses();
    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/Permission denied/);
  });

  it('marks a peer unreachable on malformed output rather than throwing', async () => {
    // A peer without python3 prints an error to stderr and nothing usable to stdout.
    const src = sourceWith(vi.fn().mockResolvedValue('python3: command not found'));
    await src.refresh();
    expect(src.getSessions()).toEqual([]);
    expect(src.getPeerStatuses()[0].reachable).toBe(false);
  });

  it('drops a peer that turns out to be this machine', async () => {
    // Discovery can name the box we are already running on; SSHing to ourselves would
    // duplicate every local session in the panel.
    const src = sourceWith(vi.fn().mockResolvedValue(payload({ machineId: 'my-wsl-box:1000' })));
    await src.refresh();
    expect(src.getSessions()).toEqual([]);
    expect(src.getPeerStatuses()).toEqual([]);
  });

  it('tolerates a payload from an older build with fields missing', async () => {
    // The observed remote runs 0.5.0 against 0.6.3 locally, so absent fields are expected.
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      machineId: 'olapevolve:1000',
      windows: [{ pid: 1, workspaceFolders: ['/p'], updatedAt: 1 }],
    }));
    const src = sourceWith(run);
    await expect(src.refresh()).resolves.not.toThrow();
    expect(src.getSessions()).toEqual([]);
    expect(src.getPeerStatuses()[0].reachable).toBe(true);
  });

  it('keeps the live windows so a session can be focused on its own machine', async () => {
    const src = sourceWith(vi.fn().mockResolvedValue(payload()));
    await src.refresh();
    const owner = src.findOwnerWindow('/home/vpcuser/proj/sub/dir');
    expect(owner?.window.pid).toBe(2795794);
    expect(owner?.peer.raw).toBe('vpcuser@olap.ibm.com');
  });

  it('does not claim ownership of a path no peer window holds', async () => {
    const src = sourceWith(vi.fn().mockResolvedValue(payload()));
    await src.refresh();
    expect(src.findOwnerWindow('/home/eranra/local-thing')).toBeNull();
  });

  it('publishes the peer windows, which is what makes a peer session count as open', async () => {
    // The panel unions these into its open-id sets. Without them a peer session can never be
    // reported open — `readLiveWindows` only ever sees this machine — so it would be filed under
    // History however alive it actually is.
    const src = sourceWith(vi.fn().mockResolvedValue(payload()));
    await src.refresh();
    const windows = src.getPeerWindows();
    expect(windows.map(w => w.pid)).toEqual([2795794]);
    expect(windows[0].openClaudeSessionIds).toEqual(['2457b752-c8fe-4a70-bbb1-4d1d9842aeb6']);
    expect(windows[0].openBobTaskIds).toEqual([bobRow.id]);
  });

  it('publishes no windows for an unreachable peer', async () => {
    // A machine we could not reach this pass cannot vouch for anything being open on it.
    const src = sourceWith(vi.fn().mockRejectedValue(new Error('Permission denied (publickey).')));
    await src.refresh();
    expect(src.getPeerWindows()).toEqual([]);
  });
});

describe('RemoteSessionSource claude transcripts', () => {
  const sid = '2457b752-c8fe-4a70-bbb1-4d1d9842aeb6';

  function claudePayload(gz: string, mtime = 1788180000000) {
    return JSON.stringify({
      machineId: 'olapevolve:1000',
      windows: [remoteWindow],
      bobRows: [],
      claudeFiles: [{ sessionId: sid, path: `/home/vpcuser/.claude/projects/p/${sid}.jsonl`, size: 42, mtime, gz }],
    });
  }

  const transcript = JSON.stringify({ type: 'user', cwd: '/home/vpcuser/proj', message: { content: 'hello' } }) + '\n';
  const gz = zlib.gzipSync(Buffer.from(transcript, 'utf8')).toString('base64');

  it('materializes the transcript locally and parses it with the existing parser', async () => {
    // Reusing the real parser is the point: no second implementation of title/status rules.
    const parseSessionFile = vi.fn(async (p: string): Promise<ClaudeSession | null> => {
      expect(fs.readFileSync(p, 'utf8')).toBe(transcript);
      return {
        sessionId: sid, projectName: 'proj', projectPath: '/home/vpcuser/proj',
        title: 'hello', updatedAt: new Date(1788180000000), status: 'seen', source: 'claude',
      };
    });

    const src = sourceWith(vi.fn().mockResolvedValue(claudePayload(gz)), { parseSessionFile });
    await src.refresh();

    expect(parseSessionFile).toHaveBeenCalledTimes(1);
    const [session] = src.getSessions();
    expect(session.source).toBe('claude');
    expect(session.peer).toBe('vpcuser@olap.ibm.com');
  });

  it('sets the local copy mtime from the remote, so recency ordering stays correct', async () => {
    const mtime = 1788123456000;
    let seen = 0;
    const parseSessionFile = vi.fn(async (p: string) => {
      seen = fs.statSync(p).mtime.getTime();
      return null;
    });
    const src = sourceWith(vi.fn().mockResolvedValue(claudePayload(gz, mtime)), { parseSessionFile });
    await src.refresh();
    expect(seen).toBe(mtime);
  });

  it('asks the peer to skip transcripts it already sent unchanged', async () => {
    // Steady-state cost matters: without this the poll re-ships every open transcript each pass.
    const run = vi.fn().mockResolvedValue(claudePayload(gz));
    const parseSessionFile = vi.fn(async () => null);
    const src = sourceWith(run, { parseSessionFile });

    await src.refresh();
    await src.refresh();

    // base64, because the argument crosses a remote shell — see SshRunner.
    const knownArg = run.mock.calls[1][1].at(-1) as string;
    expect(knownArg).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(JSON.parse(Buffer.from(knownArg, 'base64').toString('utf8')))
      .toEqual({ [sid]: 1788180000000 });
  });

  it('sends the probe script on stdin, never as an argument', async () => {
    const run = vi.fn().mockResolvedValue(claudePayload(gz));
    const src = sourceWith(run, { parseSessionFile: vi.fn(async () => null) });
    await src.refresh();

    const [, argv, opts] = run.mock.calls[0];
    expect(argv.slice(0, 2)).toEqual(['python3', '-']);
    expect(opts.stdin).toContain('import base64');
  });

  it('reuses the previous session when the peer omits an unchanged transcript', async () => {
    const parseSessionFile = vi.fn(async (): Promise<ClaudeSession> => ({
      sessionId: sid, projectName: 'proj', projectPath: '/home/vpcuser/proj',
      title: 'hello', updatedAt: new Date(1788180000000), status: 'seen', source: 'claude',
    }));
    const run = vi.fn()
      .mockResolvedValueOnce(claudePayload(gz))
      // Second pass: unchanged, so no `gz` comes back.
      .mockResolvedValueOnce(JSON.stringify({
        machineId: 'olapevolve:1000',
        windows: [remoteWindow],
        bobRows: [],
        claudeFiles: [{ sessionId: sid, path: 'x', size: 42, mtime: 1788180000000 }],
      }));

    const src = sourceWith(run, { parseSessionFile });
    await src.refresh();
    await src.refresh();

    expect(parseSessionFile).toHaveBeenCalledTimes(1); // not re-parsed
    expect(src.getSessions().map(s => s.sessionId)).toEqual([sid]);
  });
});
