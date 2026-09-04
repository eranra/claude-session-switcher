/**
 * `session-sitter learn` — the terminal surface of the miner.
 *
 * The interesting assertions are the refusals. The command reads a machine-local, privacy-loaded trail
 * and writes into a policy corpus, so "it did nothing and said why" has to be a first-class outcome
 * with an exit code, not a silent zero: an unconfigured corpus exits 1 naming the variable, a held lock
 * exits 2 saying so, and a run that correctly proposed nothing prints the reason it found.
 *
 * Every fixture is invented. No real path, no real project name.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import { instructionText, run } from '../../cli/learn';
import { main } from '../../cli/index';
import { fakeIo } from './fakeIo';

const record = (command: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  ts: '2026-08-25T09:00:00.000Z',
  sessionId: 's-A',
  cwd: '/w/api',
  tool: 'Bash',
  inputSummary: command,
  light: 'green',
  decision: 'allow',
  clause: null,
  actor: 'model',
  latencyMs: 2000,
  rewritten: false,
  rev: null,
  call: { tool_name: 'Bash', input: { command } },
  ...over,
});

/**
 * A scratch data dir, installed into the process environment.
 *
 * `learn` reads its settings from the environment, the way a hook does, so the test has to as well.
 * Restored by the caller — a leaked `SESSION_SITTER_DATA_DIR` would send another test's writes into
 * this one's directory.
 */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) { delete process.env[k]; } }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
    }
  }
}

