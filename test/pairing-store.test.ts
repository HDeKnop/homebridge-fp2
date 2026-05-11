import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PairingStore } from '../src/pairing-store.js';
import type { StoredPairing } from '../src/types.js';

const sample: StoredPairing = {
  deviceId: 'AA:BB:CC:DD:EE:FF',
  host: '192.168.1.42',
  port: 80,
  pairing: {
    AccessoryPairingID: 'AA:BB:CC:DD:EE:FF',
    AccessoryLTPK: 'deadbeef',
    iOSDevicePairingID: 'cafebabe-cafe-babe-cafe-babecafebabe',
    iOSDeviceLTSK: 'sekrit',
    iOSDeviceLTPK: 'pubkey',
  },
  pairedAt: '2026-05-08T12:00:00.000Z',
};

describe('PairingStore', () => {
  let dir: string;
  let store: PairingStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fp2-pairing-test-'));
    store = new PairingStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no file exists for a host', async () => {
    expect(await store.load('192.168.1.42')).toBeNull();
  });

  it('round-trips a save → load', async () => {
    await store.save(sample);
    const loaded = await store.load('192.168.1.42');
    expect(loaded).not.toBeNull();
    expect(loaded?.deviceId).toBe('AA:BB:CC:DD:EE:FF');
    expect(loaded?.pairing.iOSDeviceLTSK).toBe('sekrit');
  });

  it('writes the file with mode 0600 for credential safety', async () => {
    await store.save(sample);
    const { stat } = await import('node:fs/promises');
    const safe = '192.168.1.42'.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stats = await stat(join(dir, `${safe}.json`));
    // Mask out file-type bits; only check perms.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('sanitizes hosts so a colon-bearing host cannot escape the dir', async () => {
    await store.save({ ...sample, host: 'fe80::1%en0' });
    const loaded = await store.load('fe80::1%en0');
    expect(loaded).not.toBeNull();
    // The on-disk file name must not contain colons or percent signs.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toMatch(/[:%]/);
  });

  it('clear() removes the file', async () => {
    await store.save(sample);
    await store.clear('192.168.1.42');
    expect(await store.load('192.168.1.42')).toBeNull();
  });

  it('clear() is a no-op when no file exists', async () => {
    await expect(store.clear('192.168.1.99')).resolves.toBeUndefined();
  });

  it('rethrows on truly corrupted JSON (callers decide how to recover)', async () => {
    const safe = '192.168.1.42'.replace(/[^a-zA-Z0-9._-]/g, '_');
    await writeFile(join(dir, `${safe}.json`), '{not valid json');
    await expect(store.load('192.168.1.42')).rejects.toThrow();
  });

  it('persistence survives a fresh PairingStore instance against the same dir', async () => {
    await store.save(sample);
    const fresh = new PairingStore(dir);
    const loaded = await fresh.load('192.168.1.42');
    expect(loaded?.deviceId).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('writes pretty JSON on disk (so a sysadmin can read it)', async () => {
    await store.save(sample);
    const safe = '192.168.1.42'.replace(/[^a-zA-Z0-9._-]/g, '_');
    const raw = await readFile(join(dir, `${safe}.json`), 'utf8');
    expect(raw).toContain('\n  "deviceId":');
  });
});
