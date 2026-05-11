import { EventEmitter } from 'node:events';

import type { Logging } from 'homebridge';
import type { PairingData } from 'hap-controller';

import { discoverFp2ByHost } from './discovery.js';
import { PairingStore } from './pairing-store.js';
import {
  type Accessories,
  detectResetCharacteristic,
  parseAccessories,
} from './parser.js';
import {
  DISCOVERY_TIMEOUT_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
} from './settings.js';
import type {
  Fp2DeviceConfig,
  Fp2State,
} from './types.js';

interface HapEventMessage {
  characteristics: Array<{ aid: number; iid: number; value: unknown }>;
}

export type Fp2HapEvents = {
  state: (state: Fp2State) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;
};

export declare interface Fp2HapClient {
  on<K extends keyof Fp2HapEvents>(event: K, listener: Fp2HapEvents[K]): this;
  emit<K extends keyof Fp2HapEvents>(event: K, ...args: Parameters<Fp2HapEvents[K]>): boolean;
}

// HttpClient type from hap-controller.
type HttpClientCtor = typeof import('hap-controller').HttpClient;
type HttpClientInstance = InstanceType<HttpClientCtor>;

export class Fp2HapClient extends EventEmitter {
  private client: HttpClientInstance | null = null;
  private state: Fp2State = {
    occupancy: false,
    lightLevel: null,
    zones: new Map(),
    reachable: false,
  };
  private deviceId: string | null = null;
  private serial: string | null = null;
  private model: string | null = null;
  private firmware: string | null = null;
  private hardware: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private primaryOccupancyIid: number | null = null;
  private lightLevelIid: number | null = null;
  /** Discovered or configured reset trigger, if any. Format `"aid.iid"`. */
  private resetCharId: string | null = null;
  /** When set, scheduleReconnect becomes a no-op — used for terminal config
   *  errors (wrong pin, rate-limit, already-paired) so we don't burn through
   *  the FP2's pair-setup attempt budget. Cleared on user-driven retry (eg.
   *  Homebridge restart, which spawns a fresh client). */
  private terminalReason: string | null = null;
  /** Listener references kept so we can detach on disconnect. */
  private eventHandler: ((msg: HapEventMessage) => void) | null = null;
  private eventDisconnectHandler: (() => void) | null = null;

  constructor(
    private readonly cfg: Fp2DeviceConfig,
    private readonly store: PairingStore,
    private readonly log: Logging,
  ) {
    super();
  }