function scratch(records: DecisionRecord[] = []): { dir: string; corpus: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cli-'));
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cli-corpus-'));
  if (records.length > 0) {
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
      records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return { dir, corpus };
}

describe('session-sitter learn', () => {
  it('is listed in the top-level help', async () => {
    const io = fakeIo();
    expect(await main(['--help'], io)).toBe(0);
    expect(io.text()).toContain('learn');
  });

  it('prints its own help and says the output is inert', async () => {
    const io = fakeIo();
    expect(await run(['--help'], io)).toBe(0);
    expect(io.text()).toContain('status: proposed');
    expect(io.text()).toContain('--dry-run');
  });

  it('exits 2 on a positional argument rather than treating it as a path', async () => {
    await expect(run(['practices.md'], fakeIo())).rejects.toThrow(/takes no arguments/);
  });

  it('exits 2 on an unknown flag', async () => {
    await expect(run(['--porpose'], fakeIo())).rejects.toThrow(/unknown option/);
  });

  it('says `learn` has never run, rather than printing an empty table', async () => {
    const { dir } = scratch();
    const io = fakeIo();
    await withEnv({ SESSION_SITTER_DATA_DIR: dir }, () => run(['--status'], io));
    expect(io.text()).toContain('never run');
  });

  it('--accumulate folds and nudges, and writes no clause file', async () => {
    const { dir, corpus } = scratch([
      record('pnpm test', { sessionId: 's-A', ts: '2026-08-25T09:00:00.000Z' }),
      record('pnpm test --watch', { sessionId: 's-B', ts: '2026-08-27T09:00:00.000Z' }),
      record('pnpm test --filter x', { sessionId: 's-C', ts: '2026-09-01T09:00:00.000Z' }),
    ]);
    const io = fakeIo();
    const code = await withEnv({ SESSION_SITTER_DATA_DIR: dir }, () => run(['--accumulate'], io));
    expect(code).toBe(0);
    expect(io.text()).toContain('crossed the support floor');
    expect(io.text()).toContain('session-sitter learn');
    expect(fs.existsSync(path.join(corpus, 'data'))).toBe(false);
  });

  it('refuses to run with no corpus checkout configured, naming the variable', async () => {
    const { dir } = scratch([record('pnpm test')]);
    await expect(withEnv(
      { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: undefined, KB_SITTER_LOCAL_REPO: undefined },
      () => run([], fakeIo()),
    )).rejects.toThrow(/KNOWLEDGE_LOCAL_REPO/);
  });

  it('reports a run that correctly proposed nothing, and says why', async () => {
    const { dir, corpus } = scratch([record('pnpm test')]);   // one record clears no bar
    const io = fakeIo();
    const code = await withEnv(
      { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: corpus, SESSION_SITTER_USER: 'devon' },
      () => run(['--dry-run'], io));
    expect(code).toBe(0);
    expect(io.text()).toContain('Nothing proposed');
    expect(io.text()).toContain('0 model call(s)');
  });

  it('--json prints the run line, with the model count in it', async () => {
    const { dir, corpus } = scratch([record('pnpm test')]);
    const io = fakeIo();
    await withEnv(
      { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: corpus, SESSION_SITTER_USER: 'devon' },
      () => run(['--json', '--dry-run'], io));
    const line = JSON.parse(io.text()) as { model: { calls: number }; exitReason: string };
    expect(line.model.calls).toBe(0);
    expect(line.exitReason).not.toBe('ok');
  });

  it('--quiet prints nothing at all, on the same code path', async () => {
    const { dir, corpus } = scratch([record('pnpm test')]);
    const io = fakeIo();
    const code = await withEnv(
      { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: corpus, SESSION_SITTER_USER: 'devon' },
      () => run(['--quiet', '--dry-run'], io));
    expect(code).toBe(0);
    expect(io.text()).toBe('');
  });
});

describe('learn --publish', () => {
  it('writes one aggregate of counts, names no command, and runs no git', async () => {
    const { dir, corpus } = scratch([
      record('pnpm verify', { sessionId: 's-A', ts: '2026-08-25T09:00:00.000Z' }),
      record('pnpm verify --fix', { sessionId: 's-B', ts: '2026-08-27T09:00:00.000Z' }),
      record('pnpm verify', { sessionId: 's-C', ts: '2026-09-01T09:00:00.000Z' }),
    ]);
    const io = fakeIo();
    const env = { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: corpus };
    // Fold first, the way a real run does: `--publish` reports what the fold has, not what the
    // trail has, so publishing before any fold is honestly empty rather than quietly re-reading.
    await withEnv(env, () => run(['--accumulate'], fakeIo()));
    expect(await withEnv(env, () => run(['--publish'], io))).toBe(0);

    const files = fs.readdirSync(path.join(corpus, 'data', 'aggregates'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^h-[0-9a-f]{12}\.json$/);
    const text = fs.readFileSync(path.join(corpus, 'data', 'aggregates', files[0]), 'utf8');
    // Counts, and no command: the payload names `pnpm` nowhere, at any depth.
    expect(text).not.toContain('pnpm');
    expect(text).not.toContain('verify');
    expect(text).not.toContain('/w/api');
    expect(JSON.parse(text).shapes[0].occurrences).toBe(3);
    // No clause file was written, and nothing was pushed: the human is handed the commands.
    expect(fs.existsSync(path.join(corpus, 'data', 'knowledge'))).toBe(false);
    expect(io.text()).toContain('git -C');
    expect(io.text()).toContain('Nothing has been sent anywhere');
  });

  it('publishes a pseudonym by default and the real host only under the opt-in', async () => {
    const { dir, corpus } = scratch([
      record('pnpm verify', { sessionId: 's-A', ts: '2026-08-25T09:00:00.000Z' }),
      record('pnpm verify', { sessionId: 's-B', ts: '2026-08-27T09:00:00.000Z' }),
      record('pnpm verify', { sessionId: 's-C', ts: '2026-09-01T09:00:00.000Z' }),
    ]);
    const env = { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: corpus };
    await withEnv(env, () => run(['--accumulate'], fakeIo()));
    await withEnv(env, () => run(['--publish'], fakeIo()));
    await withEnv(env, () => run(['--publish', '--allow-host-names'], fakeIo()));
    const files = fs.readdirSync(path.join(corpus, 'data', 'aggregates')).sort();
    expect(files).toHaveLength(2);
    expect(files.filter(f => f.startsWith('h-'))).toHaveLength(1);
    // The raw one is this machine's short hostname, which is exactly why it is opt-in.
    const raw = files.find(f => !f.startsWith('h-'))!;
    expect(raw.replace('.json', '')).toBe(
      os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-'));
  });

  it('refuses to publish with no corpus configured, rather than writing somewhere', async () => {
    const { dir } = scratch();
    await expect(withEnv(
      { SESSION_SITTER_DATA_DIR: dir, KNOWLEDGE_LOCAL_REPO: undefined,
        KB_SITTER_LOCAL_REPO: undefined },
      () => run(['--publish'], fakeIo()),
    )).rejects.toThrow(/KNOWLEDGE_LOCAL_REPO/);
  });
});

describe('the repo instruction files it reads, and the one directory it does not', () => {
  it('reads CLAUDE.md and .claude/rules/*.md, in that order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-instr-'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'always run pnpm test\n', 'utf8');
    fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'rules', 'a.md'), 'never force push\n', 'utf8');
    const text = instructionText(dir)!;
    expect(text).toContain('pnpm test');
    expect(text).toContain('force push');
  });

  it('is undefined when a repo states nothing, so the dedupe cannot silently suppress', () => {
    expect(instructionText(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-instr-')))).toBeUndefined();
  });
});
