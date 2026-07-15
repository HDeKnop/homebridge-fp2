// Homebridge Config UI X custom-UI server for homebridge-fp2.
//
// Runs inside Homebridge Config UI X's Node process. Exposes RPC endpoints
// the wizard calls from the browser:
//   - "discover"        → mDNS scan for FP2 devices on the LAN
//   - "normalize-pin"   → coerce sticker (XXXX-XXXX) format to HAP (XXX-XX-XXX)
//   - "pair"            → pair live with an FP2 and enumerate its services so
//                         the wizard can show / rename them during setup
//   - "forget"          → delete a stored pairing (stale, or removing a device)
//
// Restarting Homebridge is deliberately NOT done here: Config UI X owns that, and
// shows its own "restart required" prompt once the config is saved.
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

    /** Lazily-created shared mDNS browser — see browser(). */
    this._browser = null;

    this.onRequest('/discover', this.handleDiscover.bind(this));
    this.onRequest('/forget', this.handleForget.bind(this));
    this.onRequest('/normalize-pin', this.handleNormalizePin.bind(this));
    this.onRequest('/pair', this.handlePair.bind(this));
    this.onRequest('/inspect', this.handleInspect.bind(this));
    // Liveness probe: lets the wizard tell "scan is slow" apart from "this
    // settings session has lost its channel to the server entirely".
    this.onRequest('/ping', async () => ({ pong: true }));

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
  async scanFp2s(timeoutMs = DISCOVERY_TIMEOUT_MS, { quick = false } = {}) {
    // The shared browser is long-lived and keeps re-querying in the background, so
    // once it has seen the LAN its cache is already current. "Save & add another"
    // only needs the list re-rendered (the device just paired is now configured) —
    // not another multicast sweep — so it can be served straight from that cache.
    if (quick) {
      const cached = this.browser().devices;
      if (cached.size > 0) return this.shapeForUi(cached);
    }
    let found;
    try {
      // Hard ceiling on the whole scan. scanAll is bounded internally, but this
      // process answers over an IPC channel that has no timeout of its own: if a
      // scan ever failed to settle, the request would hang forever with no error
      // shown — the browser's "Scan timed out" with nothing in the log. Fail loudly
      // instead.
      found = await Promise.race([
        this.browser().scanAll(timeoutMs),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`mDNS scan did not complete within ${timeoutMs + 5000}ms`)), timeoutMs + 5000)
        ),
      ]);
    } catch (err) {
      throw new RequestError('Could not run mDNS discovery: ' + (err?.message ?? err));
    }

    return this.shapeForUi(found);
  }

  /** Re-shape discovered devices to the field names the wizard UI expects
   *  (`host` = the address we'd connect on). */
  shapeForUi(found) {
    const fp2s = new Map();
    for (const [deviceId, dev] of found) {
      fp2s.set(deviceId, {
        name: dev.name,
        host: dev.address,
        allAddresses: dev.allAddresses ?? [dev.address],
        port: dev.port,
        deviceId,
        model: dev.model,
        serial: dev.serial,
        statusFlags: dev.statusFlags,
        featureFlags: dev.featureFlags,
        configNumber: dev.configNumber,
        availableToPair: dev.availableToPair,
      });
    }
    return fp2s;
  }

  /**
   * One mDNS browser for this process's lifetime.
   *
   * Emphatically NOT one per request: each browser binds its own UDP :5353
   * sockets, and repeatedly binding and tearing those down in a long-lived
   * process (the UI server is reused across every /discover and /pair) is a good
   * way to end up wedged, with a request that never settles. A single browser
   * also means a second scan answers instantly from the warm cache.
   */
  browser() {
    if (!this._browser) {
      this._browser = new Fp2Browser({
        // Route to stderr: stdout carries this process's IPC framing to the
        // Homebridge UI parent. debug included — socket/probe errors were
        // invisible when this swallowed them, which cost a day of diagnosis.
        info: msg => console.error(msg),
        warn: msg => console.error(msg),
        debug: msg => console.error(msg),
      });
      this._browser.start();
    }
    return this._browser;
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
  async handleDiscover({ quick = false } = {}) {
    // `quick` serves from the shared browser's live cache when it has one — used
    // when returning to the list after pairing, where the network hasn't changed
    // and only the pairing state needs re-reading.
    //
    // A failed or timed-out scan is NOT fatal: the pairing store below still
    // describes every device this plugin is paired to (the runtime refreshes
    // each record's host/port/name on every successful connect), so those are
    // returned regardless and the scan problem is reported as a warning.
    const startedAt = Date.now();
    let fp2s = new Map();
    let scanWarning = null;
    try {
      fp2s = await this.scanFp2s(DISCOVERY_TIMEOUT_MS, { quick });
    } catch (err) {
      scanWarning = err?.message ?? String(err);
    }

    // Index our stored pairings by both keys we might match on: the HAP deviceId
    // (proves this exact pairing is still valid) and the hardware serial (proves
    // it is the same physical device, even after a factory reset changed its
    // HAP id — which is exactly what makes a pairing go stale).
    let records = [];
    try {
      records = await this.pairingStore().listAll();
    } catch {
      /* store unreadable — treat everything as not-known-by-us */
    }
    const byDeviceId = new Map();
    const bySerial = new Map();
    for (const rec of records) {
      const id = normalizeDeviceId(rec.deviceId)?.toLowerCase();
      if (id) byDeviceId.set(id, rec);
      const serial = rec.serial?.trim().toLowerCase();
      if (serial) bySerial.set(serial, rec);
    }

    // Pairing records consumed by a live-scan device; whatever remains is
    // appended afterwards as a store-backed entry, so a paired device is in the
    // result even when the scan missed it entirely.
    const consumed = new Set();

    const devices = [...fp2s.values()].map(dev => {
      const id = normalizeDeviceId(dev.deviceId)?.toLowerCase();
      const serial = dev.serial?.trim().toLowerCase();
      const matchedById = id ? byDeviceId.get(id) : undefined;
      // Same hardware, different HAP id => the FP2 was factory-reset and the
      // stored credential is dead. Legacy records have no serial; fall back to
      // matching on the host/IP the record was keyed under.
      const matchedBySerial = serial ? bySerial.get(serial) : undefined;
      const legacyByHost = !matchedById && !matchedBySerial ? records.find(r => !r.serial && r.host === dev.host) : undefined;
      const staleRecord = !matchedById ? (matchedBySerial ?? legacyByHost) : undefined;

      const record = matchedById ?? staleRecord;
      if (record) consumed.add(record);
      return {
        ...dev,
        knownByUs: matchedById !== undefined,
        storedHost: record?.host ?? null,
        /** True when we hold a pairing for this hardware that can never work
         *  again — the device was reset. The UI offers "Forget pairing". */
        stalePairing: staleRecord !== undefined,
        /** The store key to pass to /forget — for ANY pairing we hold (stale or
         *  valid), since "Remove device" has to delete a working device's pairing
         *  too. Null when we hold no pairing at all. */
        pairingKey: record ? (record.serial?.trim() || record.host) : null,
        staleDeviceId: staleRecord ? (normalizeDeviceId(staleRecord.deviceId) ?? null) : null,
      };
    });

    // Store-backed entries: pairings the scan didn't surface this round. The
    // record's host/port were refreshed on the runtime's last successful
    // connect, so they are the best-known coordinates — mark them `fromStore`
    // so the UI can say "last known address" rather than implying a live
    // sighting. This is what keeps the wizard's device set consistent with the
    // running platform's even when multicast is flaky.
    for (const rec of records) {
      if (consumed.has(rec)) continue;
      devices.push({
        name: rec.name ?? this.nameFromSerial(rec.serial),
        host: rec.host,
        allAddresses: [rec.host],
        port: rec.port,
        deviceId: normalizeDeviceId(rec.deviceId) ?? rec.deviceId,
        availableToPair: false,
        knownByUs: true,
        storedHost: rec.host,
        stalePairing: false,
        pairingKey: rec.serial?.trim() || rec.host,
        staleDeviceId: null,
        fromStore: true,
      });
    }

    // stderr → surfaces as [homebridge-fp2] in the Homebridge UI log. This
    // completion line is what makes a silent/slow scan diagnosable from logs.
    const fromStore = devices.filter(d => d.fromStore).length;
    console.error(
      `[fp2-ui] /discover done in ${Date.now() - startedAt}ms: ${devices.length} device(s)` +
        (fromStore ? ` (${fromStore} from store)` : '') +
        (scanWarning ? `, scan warning: ${scanWarning}` : '')
    );

    return {
      devices: devices.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      scanWarning,
    };
  }

  /**
   * Derive the FP2's mDNS instance name from its hardware serial: the firmware
   * names every unit `Presence-Sensor-FP2-<last 4 hex of serial>`. Fallback for
   * records written before the store carried `name` — it's what lets such a
   * record still match a config entry whose `host` is the bonjour name.
   */
  nameFromSerial(serial) {
    const s = (serial ?? '').trim();
    return /^[0-9A-Fa-f]{12}$/.test(s) ? `Presence-Sensor-FP2-${s.slice(-4).toUpperCase()}` : null;
  }

  /**
   * Delete a stored pairing. Used by the wizard's "Forget pairing" button when a
   * pairing has gone stale (the FP2 was factory-reset, so its HAP identity — and
   * therefore the saved credential — no longer exists).
   *
   * Deliberately an explicit user action rather than an automatic cleanup: the
   * pairing file is the only thing standing between a working FP2 and a factory
   * reset, so the plugin never removes one on its own.
   *
   * Input: { key } — the store key from /discover's `pairingKey` (serial for
   * records written by current versions, host/IP for legacy ones).
   */
  async handleForget({ key, configHost } = {}) {
    const store = this.pairingStore();
    const keys = new Set();
    if (typeof key === 'string' && key) keys.add(key);

    // An offline device isn't in the scan, so the UI has no pairing key for it —
    // only the config host. Resolve the record ourselves so "Remove device" can't
    // leave an orphaned credential behind. Records may be keyed by serial (current)
    // or host/IP (legacy), and a legacy one is keyed by the resolved IP rather than
    // the config host, so match on the record's own fields too.
    if (typeof configHost === 'string' && configHost) {
      keys.add(configHost);
      try {
        for (const rec of await store.listAll()) {
          if (rec.host === configHost) keys.add(store.keyFor(rec));
        }
      } catch {
        /* store unreadable — fall through with whatever keys we have */
      }
    }

    if (keys.size === 0) {
      throw new RequestError('key or configHost is required');
    }
    try {
      for (const k of keys) await store.clear(k);
    } catch (err) {
      throw new RequestError('Could not remove the stored pairing: ' + (err?.message ?? err));
    }
    return { forgotten: true, keys: [...keys] };
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
      // The browser cache has the freshest record for this device — take the
      // mDNS instance name (and serial) from it so this pairing can be matched
      // to its config entry later without a live scan. Match on the normalized
      // id: the cache keys on the mDNS colon form, while AccessoryPairingID may
      // be hap-controller's hex-ASCII form.
      const wantId = normalizeDeviceId(pairedDeviceId)?.toLowerCase();
      const cached = [...this.browser().devices.values()].find(
        d => normalizeDeviceId(d.deviceId)?.toLowerCase() === wantId
      );
      await store.save({
        deviceId: pairedDeviceId,
        host: configHost,
        port: target.port,
        pairing,
        pairedAt: new Date().toISOString(),
        serial: cached?.serial,
        name: cached?.name,
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

}

(() => new Fp2UiServer())();