  getState(): Fp2State {
    return this.state;
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  getSerialNumber(): string | null {
    return this.serial;
  }

  getModel(): string | null {
    return this.model;
  }

  getFirmwareRevision(): string | null {
    return this.firmware;
  }

  getHardwareRevision(): string | null {
    return this.hardware;
  }

  getResetCharId(): string | null {
    return this.resetCharId;
  }

  /**
   * Trigger the FP2's "reset presence" command by writing `true` (then `false`)
   * to the configured / auto-detected writable characteristic. No-op with a
   * warning if no candidate is known.
   */
  async triggerPresenceReset(): Promise<void> {
    if (!this.client) throw new Error('not connected');
    const id = this.resetCharId;
    if (!id) {
      this.log.warn(`[${this.cfg.name}] reset requested but no candidate characteristic detected; ` +
        'set resetCharId in config or open an issue with your FP2 firmware version');
      return;
    }
    this.log.info(`[${this.cfg.name}] writing reset trigger to ${id}`);
    try {
      await this.client.setCharacteristics({ [id]: true });
    } catch (err) {
      const msg = (err as Error).message;
      // Some firmwares expect 1 instead of true, or want a falling edge.
      this.log.debug(`[${this.cfg.name}] reset write (true) failed: ${msg} — retrying with value 1`);
      try {
        await this.client.setCharacteristics({ [id]: 1 });
      } catch (err2) {
        throw new Error(`reset write to ${id} failed: ${(err2 as Error).message}`);
      }
    }
  }

  /** Establish (or re-establish) the HAP session. Auto-pairs on first use,
   *  recovers from stale pairings by re-running pair-setup. */
  async connect(): Promise<void> {
    if (this.closed) return;
    this.detachClient();
    try {
      await this.connectWithRecovery(/* allowRepair */ true);
    } catch (err) {
      this.state.reachable = false;
      this.log.warn(`[${this.cfg.name}] connection failed: ${(err as Error).message}`);
      this.emit('error', err as Error);
      this.scheduleReconnect();
    }
  }

  /** Inner connect — optionally clears stale credentials and re-pairs. */
  private async connectWithRecovery(allowRepair: boolean): Promise<void> {
    const { HttpClient } = await import('hap-controller');
    const stored = await this.store.load(this.cfg.host);

    // Always discover via mDNS on connect — HAP accessories advertise on
    // ephemeral ports, so we cannot hard-code one and the port may even
    // change after a reboot. mDNS is also how we get the canonical deviceId.
    const discovered = await discoverFp2ByHost(this.cfg.host, DISCOVERY_TIMEOUT_MS, this.log);
    if (discovered) {
      this.log.info(
        `[${this.cfg.name}] discovered FP2: id=${discovered.deviceId} port=${discovered.port} model=${discovered.model} sf=${discovered.statusFlags}`,
      );
      if (discovered.model) this.model = discovered.model;
    } else {
      this.log.warn(`[${this.cfg.name}] mDNS discovery did not surface ${this.cfg.host} within ${DISCOVERY_TIMEOUT_MS}ms`);
    }

    // Resolve port: explicit config wins, then mDNS, then stored pairing's
    // port (kept fresh on every successful connect so reboots survive).
    const port = this.cfg.port ?? discovered?.port ?? stored?.port;
    if (!port) {
      throw new Error(
        `cannot connect to ${this.cfg.host}: no port available — mDNS discovery yielded nothing and config has no "port". ` +
        'Set "port" in config (you can find it via `dns-sd -L <fp2-name> _hap._tcp local.`).',
      );
    }

    let pairing: PairingData;
    let deviceId: string;

    if (stored) {
      deviceId = stored.deviceId;
      pairing = stored.pairing;
      this.log.debug(`[${this.cfg.name}] using stored pairing for ${deviceId} on port ${port}`);

      // Validate by attempting getAccessories. If pair-verify fails the
      // pairing is stale (FP2 was reset/re-paired elsewhere) and we recover.
      this.client = new HttpClient(deviceId, this.cfg.host, port, pairing, {
        usePersistentConnections: true,
      });
      try {
        const accessories = await this.client.getAccessories();
        this.parseAccessories(accessories);
        // Refresh stored port if mDNS surfaced a new one.
        if (discovered && discovered.port !== stored.port) {
          await this.store.save({ ...stored, port: discovered.port });
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        const stale = /pair[\- ]?verify|not paired|forbidden|401|403|470/i.test(msg);
        if (stale && allowRepair) {
          this.log.warn(`[${this.cfg.name}] stored pairing rejected (${msg}); clearing and re-pairing`);
          await this.client.close().catch(() => undefined);
          this.client = null;
          await this.store.clear(this.cfg.host);
          await this.connectWithRecovery(/* allowRepair */ false);
          return;
        }
        throw err;
      }
    } else {
      deviceId = discovered?.deviceId ?? this.cfg.host;

      // Hard guard: if mDNS confirms the FP2 is already paired (sf=0), don't
      // even attempt pair-setup — it would fail and burn an attempt against
      // the FP2's lockout budget. Aligned with ebaauw/fp2-proxy's
      // `availableToPair` check, which we treat as a terminal config error
      // since user action (Remove from Home / factory reset) is required.
      if (discovered && !discovered.availableToPair) {
        this.markTerminalConfigError('FP2 already paired with another controller');
        throw new Error(
          `FP2 reports it is already paired (sf=${discovered.statusFlags}). ` +
          'Remove it from Apple Home (Home app → device → Settings → Remove Accessory), ' +
          'or factory-reset via 10s long-press, then restart Homebridge.',
        );
      }

      // Pick the pair method based on the FP2's advertised feature flags
      // ("ff" in mDNS TXT). bit 0 (1) = MFi coprocessor, bit 1 (2) = software
      // auth. The FP2 is software-auth-only (ff=2); using PairSetupWithAuth
      // (the hap-controller default) on it is wrong for spec-conformant
      // devices. PairMethods.PairSetup = 0, PairSetupWithAuth = 1.
      const supportsMfi = (discovered?.featureFlags ?? 0) & 0x01;
      const pairMethod = supportsMfi ? 1 : 0;
      this.log.debug(
        `[${this.cfg.name}] using pair method ${pairMethod} (${supportsMfi ? 'PairSetupWithAuth/MFi' : 'PairSetup/SW'}) ` +
        `based on ff=${discovered?.featureFlags ?? 'unknown'}`,
      );

      this.log.info(`[${this.cfg.name}] pairing with FP2 at ${this.cfg.host}:${port}…`);
      const setupClient = new HttpClient(deviceId, this.cfg.host, port);
      try {
        await setupClient.pairSetup(this.cfg.pin, pairMethod);
      } catch (err) {
        await setupClient.close().catch(() => undefined);
        const raw = (err as Error).message ?? '';
        // Classify the failure to give a useful message and decide whether
        // to keep retrying. M4 Error 2 = wrong pin; "MaxTries" / "M4: Empty TLV"
        // pattern after several attempts = device has rate-limited us.
        const wrongPin = /M4:\s*Error:\s*2\b/i.test(raw);
        const maxTries = /M4:\s*(?:Empty TLV|Error:\s*3\b)|MaxTries/i.test(raw);
        const alreadyPaired = (discovered?.statusFlags ?? 0x01) === 0;

        let advice: string;
        if (wrongPin) {
          advice = 'pin appears to be wrong. Double-check the 8-digit setup code on the FP2 sticker (Aqara prints it as XXXX-XXXX).';
          this.markTerminalConfigError(`wrong pin (M4 auth failure)`);
        } else if (maxTries) {
          advice = 'FP2 is temporarily refusing pair-setup (likely rate-limited after repeated wrong-pin attempts). Power-cycle the FP2 (unplug USB-C, wait 5s, plug back in) — Wi-Fi credentials persist. Then restart Homebridge.';
          this.markTerminalConfigError(`pair-setup rate-limited`);
        } else if (alreadyPaired) {
          advice = 'FP2 reports it is already paired with another controller. Remove it from Apple Home (or factory-reset via 10s long-press), then restart Homebridge.';
          this.markTerminalConfigError(`device already paired`);
        } else {
          advice = `unexpected pair-setup error. Check that ${this.cfg.host}:${port} is reachable and the FP2 is in setup mode.`;
        }
        throw new Error(`pair-setup failed (${raw}). ${advice}`);
      }
      const ltd = setupClient.getLongTermData();
      await setupClient.close().catch(() => undefined);
      if (!ltd) throw new Error('pair-setup completed but no pairing data returned');
      pairing = ltd;
      deviceId = pairing.AccessoryPairingID;
      await this.store.save({
        deviceId,
        host: this.cfg.host,
        port,
        pairing,
        pairedAt: new Date().toISOString(),
      });
      this.log.info(`[${this.cfg.name}] paired successfully (deviceId=${deviceId})`);

      this.client = new HttpClient(deviceId, this.cfg.host, port, pairing, {
        usePersistentConnections: true,
      });
      const accessories = await this.client.getAccessories();
      this.parseAccessories(accessories);
    }

    this.deviceId = deviceId;
    this.state.reachable = true;
    await this.installSubscriptions();

    this.reconnectDelay = RECONNECT_INITIAL_MS;
    this.emit('connected');
    this.emit('state', this.state);
    this.log.info(
      `[${this.cfg.name}] connected — occupancy=${this.state.occupancy} lux=${this.state.lightLevel ?? 'n/a'} zones=${this.state.zones.size}`,
    );
  }

  private async installSubscriptions(): Promise<void> {
    if (!this.client) return;
    const ids: string[] = [];
    for (const z of this.state.zones.values()) ids.push(`${z.aid}.${z.occupancyIid}`);
    if (this.primaryOccupancyIid) ids.push(`1.${this.primaryOccupancyIid}`);
    if (this.lightLevelIid) ids.push(`1.${this.lightLevelIid}`);

    if (ids.length === 0) {
      this.log.warn(`[${this.cfg.name}] no characteristics to subscribe to`);
      return;
    }

    try {
      await this.client.subscribeCharacteristics(ids);
    } catch (err) {
      this.log.warn(`[${this.cfg.name}] subscribe failed (${(err as Error).message}); polling will be sole update path`);
      return;
    }

    this.eventHandler = (msg: HapEventMessage) => {
      if (!msg?.characteristics) return;
      for (const ch of msg.characteristics) {
        this.applyCharacteristicUpdate(ch.aid, ch.iid, ch.value);
      }
      this.log.debug(
        `[${this.cfg.name}] event: occupancy=${this.state.occupancy} lux=${this.state.lightLevel ?? 'n/a'} zones=[${[...this.state.zones.values()].map(z => `${z.name}:${z.occupancy}`).join(', ')}]`,
      );
      this.emit('state', this.state);
    };
    this.eventDisconnectHandler = () => {
      this.log.warn(`[${this.cfg.name}] HAP event channel disconnected`);
      this.handleDisconnect('event-channel');
    };

    this.client.on('event', this.eventHandler);
    this.client.on('event-disconnect', this.eventDisconnectHandler);
    this.log.debug(`[${this.cfg.name}] subscribed to ${ids.length} characteristics`);
  }

  startPolling(intervalSeconds: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, intervalSeconds * 1000);
  }

  private async pollOnce(): Promise<void> {
    if (!this.client || this.closed) return;
    try {
      const ids: string[] = [];
      if (this.primaryOccupancyIid) ids.push(`1.${this.primaryOccupancyIid}`);
      if (this.lightLevelIid) ids.push(`1.${this.lightLevelIid}`);
      for (const z of this.state.zones.values()) ids.push(`${z.aid}.${z.occupancyIid}`);
      if (ids.length === 0) return;
      const result = await this.client.getCharacteristics(ids);
      for (const ch of result.characteristics ?? []) {
        if (typeof ch.aid === 'number' && typeof ch.iid === 'number') {
          this.applyCharacteristicUpdate(ch.aid, ch.iid, ch.value);
        }
      }
      if (!this.state.reachable) {
        this.state.reachable = true;
        this.emit('connected');
      }
      this.emit('state', this.state);
    } catch (err) {
      this.log.debug(`[${this.cfg.name}] poll failed: ${(err as Error).message}`);
      this.handleDisconnect('poll-failed');
    }
  }

  private parseAccessories(payload: Accessories): void {
    const parsed = parseAccessories(payload, { excludedZones: this.cfg.excludedZones });
    this.state.zones = parsed.state.zones;
    this.state.occupancy = parsed.state.occupancy;
    this.state.lightLevel = parsed.state.lightLevel;
    this.primaryOccupancyIid = parsed.primaryOccupancyIid;
    this.lightLevelIid = parsed.lightLevelIid;
    if (parsed.serial) this.serial = parsed.serial;
    if (parsed.model) this.model = parsed.model;
    if (parsed.firmware) this.firmware = parsed.firmware;
    if (parsed.hardware) this.hardware = parsed.hardware;

    const detection = detectResetCharacteristic(payload, this.cfg.resetCharId);
    this.resetCharId = detection.chosen?.id ?? null;
    if (detection.chosen?.reason === 'config-override') {
      this.log.info(`[${this.cfg.name}] reset characteristic pinned by config: ${detection.chosen.id}`);
    } else if (detection.chosen) {
      this.log.info(
        `[${this.cfg.name}] reset characteristic detected at ${detection.chosen.id} ` +
        `(${detection.chosen.reason}: "${detection.chosen.description}"). ` +
        'Override via resetCharId in config if this is wrong.',
      );
      if (detection.candidates.length > 1) {
        this.log.debug(`[${this.cfg.name}] other candidates: ${detection.candidates.slice(1).map(c => c.id).join(', ')}`);
      }
    } else {
      this.log.debug(`[${this.cfg.name}] no reset-presence candidate detected`);
    }
  }

  private applyCharacteristicUpdate(aid: number, iid: number, rawValue: unknown): void {
    const boolish = rawValue === 1 || rawValue === true;
    if (aid === 1 && iid === this.primaryOccupancyIid) {
      this.state.occupancy = boolish;
      return;
    }
    if (aid === 1 && iid === this.lightLevelIid) {
      if (typeof rawValue === 'number') this.state.lightLevel = rawValue;
      return;
    }
    for (const zone of this.state.zones.values()) {
      if (zone.aid === aid && zone.occupancyIid === iid) {
        zone.occupancy = boolish;
        return;
      }
    }
  }

  private handleDisconnect(reason: string): void {
    this.state.reachable = false;
    this.emit('disconnected', reason);
    this.detachClient();
    this.scheduleReconnect();
  }

  private detachClient(): void {
    if (this.client) {
      if (this.eventHandler) this.client.off('event', this.eventHandler);
      if (this.eventDisconnectHandler) this.client.off('event-disconnect', this.eventDisconnectHandler);
      this.client.close().catch(() => undefined);
      this.client = null;
    }
    this.eventHandler = null;
    this.eventDisconnectHandler = null;
  }

  private markTerminalConfigError(reason: string): void {
    this.terminalReason = reason;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    if (this.terminalReason) {
      this.log.warn(
        `[${this.cfg.name}] not retrying: ${this.terminalReason}. Fix the config or device state and restart Homebridge.`,
      );
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.log.debug(`[${this.cfg.name}] reconnect scheduled in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.detachClient();
  }
}
