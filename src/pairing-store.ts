import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeDeviceId } from './mappers.js';
import type { StoredPairing } from './types.js';

/**
 * On-disk storage for HAP pairing data. One JSON file per FP2, keyed by host
 * since the deviceId isn't known until first connection.
 *
 * Files live under {storagePath}/homebridge-fp2/{host}.json.
 */
export class PairingStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(host: string): string {
    const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.baseDir, `${safe}.json`);
  }

  async load(host: string): Promise<StoredPairing | null> {
    try {
      const raw = await readFile(this.fileFor(host), 'utf8');
      return JSON.parse(raw) as StoredPairing;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Fallback lookup when `load(host)` misses — usually because the user
   * changed `host` in config (e.g. moved from IP to mDNS name, or vice
   * versa, or DHCP renamed the device's hostname). Scans every pairing
   * file in the store and returns the one whose deviceId matches.
   *
   * Returns null if nothing matches, or if the store directory is empty
   * / does not yet exist.
   */
  async findByDeviceId(deviceId: string): Promise<StoredPairing | null> {
    const { readdir } = await import('node:fs/promises');
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // Normalize both sides so the hex-encoded ASCII form hap-controller
    // emits ("33343a38463a...") matches the canonical mDNS form
    // ("34:8F:C1:..."). Without this, the lookup silently misses.
    const want = normalizeDeviceId(deviceId)?.toLowerCase();
    if (!want) return null;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.baseDir, entry), 'utf8');
        const record = JSON.parse(raw) as StoredPairing;
        const have = normalizeDeviceId(record.deviceId)?.toLowerCase();
        if (have === want) return record;
      } catch {
        // Skip unreadable / unparseable files — don't let one corrupt
        // pairing block recovery of others.
        continue;
      }
    }
    return null;
  }

  async save(record: StoredPairing): Promise<void> {
    const file = this.fileFor(record.host);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  async clear(host: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    try {
      await rm(this.fileFor(host));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
