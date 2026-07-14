// Homebridge Config UI X custom-UI server for homebridge-fp2.
//
// Runs inside Homebridge Config UI X's Node process. Exposes RPC endpoints
// the wizard calls from the browser:
//   - "discover"        → mDNS scan for FP2 devices on the LAN
//   - "normalize-pin"   → coerce sticker (XXXX-XXXX) format to HAP (XXX-XX-XXX)
//   - "pair"            → pair live with an FP2 and enumerate its services so
//                         the wizard can show / rename them during setup
//   - "restart-bridge"  → ask Config UI X to restart Homebridge
//
// mDNS cannot run in the browser; that's the whole reason this server exists.
// Browsing is delegated to the plugin's own compiled Fp2Browser (bonjour-service
// based) — the same module the runtime plugin uses, so the wizard and the
// running plugin can never disagree about what's on the network. It replaced
// hap-controller's IPDiscovery, whose unmaintained `dnssd` backend silently
// dropped FP2s and made this scan return 0, 1 or 5 devices at random.

import { join } from 'node:path';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { HttpClient } from 'hap-controller';

// Reuse the plugin's compiled, dependency-free helpers (parser is type-only
// dependent; pairing-store + settings pull only pure leaf modules). This keeps
// the wizard's pairing identical to what the runtime plugin reads back.
import { Fp2Browser } from '../dist/fp2-browser.js';
import { parseAccessories } from '../dist/parser.js';
import { PairingStore } from '../dist/pairing-store.js';
import { normalizeDeviceId } from '../dist/mappers.js';
import { DISCOVERY_TIMEOUT_MS, STORAGE_SUBDIR } from '../dist/settings.js';

