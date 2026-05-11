import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
