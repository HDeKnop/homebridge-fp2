import { join } from 'node:path';

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { Fp2Accessory } from './accessory.js';
import { Fp2HapClient } from './hap-client.js';
import { sanitizeHapName } from './mappers.js';
import { PairingStore } from './pairing-store.js';
import { DEFAULT_POLL_SECONDS, PLATFORM_NAME, PLUGIN_NAME, STORAGE_SUBDIR } from './settings.js';
import type { Fp2DeviceConfig, Fp2PlatformConfig } from './types.js';

interface ManagedDevice {
  cfg: Fp2DeviceConfig;
  client: Fp2HapClient;
  accessory: PlatformAccessory;
  handler: Fp2Accessory;
}

export class FP2Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly devices: ManagedDevice[] = [];
  private readonly pairingStore: PairingStore;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.pairingStore = new PairingStore(join(api.user.storagePath(), STORAGE_SUBDIR));

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch(err => {
        this.log.error(`device discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    this.api.on('shutdown', () => {
      this.shutdown().catch(err => {
        this.log.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`restoring cached accessory: ${accessory.displayName} (${accessory.UUID})`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private validateDevice(d: Fp2DeviceConfig): string | null {
    if (!d.name) return 'missing name';
    if (!d.host) return 'missing host';
    if (!d.pin) return 'missing pin';
    // Don't echo the pin itself — validation errors end up pasted into
    // public bug reports.
    if (!/^\d{3}-\d{2}-\d{3}$/.test(d.pin)) return 'pin must be formatted as ###-##-### (8 digits with dashes)';
    return null;
  }

  private async discoverDevices(): Promise<void> {
    const cfg = this.config as Fp2PlatformConfig;
    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    if (devices.length === 0) {
      // Deliberately fall through to the prune loop below: an explicitly
      // emptied config should also remove the cached accessories.
      this.log.warn('No FP2 devices configured. Add a "devices" array to the AqaraFP2 platform config.');
    }

    const desiredUuids = new Set<string>();

    for (const d of devices) {
      const issue = this.validateDevice(d);
      if (issue) {
        this.log.error(`Skipping FP2 "${d.name ?? '<unnamed>'}": ${issue}`);
        // Keep the cached accessory (if any) while the user fixes the config —
        // pruning it here would silently destroy room/automation assignments
        // over what may be a typo.
        if (d.host) desiredUuids.add(this.api.hap.uuid.generate(`fp2:${d.host}`));
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`fp2:${d.host}`);
      if (desiredUuids.has(uuid)) {
        this.log.error(`Skipping duplicate FP2 config entry for host "${d.host}" ("${d.name}") — each host may appear only once.`);
        continue;
      }
      desiredUuids.add(uuid);

      // HAP-NodeJS 2.0 validates accessory names strictly (alphanumeric +
      // space + apostrophe only). Sanitize at the source so cached
      // accessories don't get persisted with invalid displayName values.
      const safeName = sanitizeHapName(d.name, 'FP2');
      const accessory = this.cachedAccessories.get(uuid) ?? new this.api.platformAccessory(safeName, uuid, this.api.hap.Categories.SENSOR);
      accessory.displayName = safeName;
      accessory.context.host = d.host;
      accessory.context.name = d.name;

      const client = new Fp2HapClient(d, this.pairingStore, this.log);
      const handler = new Fp2Accessory(this, accessory, client, d);

      if (this.cachedAccessories.has(uuid)) {
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
        this.log.info(`registered new FP2 accessory "${d.name}"`);
      }

      this.devices.push({ cfg: d, client, accessory, handler });

      // Start the watchdog up front so a wedged/never-completing first connect
      // still gets retried (it doesn't depend on connect() resolving).
      client.startWatchdog();
      // Kick off connection. We deliberately do not await — Homebridge should
      // continue starting up even if a single FP2 is offline.
      client
        .connect()
        .then(() => {
          client.startPolling(d.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS);
        })
        .catch(err => {
          this.log.error(`[${d.name}] initial connect failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    // Prune cached accessories no longer in config.
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!desiredUuids.has(uuid)) {
        this.log.info(`removing orphaned cached accessory "${accessory.displayName}"`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  private async shutdown(): Promise<void> {
    this.log.info('shutting down FP2 clients');
    await Promise.all(this.devices.map(d => d.client.close()));
  }
}