class Fp2UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/discover', this.handleDiscover.bind(this));
    this.onRequest('/normalize-pin', this.handleNormalizePin.bind(this));
    this.onRequest('/pair', this.handlePair.bind(this));
    this.onRequest('/inspect', this.handleInspect.bind(this));
    this.onRequest('/restart-bridge', this.handleRestartBridge.bind(this));

    // Tell the parent UI we're ready to receive requests.
    this.ready();
  }

  /**
   * Browse the LAN and return every Aqara FP2 seen, keyed by HAP deviceId.
   * Shared by /discover and /pair so both see the same shape.
   *
   * The browser actively re-issues its multicast query while the scan is in
   * flight, which is what makes this return the full set of devices rather than
   * however many announcements happened to survive WiFi packet loss.
   */
  async scanFp2s(timeoutMs = DISCOVERY_TIMEOUT_MS) {
    const log = {
      info: msg => console.log(msg),
      warn: msg => console.warn(msg),
      debug: () => {},
    };
    const browser = new Fp2Browser(log);
    let found;
    try {
      found = await browser.scanAll(timeoutMs);
    } catch (err) {
      throw new RequestError('Could not run mDNS discovery: ' + (err?.message ?? err));
    } finally {
      browser.stop();
    }

    // Re-shape to the field names the wizard UI expects (`host` = the address
    // we'd connect on).
    const fp2s = new Map();
    for (const [deviceId, dev] of found) {
      fp2s.set(deviceId, {
        name: dev.name,
        host: dev.address,
        allAddresses: dev.allAddresses ?? [dev.address],
        port: dev.port,
        deviceId,
        model: dev.model,
        statusFlags: dev.statusFlags,
        featureFlags: dev.featureFlags,
        configNumber: dev.configNumber,
        availableToPair: dev.availableToPair,
      });
    }
    return fp2s;
  }

  /** The PairingStore the runtime plugin reads/writes, under the HB storage path. */
  pairingStore() {
    return new PairingStore(join(this.homebridgeStoragePath, STORAGE_SUBDIR));
  }

  /**
   * Scan the LAN for `_hap._tcp` services, filter to Aqara FP2 devices, and
   * return one entry per device. Idempotent and safe to call repeatedly.
   *
   * Each device is annotated with `knownByUs`: true when this plugin already
   * holds a stored pairing whose deviceId matches. The wizard uses this to tell
   * "paired by this plugin" (offer Configure) apart from "paired by another
   * controller" (Apple Home / Aqara — both report HAP status flag sf=0).
   */
  async handleDiscover() {
    const fp2s = await this.scanFp2s();

    // Map normalized deviceId → stored pairing host, for devices we paired.
    const known = new Map();
    try {
      for (const rec of await this.pairingStore().listAll()) {
        const id = normalizeDeviceId(rec.deviceId)?.toLowerCase();
        if (id) known.set(id, rec.host);
      }
    } catch {
      /* store unreadable — treat everything as not-known-by-us */
    }

    const devices = [...fp2s.values()].map(dev => {
      const id = normalizeDeviceId(dev.deviceId)?.toLowerCase();
      const storedHost = id ? known.get(id) : undefined;
      return { ...dev, knownByUs: storedHost !== undefined, storedHost: storedHost ?? null };
    });

    return {
      devices: devices.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    };
  }

  /**
   * Read the service tree of an FP2 this plugin has already paired, using the
   * stored pairing — no re-pair. Powers the wizard's "Configure" flow so the
   * user can rename the main sensor, each zone, and the light sensor without
   * touching the (already valid) pairing.
   *
   * Input: { host?, deviceId?, address?, port? }
   *   - `host` is the config host the pairing was saved under (preferred key).
   *   - `deviceId` is the fallback key (e.g. if config host changed).
   *   - `address`/`port` from /discover override the stored host/port so we
   *     reach the device at its current address.
   *
   * Returns { ok: true, deviceId, port, zones, light } or throws RequestError.
   */
  async handleInspect({ host, deviceId, address, port } = {}) {
    const store = this.pairingStore();
    let record = null;
    if (host) record = await store.load(host).catch(() => null);
    if (!record && deviceId) record = await store.findByDeviceId(deviceId).catch(() => null);
    if (!record) {
      throw new RequestError(
        'No saved pairing was found for this FP2. It may have been paired by another ' +
          'controller, or its pairing file was removed. Reset the device and add it as new.'
      );
    }

    const targetAddress = address ?? record.host;
    const targetPort = port ?? record.port;
    const client = new HttpClient(record.deviceId, targetAddress, targetPort, record.pairing, {
      usePersistentConnections: true,
    });
    let parsed;
    try {
      parsed = parseAccessories(await client.getAccessories());
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new RequestError(
        'Could not reach the FP2 with its saved pairing: ' + (err?.message ?? err) + '. Check it is powered on and on the network.'
      );
    }
    await client.close().catch(() => undefined);

    return {
      ok: true,
      deviceId: record.deviceId,
      port: targetPort,
      zones: [...parsed.state.zones.values()].map(z => ({ name: z.name, slug: z.slug })),
      light: { present: parsed.lightLevelIid !== null },
    };
  }

  /**
   * Coerce a setup code in any common form to HAP-canonical `XXX-XX-XXX`.
   * Throws a RequestError if it isn't exactly 8 digits.
   */
  normalizePin(pin) {
    if (typeof pin !== 'string') {
      throw new RequestError('pin must be a string');
    }
    const digits = pin.replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new RequestError(
        `Setup code must contain exactly 8 digits — got ${digits.length}. ` + 'It usually looks like "1234-5678" on the sticker.'
      );
    }
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}`;
  }

  async handleNormalizePin({ pin } = {}) {
    return { pin: this.normalizePin(pin) };
  }

  /**
   * Pair live with an FP2 during the wizard and enumerate its services so the
   * user can rename them. Persists the pairing under the same store the runtime
   * plugin reads (keyed by the host string the wizard will write to config), so
   * the next Homebridge start reuses it instead of pairing again.
   *
   * Input: { pin, configHost, address?, port?, deviceId?, featureFlags? }
   *   - `configHost` is the identifier the wizard will save as `host`.
   *   - For a discovered device, `address`/`port`/`deviceId`/`featureFlags`
   *     come straight from /discover so we can pair without re-scanning.
   *   - For manual entry only `configHost` is known, so we scan to resolve it.
   *
   * Returns:
   *   - { paired: true, pin, deviceId, port, zones: [{name, slug}], light: {present} }
   *   - { paired: false, pin } when the device couldn't be resolved (manual
   *     fallback) — the wizard then defers pairing to runtime as before.
   */
  async handlePair({ pin, configHost, address, port, deviceId, featureFlags } = {}) {
    const normalizedPin = this.normalizePin(pin);

    if (!configHost || typeof configHost !== 'string') {
      throw new RequestError('configHost is required');
    }

    // Resolve a live address/port/ff. Prefer values supplied from /discover;
    // otherwise scan and match by deviceId or host/name (manual-entry path).
    let target = address && port ? { address, port, featureFlags: featureFlags ?? 0, deviceId, availableToPair: true } : null;
    if (!target) {
      const fp2s = await this.scanFp2s();
      const wantHost = configHost.toLowerCase();
      for (const dev of fp2s.values()) {
        const idMatch = deviceId && dev.deviceId?.toLowerCase() === String(deviceId).toLowerCase();
        const hostMatch =
          dev.host?.toLowerCase() === wantHost ||
          dev.name?.toLowerCase() === wantHost ||
          (dev.allAddresses ?? []).some(a => a.toLowerCase() === wantHost);
        if (idMatch || hostMatch) {
          target = {
            address: dev.host,
            port: dev.port,
            featureFlags: dev.featureFlags,
            deviceId: dev.deviceId,
            availableToPair: dev.availableToPair,
          };
          break;
        }
      }
    }

    if (!target) {
      // Couldn't find it on the network — let the wizard fall back to saving
      // config and pairing at runtime.
      return { paired: false, pin: normalizedPin };
    }

    if (target.availableToPair === false) {
      throw new RequestError(
        'This FP2 reports it is already paired with another controller. ' +
          'Remove it from Apple Home (Home app → device → Settings → Remove Accessory), ' +
          'or factory-reset it (10-second long-press), then scan again.'
      );
    }

    // FP2 advertises ff=2 (software auth only). bit 0 (1) = MFi coprocessor →
    // PairSetupWithAuth (method 1); otherwise PairSetup (method 0).
    const pairMethod = target.featureFlags & 0x01 ? 1 : 0;
    const setupDeviceId = target.deviceId ?? configHost;

    let pairing;
    const setupClient = new HttpClient(setupDeviceId, target.address, target.port);
    try {
      await setupClient.pairSetup(normalizedPin, pairMethod);
      pairing = setupClient.getLongTermData();
    } catch (err) {
      await setupClient.close().catch(() => undefined);
      throw new RequestError(this.describePairError(err));
    }
    await setupClient.close().catch(() => undefined);
    if (!pairing) {
      throw new RequestError('Pairing completed but no pairing data was returned. Try again.');
    }

    const pairedDeviceId = pairing.AccessoryPairingID ?? setupDeviceId;

    // Read the service tree with the freshly established pairing.
    let parsed;
    const client = new HttpClient(pairedDeviceId, target.address, target.port, pairing, { usePersistentConnections: true });
    try {
      const accessories = await client.getAccessories();
      parsed = parseAccessories(accessories);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw new RequestError('Paired, but could not read the FP2 service list: ' + (err?.message ?? err));
    }
    await client.close().catch(() => undefined);

    // Persist the pairing so the runtime plugin reuses it (no double-pair).
    try {
      const store = new PairingStore(join(this.homebridgeStoragePath, STORAGE_SUBDIR));
      await store.save({
        deviceId: pairedDeviceId,
        host: configHost,
        port: target.port,
        pairing,
        pairedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Non-fatal: the runtime plugin can still pair itself. Surface nothing
      // blocking, but the FP2 is now paired to this credential, so warn.
      throw new RequestError(
        'Paired with the FP2 but could not save the pairing file: ' +
          (err?.message ?? err) +
          '. Restart the FP2 (unplug 5s) before retrying so it can be paired fresh.'
      );
    }

    return {
      paired: true,
      pin: normalizedPin,
      deviceId: pairedDeviceId,
      port: target.port,
      zones: [...parsed.state.zones.values()].map(z => ({ name: z.name, slug: z.slug })),
      light: { present: parsed.lightLevelIid !== null },
    };
  }

  /** Turn a hap-controller pair-setup error into a user-facing message. */
  describePairError(err) {
    const raw = err?.message ?? String(err);
    if (/M4:\s*Error:\s*2\b/i.test(raw)) {
      return 'The setup code appears to be wrong. Double-check the 8-digit code on the FP2 sticker (Aqara prints it as XXXX-XXXX).';
    }
    if (/M4:\s*(?:Empty TLV|Error:\s*3\b)|MaxTries/i.test(raw)) {
      return 'The FP2 is temporarily refusing pairing (likely rate-limited after repeated attempts). Power-cycle it (unplug USB-C, wait 5s, plug back in), then scan again.';
    }
    return `Pairing failed (${raw}). Check that the FP2 is powered on, reachable, and not already paired with another controller.`;
  }

  /**
   * Attempt to restart the Homebridge child bridge via the Config UI X REST
   * API (POST /api/server/restart). Works when auth is disabled or when the
   * UI is accessible on the default port without credentials. Falls back
   * gracefully so the caller can show a "restart manually" message.
   */
  async handleRestartBridge() {
    const uiPort = process.env.HOMEBRIDGE_UI_PORT ?? '8581';
    try {
      const res = await fetch(`http://localhost:${uiPort}/api/server/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok || res.status === 200 || res.status === 204) {
        return { restarted: true };
      }
      // 401/403 = auth required — tell the UI to show manual instructions.
      return { restarted: false, message: 'Please restart Homebridge manually to apply the new config.' };
    } catch {
      return { restarted: false, message: 'Please restart Homebridge manually to apply the new config.' };
    }
  }
}

(() => new Fp2UiServer())();
