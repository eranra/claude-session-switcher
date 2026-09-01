import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEASE_TTL_MS, ReaderLease, leaseIsFree, parseLease } from '../../telegram/lease';

let dir: string;
let leasePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-lease-'));
  leasePath = path.join(dir, 'telegram.lock');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

describe('parseLease', () => {
  it('reads a well-formed record', () => {
    expect(parseLease('{"pid":7,"expiresAt":99,"host":"box"}'))
      .toEqual({ pid: 7, expiresAt: 99, host: 'box' });
  });

  it('rejects junk rather than inventing a holder', () => {
    expect(parseLease('not json')).toBeNull();
    expect(parseLease('{"pid":"seven","expiresAt":1}')).toBeNull();
    expect(parseLease('{"pid":7}')).toBeNull();
  });
});

describe('leaseIsFree', () => {
  it('treats an absent lease as free', () => {
    expect(leaseIsFree(null, 1000, alive)).toBe(true);
  });

  it('treats an expired lease as free', () => {
    expect(leaseIsFree({ pid: 1, expiresAt: 999, host: '' }, 1000, alive)).toBe(true);
  });

  it('holds a live, unexpired lease', () => {
    expect(leaseIsFree({ pid: 1, expiresAt: 2000, host: '' }, 1000, alive)).toBe(false);
  });

  it('frees a lease whose holder is gone, without waiting out the TTL', () => {
    // A crashed window must not leave the machine without a reader for the whole timeout.
    expect(leaseIsFree({ pid: 1, expiresAt: 9999, host: '' }, 1000, dead)).toBe(true);
  });
});

describe('ReaderLease', () => {
  function lease(pid: number, now: () => number, isAlive = alive): ReaderLease {
    return new ReaderLease({ leasePath, pid, now, isAlive });
  }

  it('acquires an unheld lease', async () => {
    const a = lease(1, () => 1000);
    expect(await a.tryAcquire()).toBe(true);
    expect(a.isHolder).toBe(true);
  });

  it('gives exactly one winner when two windows race', async () => {
    const a = lease(1, () => 1000);
    const b = lease(2, () => 1000);
    const [gotA, gotB] = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
    expect([gotA, gotB].filter(Boolean)).toHaveLength(1);
  });

  it('renews for the current holder and refuses the other window', async () => {
    const a = lease(1, () => 1000);
    const b = lease(2, () => 1000);
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await a.tryAcquire()).toBe(true);
  });

  it('extends the expiry on each renewal', async () => {
    let now = 1000;
    const a = lease(1, () => now);
    await a.tryAcquire();
    const first = parseLease(fs.readFileSync(leasePath, 'utf8'))!.expiresAt;
    now = 5000;
    await a.tryAcquire();
    const second = parseLease(fs.readFileSync(leasePath, 'utf8'))!.expiresAt;
    expect(second).toBeGreaterThan(first);
  });

  it('lets another window take over once the lease expires', async () => {
    let now = 1000;
    const a = lease(1, () => now);
    expect(await a.tryAcquire()).toBe(true);
    now = 1000 + LEASE_TTL_MS + 1;
    const b = lease(2, () => now);
    expect(await b.tryAcquire()).toBe(true);
    // The displaced window must notice it no longer holds it, and stop reading.
    expect(await a.tryAcquire()).toBe(false);
    expect(a.isHolder).toBe(false);
  });

  it('takes over immediately from a dead holder', async () => {
    const a = lease(1, () => 1000);
    await a.tryAcquire();
    const b = new ReaderLease({ leasePath, pid: 2, now: () => 1000, isAlive: () => false });
    expect(await b.tryAcquire()).toBe(true);
  });

  it('releases so another window can take over at once', async () => {
    const a = lease(1, () => 1000);
    await a.tryAcquire();
    await a.release();
    expect(fs.existsSync(leasePath)).toBe(false);
    const b = lease(2, () => 1000);
    expect(await b.tryAcquire()).toBe(true);
  });

  it('does not delete a lease another window has taken', async () => {
    const a = lease(1, () => 1000);
    await a.tryAcquire();
    // Somebody else has taken it since; releasing must not remove their claim.
    fs.writeFileSync(leasePath, JSON.stringify({ pid: 2, expiresAt: 9e12, host: '' }));
    await a.release();
    expect(parseLease(fs.readFileSync(leasePath, 'utf8'))?.pid).toBe(2);
  });

  it('creates the directory it needs', async () => {
    const nested = new ReaderLease({
      leasePath: path.join(dir, 'a', 'b', 'lock'), pid: 1, now: () => 1000,
    });
    expect(await nested.tryAcquire()).toBe(true);
  });
});
