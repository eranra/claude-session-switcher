import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COMMAND_TTL_MS,
  claimCommand,
  cmdDir,
  dropCommand,
  expiredCommands,
  newCommandId,
  parseCommand,
  parseResult,
  postCommand,
  postResult,
  readPendingCommands,
  sweep,
  takeResults,
  type BusCommand,
} from '../../telegram/bus';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bus-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function command(over: Partial<BusCommand> = {}): BusCommand {
  return {
    cmdId: 'cmd-1',
    kind: 'sendText',
    sessionId: 's1',
    source: 'claude',
    text: 'hello',
    threadId: 42,
    issuedAt: 1000,
    ...over,
  };
}

describe('newCommandId', () => {
  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCommandId()));
    expect(ids.size).toBe(50);
  });
});

describe('parseCommand', () => {
  it('round-trips a command', () => {
    expect(parseCommand(JSON.stringify(command()))).toEqual(command());
  });

  it('rejects an unknown source rather than guessing an agent', () => {
    // Guessing here would mean sending a prompt through the wrong sender.
    expect(parseCommand(JSON.stringify({ ...command(), source: 'gemini' }))).toBeNull();
  });

  it('rejects a command with no thread to report back into', () => {
    const rest: Record<string, unknown> = { ...command() };
    delete rest.threadId;
    expect(parseCommand(JSON.stringify(rest))).toBeNull();
  });

  it('rejects junk', () => {
    expect(parseCommand('{{')).toBeNull();
  });
});

describe('parseResult', () => {
  it('round-trips a result', () => {
    const result = {
      cmdId: 'cmd-1', ok: true, detail: 'Sent.', threadId: 42, pid: 7, finishedAt: 2000,
    };
    expect(parseResult(JSON.stringify(result))).toEqual(result);
  });

  it('rejects a result with no verdict', () => {
    expect(parseResult(JSON.stringify({ cmdId: 'x' }))).toBeNull();
  });
});

describe('post and read', () => {
  it('reads back a posted command', async () => {
    await postCommand(command(), home);
    const pending = await readPendingCommands(home);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('hello');
  });

  it('returns nothing when the bus has never been used', async () => {
    expect(await readPendingCommands(home)).toEqual([]);
  });

  it('orders commands oldest first', async () => {
    await postCommand(command({ cmdId: 'b', issuedAt: 2000 }), home);
    await postCommand(command({ cmdId: 'a', issuedAt: 1000 }), home);
    expect((await readPendingCommands(home)).map(c => c.cmdId)).toEqual(['a', 'b']);
  });

  it('never exposes a half-written file', async () => {
    // Writes go to a temp name and are renamed into place, so a reader cannot see a partial file.
    await postCommand(command(), home);
    const files = fs.readdirSync(cmdDir(home));
    expect(files).toEqual(['cmd-1.json']);
  });

  it('ignores a stray temp file left by an interrupted write', async () => {
    fs.mkdirSync(cmdDir(home), { recursive: true });
    fs.writeFileSync(path.join(cmdDir(home), 'cmd-9.json.tmp-abcd'), '{"partial":');
    expect(await readPendingCommands(home)).toEqual([]);
  });
});

describe('claimCommand', () => {
  it('lets exactly one window claim a command', async () => {
    await postCommand(command(), home);
    const [first, second] = await Promise.all([
      claimCommand('cmd-1', 100, home),
      claimCommand('cmd-1', 200, home),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('removes a claimed command from the pending list', async () => {
    await postCommand(command(), home);
    expect(await claimCommand('cmd-1', 100, home)).toBe(true);
    expect(await readPendingCommands(home)).toEqual([]);
  });

  it('fails for a command that does not exist', async () => {
    expect(await claimCommand('nope', 100, home)).toBe(false);
  });
});

describe('takeResults', () => {
  it('returns each result exactly once', async () => {
    await postResult({
      cmdId: 'cmd-1', ok: true, detail: 'Sent.', threadId: 42, pid: 7, finishedAt: 2000,
    }, home);
    expect(await takeResults(home)).toHaveLength(1);
    // Taken means reported — a second read must not report it again.
    expect(await takeResults(home)).toHaveLength(0);
  });

  it('returns nothing when there are no results', async () => {
    expect(await takeResults(home)).toEqual([]);
  });
});

describe('expiredCommands', () => {
  it('finds commands nobody claimed in time', () => {
    const stale = command({ issuedAt: 1000 });
    const fresh = command({ cmdId: 'cmd-2', issuedAt: 5000 });
    const now = 1000 + COMMAND_TTL_MS + 1;
    expect(expiredCommands([stale, fresh], now).map(c => c.cmdId)).toEqual(['cmd-1']);
  });

  it('leaves a command alone at exactly the deadline', () => {
    expect(expiredCommands([command({ issuedAt: 1000 })], 1000 + COMMAND_TTL_MS)).toEqual([]);
  });
});

describe('dropCommand', () => {
  it('removes a command and tolerates being called twice', async () => {
    await postCommand(command(), home);
    await dropCommand('cmd-1', home);
    expect(await readPendingCommands(home)).toEqual([]);
    await expect(dropCommand('cmd-1', home)).resolves.toBeUndefined();
  });
});

describe('sweep', () => {
  it('removes files older than the cutoff and keeps fresh ones', async () => {
    await postCommand(command(), home);
    const old = path.join(cmdDir(home), 'cmd-old.taken.55');
    fs.writeFileSync(old, '{}');
    fs.utimesSync(old, new Date(0), new Date(0));
    const removed = await sweep(60_000, Date.now(), home);
    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(await readPendingCommands(home)).toHaveLength(1);
  });

  it('does nothing on an unused bus', async () => {
    expect(await sweep(60_000, Date.now(), home)).toBe(0);
  });
});
