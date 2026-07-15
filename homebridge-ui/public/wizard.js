/* global homebridge */
/*
 * Wizard client logic. Runs inside the Homebridge Config UI X iframe.
 * Talks to:
 *   - server.js (this plugin's UI server) via homebridge.request(...)
 *   - the parent Homebridge UI via homebridge.getPluginConfig() /
 *     updatePluginConfig() / savePluginConfig()
 *
 * State machine is intentionally trivial — keys are step names, transitions
 * are direct calls to `show(stepName)`. No back-stack: navigation is
 * forward-driven with explicit Back buttons that know which step to return to.
 */

const PLATFORM_NAME = 'AqaraFP2';
const STEP_ORDER = ['discover', 'pin', 'name', 'services', 'confirm'];

/* Client-side timeouts. This file cannot import the plugin's compiled
 * settings (it's a plain script served from public/), so these are named
 * here instead of inline where they're used. */
const DISCOVER_TIMEOUT_MS = 30_000; // full /discover round-trip, incl. UI-server startup slack
const CHECK_TIMEOUT_MS = 20_000;    // /check-known round-trip
const PING_TIMEOUT_MS = 3_000;      // liveness probe when a scan times out
const REMOVE_DISARM_MS = 5_000;     // armed "Remove device" button re-disarms after this

const state = {
  mode: 'pair',         // 'pair' (new device) | 'configure' (already paired by us)
  selectedDevice: null, // discovered service or {manual: true}
  matchedConfigHost: null, // existing config `host` to edit in place (configure mode)
  pin: null,            // canonical HAP form
  name: null,
  services: null,       // { zones: [{name, slug}], light: {present} } or null (no live pairing)
  options: { exposeZones: true, exposeLightSensor: true },
  names: { main: null, light: null, zones: {} }, // custom name overrides
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function show(stepName) {
  $$('.step').forEach((s) => {
    s.hidden = s.dataset.step !== stepName;
  });
  $$('.steps li').forEach((li) => {
    li.classList.toggle('current', li.dataset.step === stepName);
    // mark earlier steps as done for the progress bar look
    const i = STEP_ORDER.indexOf(li.dataset.step);
    const cur = STEP_ORDER.indexOf(stepName);
    li.classList.toggle('done', cur > i);
  });
  // Scroll to top inside the iframe so each step starts at the top.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* The host string the wizard will write as `host` in config — must match what
 * we hand to /pair so the saved pairing file is keyed identically. In configure
 * mode we reuse the existing config entry's host so the edit lands in place
 * (the FP2 may have been added under an IP/.local host rather than its name). */
function configHostFor(dev) {
  if (state.matchedConfigHost) return state.matchedConfigHost;
  if (!dev) return '';
  return dev.manual ? dev.host : (dev.name ?? dev.host ?? '');
}

/* Fetch the AqaraFP2 device blocks currently in config, keyed for lookup by
 * any identifier a discovered device might match (host, name, IP). */
async function loadConfiguredDevices() {
  try {
    const all = await homebridge.getPluginConfig();
    const platform = (all ?? []).find((p) => p.platform === PLATFORM_NAME);
    return Array.isArray(platform?.devices) ? platform.devices : [];
  } catch {
    return [];
  }
}

/* Find the config block for a discovered device, if one exists. Matches on the
 * device's stored-pairing host (most reliable), then mDNS name / address. */
function matchConfigBlock(dev, configured) {
  const candidates = [dev.storedHost, dev.name, dev.host, ...(dev.allAddresses ?? [])]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return configured.find((b) => b.host && candidates.includes(b.host.toLowerCase())) ?? null;
}

/* ─── Step 1: Discover ─────────────────────────────────────────────── */

/* The device list renders from a single view-model map — never by appending
 * during async work — so overlapping refreshes can't produce duplicate rows.
 * Keys are stable across the two render phases: anything with a config entry
 * keys on its config host, so the live-scan card REPLACES the instant
 * config-only card in place. */
let currentVms = new Map(); // key -> vm

const cfgKey = (block) => `cfg:${block.host.toLowerCase()}`;
const devKey = (dev) => `dev:${dev.deviceId}`;

/* A device we only know from config.json. Phase 1 renders these instantly
 * (pending = the scan is still running); after the scan, any block the scan
 * didn't surface degrades to "configured-offline" — still listed, still
 * removable, and Reconfigure will tell the user if it's truly unreachable. */
function buildConfigVm(block, pending) {
  return {
    key: cfgKey(block),
    category: pending ? 'configured-pending' : 'configured-offline',
    displayName: block.name ?? block.host,
    host: block.host,
    port: null,
    deviceId: null,
    metaNote: pending ? 'checking network…' : 'not reachable right now',
    pairingKey: null,
    staleDeviceId: null,
    configHost: block.host,
    dev: null,
    block,
  };
}

function buildLiveVm(dev, block, key) {
  // Four states, checked in this order:
  //  - stale: we hold a pairing for this hardware but the FP2 was factory-
  //    reset, so its HAP id changed and the credential is dead. Must be
  //    checked BEFORE `claimed`: such a device also reports sf=0, and calling
  //    it "paired elsewhere" sends the user off to remove it from Apple Home
  //    when the real fix is to forget the dead pairing here.
  //  - configured: we hold a VALID pairing (knownByUs). A config entry alone
  //    is not enough — after "Forget pairing" the entry still exists but the
  //    credential is gone, and offering "Configure" would just fail with
  //    "no saved pairing". Such a device has to be paired again, so it falls
  //    through to claimed/available like any other unpaired FP2.
  //  - claimed: paired by another controller (sf=0, not ours) — must be freed
  //    in Apple Home / Aqara first.
  //  - available: free to pair.
  // Two independent facts, which the UI used to collapse into one:
  //   knownByUs — we hold a valid HAP pairing for this device
  //   block     — it has an entry in config.json
  // "Paired but not in config" is a real state (it was just paired, or its
  // config entry was removed) and needs finishing, not the same badge as a
  // device that is fully configured and running.
  const category = dev.stalePairing
    ? 'stale'
    : dev.knownByUs && block
      ? 'configured'
      : dev.knownByUs
        ? 'needs-config'
        : !dev.availableToPair
          ? 'claimed'
          : 'available';
  dev._configBlock = block;
  return {
    key,
    category,
    displayName: block?.name ?? dev.name ?? 'Unknown FP2',
    host: dev.host,
    port: dev.port,
    deviceId: dev.deviceId,
    // fromStore: the server knows this device from its pairing record (kept
    // fresh by the running platform), not from a live mDNS sighting this scan.
    metaNote: dev.fromStore ? 'last known address' : null,
    pairingKey: dev.pairingKey ?? null,
    staleDeviceId: dev.staleDeviceId ?? null,
    configHost: block?.host ?? null,
    dev,
    block,
  };
}

const BADGES = {
  'configured': ['info', 'Configured'],
  'configured-pending': ['info', 'Configured'],
  'configured-offline': ['info', 'Configured'],
  'needs-config': ['info', 'Paired — needs setup'],
  'available': ['ok', 'Available'],
  'claimed': ['warn', 'Paired elsewhere'],
  'stale': ['warn', 'Stale pairing'],
};

function renderDeviceCard(vm) {
  const li = document.createElement('li');
  li.className = 'device';
  li.dataset.key = vm.key;
  li.dataset.category = vm.category;

  const [badgeKind, badgeText] = BADGES[vm.category];

  const metaParts = [escapeHtml(vm.host)];
  if (vm.port != null) metaParts.push(`port ${vm.port}`);
  if (vm.deviceId) metaParts.push(`<span class="mono">${escapeHtml(vm.deviceId)}</span>`);
  if (vm.metaNote) metaParts.push(escapeHtml(vm.metaNote));

  let body = '';
  if (vm.category === 'stale') {
    body = `
      <p class="device-note">The saved pairing no longer works — remove it, then pair again.</p>
      <details class="device-help">
        <summary>What happened?</summary>
        <p>This FP2 was factory-reset since it was paired here, so the saved
           pairing (HAP id <span class="mono">${escapeHtml(vm.staleDeviceId ?? '?')}</span>) can no
           longer work — the device now reports
           <span class="mono">${escapeHtml(vm.deviceId ?? '?')}</span>.
           Remove the dead pairing, then pair it again.</p>
      </details>`;
  } else if (vm.category === 'claimed') {
    body = `
      <p class="device-note">Paired with another controller — it has to be released before it can be added here.</p>
      <details class="device-help">
        <summary>How do I free it?</summary>
        <p>Open <strong>Aqara Home</strong> → tap the FP2 → and either
           use <em>Remove from Home</em>, or factory-reset the device
           (10-second long-press) before adding it here.</p>
      </details>`;
  } else if (vm.category === 'needs-config') {
    body = `
      <p class="device-note">Paired, but not in your config yet — finish setting it up to
         expose it to HomeKit.</p>`;
  } else if (vm.category === 'configured-offline') {
    body = `
      <p class="device-note">Didn't respond just now.</p>
      <details class="device-help">
        <summary>Is that a problem?</summary>
        <p>It's in your config but didn't respond — it may be slow to announce
           or briefly offline. Reconfiguring still needs it reachable to read
           its sensors.</p>
      </details>`;
  }

  const actions = [];
  if (vm.category === 'configured') {
    actions.push(`<button type="button" class="btn device-configure">Reconfigure</button>`);
  } else if (vm.category === 'needs-config') {
    actions.push(`<button type="button" class="btn primary device-configure">Finish setting up</button>`);
  } else if (vm.category === 'available') {
    actions.push(`<button type="button" class="btn primary device-pick">Use this device</button>`);
  } else if (vm.category === 'stale') {
    actions.push(`<button type="button" class="btn danger device-forget">Forget pairing</button>`);
  } else if (vm.category === 'configured-pending' || vm.category === 'configured-offline') {
    actions.push(`<button type="button" class="btn device-configure-offline">Reconfigure</button>`);
  }
  // "Remove device" is offered whenever this FP2 has a config entry — including
  // a working one, since removing a device you no longer want is a normal thing
  // to do. "Forget pairing" only drops the credential so the same sensor can be
  // re-paired; this removes the device from the plugin entirely.
  if (vm.configHost) {
    actions.push(`<button type="button" class="btn danger device-remove">Remove device</button>`);
  }

  li.innerHTML = `
    <div class="device-head">
      <div class="device-main">
        <div class="device-name">${escapeHtml(vm.displayName)}</div>
        <div class="device-meta">${metaParts.join('<span aria-hidden="true">·</span>')}</div>
      </div>
      <span class="badge ${badgeKind}">${badgeText}</span>
    </div>
    ${body}
    ${actions.length ? `<div class="device-actions">${actions.join('')}</div>` : ''}
  `;
  return li;
}

/* Groups render in this order; a header only appears when its group has rows.
 * "Your devices" comes first — it's the part the user already owns, painted
 * instantly in phase 1, so the window never opens onto an empty scan. */
const GROUPS = [
  { title: 'Your devices', categories: ['configured', 'needs-config', 'configured-pending', 'configured-offline'] },
  { title: 'Available to add', categories: ['available'] },
  { title: 'Needs attention', categories: ['stale', 'claimed'] },
];

/* Full synchronous rebuild from currentVms. Idempotent; the only code path
 * that touches #device-list children. */
function renderList() {
  const listEl = $('#device-list');
  listEl.innerHTML = '';
  const vms = [...currentVms.values()];
  for (const group of GROUPS) {
    const members = vms.filter((vm) => group.categories.includes(vm.category));
    if (members.length === 0) continue;
    const hdr = document.createElement('li');
    hdr.className = 'device-group-header';
    hdr.textContent = group.title;
    listEl.appendChild(hdr);
    for (const vm of members) listEl.appendChild(renderDeviceCard(vm));
  }
  listEl.hidden = currentVms.size === 0;
}

function setScanning(on, mode = 'scan') {
  const statusEl = $('#discover-status');
  if (on) {
    const empty = currentVms.size === 0;
    statusEl.classList.toggle('boxed', empty);
    statusEl.querySelector('.status-text').textContent =
      mode === 'check' ? 'Checking your devices…' : empty ? 'Scanning network…' : 'Scanning network for more…';
    $('#no-devices').hidden = true;
  }
  statusEl.hidden = !on;
}

/* Shown instead of a scan result when nothing is configured and the user
 * hasn't asked for a scan — the wizard doesn't enumerate the network unbidden. */
function showScanPrompt() {
  const emptyEl = $('#no-devices');
  const h3 = emptyEl.querySelector('h3');
  const p = emptyEl.querySelector('p');
  if (!emptyDefaults) emptyDefaults = { h3: h3.textContent, p: p.innerHTML };
  h3.textContent = 'No devices configured yet';
  p.textContent = 'Press Scan network to look for Aqara FP2 sensors on your network.';
  emptyEl.hidden = false;
}

/* A scan timeout has two very different causes; a quick liveness probe tells
 * them apart so the user gets the remedy that actually applies. `setText`
 * receives the refined message once the probe settles. */
function diagnoseTimeout(setText) {
  withTimeout(homebridge.request('/ping'), PING_TIMEOUT_MS, 'ping')
    .then(() => {
      setText(
        'The scan is responding slowly — this can happen right after a restart while the ' +
        'system is busy. Wait a moment and Scan again.'
      );
    })
    .catch(() => {
      setText(
        'The setup window has lost its connection to the server (this can happen after a ' +
        'Homebridge restart). Close this settings window and open it again.'
      );
    });
}

function scanFailureMessage(err) {
  return err?.message ?? 'Could not run mDNS discovery on the host.';
}

function showScanError(err) {
  const el = $('#discover-error');
  el.textContent = err?.timedOut
    ? 'Scan timed out — the setup server may still be starting up after a restart. Wait a moment and scan again.'
    : `Discovery failed: ${scanFailureMessage(err)}`;
  el.hidden = false;
  if (err?.timedOut) diagnoseTimeout((text) => { el.textContent = text; });
}

let emptyDefaults = null;
function showEmptyState(err) {
  const emptyEl = $('#no-devices');
  const h3 = emptyEl.querySelector('h3');
  const p = emptyEl.querySelector('p');
  if (!emptyDefaults) emptyDefaults = { h3: h3.textContent, p: p.innerHTML };
  if (err) {
    h3.textContent = err.timedOut ? 'Scan timed out' : 'Discovery failed';
    p.textContent = err.timedOut
      ? 'The setup server may still be starting up after a restart. Wait a moment and scan again.'
      : scanFailureMessage(err);
    if (err.timedOut) diagnoseTimeout((text) => { p.textContent = text; });
  } else {
    h3.textContent = emptyDefaults.h3;
    p.innerHTML = emptyDefaults.p;
  }
  emptyEl.hidden = false;
}

/* Guards against overlapping scans. Two runs racing (a rescan click while one is
 * still in flight, or a reset + init firing together) each clear the list and then
 * each append their own results — so every device renders twice. Serialising is
 * not enough on its own: a queued run would still repaint after the first, so
 * concurrent callers simply share the in-flight scan. */
let discoverInFlight = null;

/* Whether the user has run a full network scan in this session. Opening the
 * wizard only CHECKS the configured devices; enumerating everything on the LAN
 * is an explicit action ("Scan network"). Refreshes after a mutation stay in
 * whichever mode the user is in. */
let hasScanned = false;

/* `quick` serves from the UI server's warm browser cache instead of running a new
 * multicast sweep — used when returning to the list after pairing, where nothing
 * on the network has changed and we only need the pairing state re-read. */
async function runDiscover(quick = false) {
  if (discoverInFlight) return discoverInFlight;
  discoverInFlight = doRefresh('scan', quick === true).finally(() => {
    discoverInFlight = null;
  });
  return discoverInFlight;
}

/* Reachability check of the configured devices only — what the wizard does on
 * open. No device enumeration: new FP2s only appear after "Scan network". */
async function runCheck() {
  if (discoverInFlight) return discoverInFlight;
  discoverInFlight = doRefresh('check').finally(() => {
    discoverInFlight = null;
  });
  return discoverInFlight;
}

/* Re-sync the list after a mutation (remove/forget/save), staying in the mode
 * the user is in: full scan results if they scanned, config-check otherwise. */
function refreshList() {
  return hasScanned ? runDiscover(true) : runCheck();
}

async function doRefresh(mode, quick = false) {
  $('#discover-error').hidden = true;
  $('#no-devices').hidden = true;

  // PHASE 1 — instant paint from config. getPluginConfig() is a parent-frame
  // round-trip, no network: devices already set up appear immediately instead
  // of the window opening onto a bare "Scanning…" for the length of the sweep.
  const configured = await loadConfiguredDevices();
  currentVms = new Map(
    configured
      .filter((b) => b.host)
      .map((b) => {
        const vm = buildConfigVm(b, /* pending */ true);
        return [vm.key, vm];
      })
  );
  renderList();

  // Nothing configured and no scan requested: don't touch the network at all —
  // just invite the user to.
  if (mode === 'check' && currentVms.size === 0) {
    showScanPrompt();
    return;
  }
  setScanning(true, mode);

  // PHASE 2 — reconcile with the network.
  try {
    let devices;
    let scanWarning = null;
    if (mode === 'scan') {
      // The UI server can take a moment to come up right after a bridge restart;
      // a plain request would then spin forever. Bound it and surface a retry.
      ({ devices, scanWarning } = await withTimeout(
        homebridge.request('/discover', { quick }),
        DISCOVER_TIMEOUT_MS,
        'discover'
      ));
      hasScanned = true;
    } else {
      const hosts = configured.map((b) => b.host).filter(Boolean);
      ({ devices } = await withTimeout(
        homebridge.request('/check-known', { hosts }),
        CHECK_TIMEOUT_MS,
        'discover'
      ));
    }
    // The server answers with its store-backed devices even when the mDNS
    // sweep itself failed — surface that as a warning, not an error state.
    if (scanWarning) {
      const el = $('#discover-error');
      el.textContent = `Network scan had trouble (${scanWarning}) — showing known devices; new devices may be missing. Scan again to retry.`;
      el.hidden = false;
    }

    const liveKeys = new Set();
    for (const dev of devices) {
      const block = matchConfigBlock(dev, configured);
      // Matched devices reuse the config key so this set() REPLACES the
      // phase-1 pending card in place. Collision guard: if a second device
      // somehow matches the same block, it keys on its own deviceId so
      // neither row is silently dropped.
      const key = block && !liveKeys.has(cfgKey(block)) ? cfgKey(block) : devKey(dev);
      liveKeys.add(key);
      currentVms.set(key, buildLiveVm(dev, block, key));
    }
    // Configured FP2s that didn't answer stay listed (a briefly-offline or
    // slow-to-announce device must never silently disappear from setup) —
    // they just degrade from "checking network…" to "not reachable right now".
    for (const [key, vm] of currentVms) {
      if (vm.category === 'configured-pending') {
        currentVms.set(key, buildConfigVm(vm.block, /* pending */ false));
      }
    }

    renderList();
    if (currentVms.size === 0) {
      if (mode === 'scan') showEmptyState(null);
      else showScanPrompt();
    }
  } catch (err) {
    // Non-destructive: the phase-1 cards stay on screen. Only fall back to the
    // full empty-state panel when there was nothing to show in the first place.
    if (currentVms.size === 0) {
      showEmptyState(err);
    } else {
      showScanError(err);
    }
  } finally {
    setScanning(false);
  }
}

/* One delegated handler for every button in the device list — cards are
 * re-rendered wholesale, so per-button listeners would need rebinding on
 * every paint. The vm is looked up from the card's stable key. */
async function onDeviceListClick(e) {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;
  const li = btn.closest('.device');
  const vm = li ? currentVms.get(li.dataset.key) : null;
  if (!vm) return;

  if (btn.classList.contains('device-pick')) {
    if (!vm.dev) return;
    state.mode = 'pair';
    // An FP2 being re-paired (its pairing was forgotten, or it was reset)
    // usually still has its config entry. Reuse it so we update that block in
    // place — keeping the user's chosen name, zone names and options — rather
    // than appending a duplicate entry for the same device.
    state.matchedConfigHost = vm.block?.host ?? null;
    state.selectedDevice = vm.dev;
    state.name = vm.block?.name ?? suggestDefaultName(vm.dev);
    $('#manual-host-field').hidden = true;
    show('pin');
    $('#pin-input').focus();
    return;
  }

  if (btn.classList.contains('device-configure')) {
    if (vm.dev) enterConfigure(vm.dev);
    return;
  }

  if (btn.classList.contains('device-configure-offline')) {
    if (vm.block) {
      enterConfigure({
        name: vm.block.name,
        host: null,
        port: vm.block.port ?? null,
        deviceId: null,
        _configBlock: vm.block,
        _offline: true,
      });
    }
    return;
  }

  if (btn.classList.contains('device-remove')) {
    const configHost = vm.configHost;
    if (!configHost) return;
    // Destructive and not undoable from here: it drops the pairing, the config
    // entry, and (on restart) the HomeKit accessory along with its room and any
    // automations referencing it. Confirm first — via a two-step armed button:
    // native window.confirm() is silently blocked inside the Config UI X
    // sandboxed iframe (it returns false with no dialog), which made this
    // button appear to do nothing.
    if (btn.dataset.armed !== 'true') {
      btn.dataset.armed = 'true';
      btn.classList.add('armed');
      btn.textContent = 'Click again to remove';
      setTimeout(() => {
        // Disarm if still on screen and untouched (a re-render replaces the
        // node, which disarms it naturally).
        if (btn.isConnected && btn.dataset.armed === 'true') {
          btn.dataset.armed = '';
          btn.classList.remove('armed');
          btn.textContent = 'Remove device';
        }
      }, REMOVE_DISARM_MS);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      await removeDevice({ configHost, pairingKey: vm.pairingKey || null });
      await refreshList();
    } catch (err) {
      btn.disabled = false;
      btn.dataset.armed = '';
      btn.classList.remove('armed');
      btn.textContent = 'Remove device';
      homebridge.toast.error(err?.message ?? String(err), 'Could not remove device');
    }
    return;
  }

  if (btn.classList.contains('device-forget')) {
    if (!vm.pairingKey) return;
    btn.disabled = true;
    btn.textContent = 'Removing…';
    try {
      await homebridge.request('/forget', { key: vm.pairingKey });
      // Refresh so the device drops out of "stale" and back into
      // "available" — i.e. ready to pair again.
      await refreshList();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Forget pairing';
      homebridge.toast.error(err?.message ?? String(err), 'Could not remove pairing');
    }
  }
}

/* Reject with a {timedOut:true} error if `promise` doesn't settle in `ms`. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error(`Timed out waiting for ${label}.`);
        e.timedOut = true;
        reject(e);
      }, ms)
    ),
  ]);
}

/* ─── Configure an already-paired device (rename without re-pairing) ──── */

async function enterConfigure(dev) {
  const block = dev._configBlock ?? {};
  state.mode = 'configure';
  state.selectedDevice = dev;
  state.matchedConfigHost = block.host ?? configHostFor(dev);
  state.pin = block.pin ?? null; // preserved as-is; we don't re-pair
  state.name = block.name ?? suggestDefaultName(dev);
  state.options = {
    exposeZones: block.exposeZones !== false,
    exposeLightSensor: block.exposeLightSensor !== false,
  };
  state.names = {
    main: block.mainSensorName ?? null,
    light: block.lightSensorName ?? null,
    zones: { ...(block.zoneNames ?? {}) },
  };

  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/inspect', {
      host: state.matchedConfigHost,
      deviceId: dev.deviceId ?? undefined,
      // For a not-discovered device we have no current address — let the server
      // fall back to the stored pairing's host/port rather than passing nulls.
      address: dev._offline ? undefined : dev.host,
      port: dev._offline ? undefined : dev.port,
    });
    homebridge.hideSpinner();
    state.services = { zones: res.zones ?? [], light: res.light ?? { present: false } };
    $('#opt-zones').checked = state.options.exposeZones;
    $('#opt-lux').checked = state.options.exposeLightSensor;
    renderServices();
    show('services');
  } catch (err) {
    homebridge.hideSpinner();
    const msg = dev._offline
      ? `${state.name} isn't responding on the network right now. Check it's powered on and on Wi-Fi, then Scan again to reconfigure it.`
      : (err?.message ?? 'Could not read the FP2 with its saved pairing.');
    homebridge.toast.error(msg, 'Cannot configure');
  }
}

function suggestDefaultName(dev) {
  // "Presence-Sensor-FP2-A73D" → "Living Room FP2" feels wrong without context;
  // suggest the mDNS name's suffix as a starting point and let the user edit.
  const m = (dev.name ?? '').match(/FP2-([A-F0-9]{4})$/i);
  return m ? `FP2 ${m[1]}` : (dev.name ?? 'Aqara FP2');
}

/* ─── Step 2: PIN ──────────────────────────────────────────────────── */

async function submitPin() {
  const input = $('#pin-input');
  const errEl = $('#pin-error');
  errEl.hidden = true;

  // Manual mode: capture the host first, since discovery didn't supply it.
  if (state.selectedDevice?.manual) {
    const host = $('#manual-host-input').value.trim();
    if (!host) {
      errEl.textContent = 'Enter the FP2 identifier (mDNS name, hostname, or IP).';
      errEl.hidden = false;
      return;
    }
    state.selectedDevice.host = host;
    state.selectedDevice.name = host;
  }

  const dev = state.selectedDevice;
  homebridge.showSpinner();
  try {
    const res = await homebridge.request('/pair', {
      pin: input.value,
      configHost: configHostFor(dev),
      address: dev?.manual ? undefined : dev?.host,
      port: dev?.manual ? undefined : dev?.port,
      deviceId: dev?.deviceId ?? undefined,
      featureFlags: dev?.manual ? undefined : dev?.featureFlags,
    });
    homebridge.hideSpinner();

    state.pin = res.pin;
    if (res.paired) {
      state.services = { zones: res.zones ?? [], light: res.light ?? { present: false } };
    } else {
      // Couldn't pair live (e.g. manual host not on the network). Fall back to
      // the old behaviour: save config and let the plugin pair at runtime.
      state.services = null;
      homebridge.toast.info(
        'Could not reach the FP2 to read its sensors — it will be paired when Homebridge restarts.',
        'Saved for later pairing'
      );
    }
    show('name');
    $('#name-input').value = state.name ?? '';
    $('#name-input').focus();
  } catch (err) {
    homebridge.hideSpinner();
    errEl.textContent = err?.message ?? 'Could not pair with the FP2';
    errEl.hidden = false;
  }
}

/* ─── Step 3: Name ─────────────────────────────────────────────────── */

function submitName() {
  const input = $('#name-input');
  const errEl = $('#name-error');
  const raw = input.value.trim();
  if (!raw) {
    errEl.textContent = 'A display name is required.';
    errEl.hidden = false;
    return;
  }
  if (!isValidHapName(raw)) {
    errEl.textContent =
      'Only letters, numbers, spaces, and apostrophes. Must start and end with a letter or number.';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  state.name = raw;
  renderServices();
  show('services');
}

/* Mirror of the plugin's HAP name rule so users see the same validation.
 * Source of truth: src/validation.ts (this file can't import it — it is served
 * as a plain script). test/validation.test.ts fails if the copies drift. */
function isValidHapName(raw) {
  return (
    /^[a-zA-Z0-9 '][a-zA-Z0-9 ']{0,38}[a-zA-Z0-9']$/.test(raw) ||
    /^[a-zA-Z0-9']$/.test(raw)
  );
}

/* ─── Step 4: Services & names ──────────────────────────────────────── */

function defaultZoneName(zoneName) {
  return `${state.name} ${zoneName}`.trim();
}
function defaultLightName() {
  return `${state.name} Light`;
}

function renderServices() {
  const live = !!state.services;
  $('#main-name-field').hidden = !live;
  $('#light-name-field').hidden = true;
  const zoneWrap = $('#zone-names');
  zoneWrap.innerHTML = '';

  if (!live) {
    // Manual fallback: no enumerated services, just the expose toggles.
    $('#services-intro').textContent =
      'The FP2 will be paired when Homebridge restarts. Choose which sensor groups to expose; you can rename individual sensors later by re-running this setup.';
    $('#opt-zones').closest('.toggle').hidden = false;
    $('#opt-lux').closest('.toggle').hidden = false;
    return;
  }

  $('#services-intro').textContent =
    'These are the sensors found on your FP2. Rename any of them for the Home app, or turn whole groups off. Sensible defaults are filled in.';

  // Main occupancy.
  $('#name-main').value = state.names.main ?? state.name;

  // Zones.
  const zones = state.services.zones ?? [];
  $('#opt-zones').closest('.toggle').hidden = false;
  zoneWrap.hidden = !$('#opt-zones').checked;
  if (zones.length === 0) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'No zones are configured in the Aqara app yet — only the main sensor will be created.';
    zoneWrap.appendChild(note);
  }
  for (const zone of zones) {
    const field = document.createElement('label');
    field.className = 'field';
    const span = document.createElement('span');
    span.textContent = `Zone: ${zone.name}`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 40;
    inp.autocomplete = 'off';
    inp.dataset.zoneName = zone.name;
    inp.className = 'zone-name-input';
    inp.value = state.names.zones[zone.name] ?? defaultZoneName(zone.name);
    field.appendChild(span);
    field.appendChild(inp);
    zoneWrap.appendChild(field);
  }

  // Light sensor — only offer it if the FP2 actually exposes one.
  const hasLight = !!state.services.light?.present;
  $('#opt-lux').closest('.toggle').hidden = !hasLight;
  $('#light-name-field').hidden = !hasLight;
  if (hasLight) {
    $('#name-light').value = state.names.light ?? defaultLightName();
    if (!$('#opt-lux').checked) $('#name-light').closest('.field').hidden = true;
  }
}

function submitServices() {
  const errEl = $('#services-error');
  errEl.hidden = true;

  state.options.exposeZones = $('#opt-zones').checked;
  state.options.exposeLightSensor = $('#opt-lux').checked;

  if (state.services) {
    const names = collectServiceNames();
    if (names.error) {
      errEl.textContent = names.error;
      errEl.hidden = false;
      return;
    }
    state.names = names.value;
  }

  renderConfirm();
  show('confirm');
}

/* Read and validate the per-service name inputs. Returns {value} or {error}. */
function collectServiceNames() {
  const result = { main: null, light: null, zones: {} };
  // A non-empty invalid name yields the error message; empty means "use default".
  const invalid = (raw, label) => (raw && !isValidHapName(raw) ? `${label} is invalid: ${nameRuleHint()}` : null);

  const mainRaw = $('#name-main').value.trim();
  const mainErr = invalid(mainRaw, 'Main sensor name');
  if (mainErr) return { error: mainErr };
  result.main = mainRaw || null;

  for (const inp of $$('.zone-name-input')) {
    const raw = inp.value.trim();
    const zoneErr = invalid(raw, `Zone name "${raw}"`);
    if (zoneErr) return { error: zoneErr };
    if (raw) result.zones[inp.dataset.zoneName] = raw;
  }

  if (state.services.light?.present) {
    const lightRaw = $('#name-light').value.trim();
    const lightErr = invalid(lightRaw, 'Light sensor name');
    if (lightErr) return { error: lightErr };
    result.light = lightRaw || null;
  }

  return { value: result };
}

function nameRuleHint() {
  return 'use only letters, numbers, spaces, and apostrophes, starting and ending with a letter or number.';
}

/* ─── Step 5: Confirm + save ───────────────────────────────────────── */

function buildDeviceBlock() {
  const dev = state.selectedDevice;
  const host = configHostFor(dev);
  const block = {
    name: state.name,
    host,
  };
  // In configure mode we don't re-pair; only include pin when we have one so a
  // missing value can't overwrite the existing entry's pin on the merge in save().
  if (state.pin) block.pin = state.pin;
  // Only emit non-default option values to keep config.json tidy.
  if (!state.options.exposeZones) block.exposeZones = false;
  if (!state.options.exposeLightSensor) block.exposeLightSensor = false;

  // Custom names — emit only when they differ from the derived default.
  if (state.names.main && state.names.main !== state.name) {
    block.mainSensorName = state.names.main;
  }
  if (state.names.light && state.names.light !== defaultLightName()) {
    block.lightSensorName = state.names.light;
  }
  const zoneOverrides = {};
  for (const [zoneName, custom] of Object.entries(state.names.zones ?? {})) {
    if (custom && custom !== defaultZoneName(zoneName)) zoneOverrides[zoneName] = custom;
  }
  if (Object.keys(zoneOverrides).length > 0) block.zoneNames = zoneOverrides;

  return block;
}

/* Merge a device block into the parent frame's in-memory plugin config.
 * An existing entry for the same host is edited in place (re-running the
 * wizard is "edit", not "add"); otherwise the block is appended. The single
 * code path for both the confirm-step preview and the final save. Does NOT
 * call savePluginConfig() — the caller decides when to persist. */
async function upsertDeviceBlock(block) {
  const all = await homebridge.getPluginConfig();
  let platform = (all ?? []).find((p) => p.platform === PLATFORM_NAME);
  if (!platform) {
    platform = { platform: PLATFORM_NAME, name: PLATFORM_NAME, devices: [] };
    all.push(platform);
  }
  if (!Array.isArray(platform.devices)) platform.devices = [];
  const existingIdx = platform.devices.findIndex((d) => d.host === block.host);
  if (existingIdx >= 0) {
    platform.devices[existingIdx] = { ...platform.devices[existingIdx], ...block };
  } else {
    platform.devices.push(block);
  }
  await homebridge.updatePluginConfig(all);
}

async function renderConfirm() {
  const block = buildDeviceBlock();
  $('#config-preview').textContent = JSON.stringify(block, null, 2);
  // Keep the host-level in-memory config current so a save is always safe.
  await upsertDeviceBlock(block);
}

/* Fully remove a device: its stored pairing, its config.json entry, and (by way
 * of the platform's prune-on-start) its HomeKit accessory.
 *
 * Distinct from "Forget pairing", which drops only the credential and keeps the
 * config entry — that is what you want when re-pairing the SAME sensor, since it
 * preserves its name, zone names, room and automations. This is the "get rid of
 * it" action. Returns true on success.
 */
async function removeDevice({ configHost, pairingKey }) {
  // Drop the pairing first. If this fails we stop, rather than leave a config
  // with no entry but a credential still on disk. Pass configHost too: an offline
  // device wasn't in the scan, so we have no pairing key for it and the server has
  // to resolve the record itself.
  await homebridge.request('/forget', { key: pairingKey || undefined, configHost });
  const all = await homebridge.getPluginConfig();
  const platform = (all ?? []).find((p) => p.platform === PLATFORM_NAME);
  if (platform && Array.isArray(platform.devices) && configHost) {
    platform.devices = platform.devices.filter((d) => d.host !== configHost);
    await homebridge.updatePluginConfig(all);
    await homebridge.savePluginConfig();
  }
  // The accessory itself is unregistered by the platform on next start: it prunes
  // any cached accessory whose host is no longer in config.
  return true;
}

/* Write the device into config.json. Returns true on success. */
async function save() {
  const errEl = $('#save-error');
  errEl.hidden = true;
  try {
    await upsertDeviceBlock(buildDeviceBlock());
    await homebridge.savePluginConfig();
    return true;
  } catch (err) {
    errEl.textContent =
      `Could not save: ${err?.message ?? err}. ` +
      'You can still copy the JSON above into config.json manually.';
    errEl.hidden = false;
    return false;
  }
}

/* ─── Final actions ────────────────────────────────────────────────── */

async function saveAndAddAnother() {
  const ok = await save();
  if (!ok) return;
  homebridge.toast.success(`${state.name} saved.`, 'Device added');
  resetWizard();
}

async function finish() {
  const btn = $('#finish-btn');
  btn.disabled = true;
  try {
    // save() reports its own failure into #save-error and returns false; anything
    // it throws is a bug, but must still surface — a Finish button that appears to
    // do nothing at all is the worst possible outcome here.
    const ok = await save();
    if (!ok) return;
    await restartAndFinish();
  } catch (err) {
    const errEl = $('#save-error');
    errEl.textContent = `Could not finish: ${err?.message ?? err}. Your config may still have been saved — check the plugin settings.`;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function restartAndFinish() {
  // Deliberately no self-restart: Config UI X owns restarting Homebridge, and it
  // already shows its own "restart required" prompt once savePluginConfig() has
  // run. The plugin used to POST /api/server/restart itself, which was wrong on
  // two counts — the route is a PUT (the POST 404s) and it requires auth (401) —
  // so the request could never succeed, and because it was awaited with no
  // timeout, Finish could sit on a spinner and never close the window.
  //
  // closeSettings() is wrapped because it must never be the thing that stops the
  // wizard from closing: if it throws, the user is stuck on a dead dialog with
  // their config already saved.
  try {
    // init() disables the parent's own SAVE button (the wizard drives saving
    // itself). Re-enable it before asking the modal to close: leaving the parent's
    // controls disabled is what stops it dismissing cleanly.
    homebridge.enableSaveButton();
  } catch {
    /* non-fatal — closing is what matters */
  }
  try {
    homebridge.closeSettings();
  } catch {
    /* fall through to the toast below */
  }
  // closeSettings() is fire-and-forget (it posts {action:'close'} to the parent
  // and cannot report back), and a custom UI has no way to restart Homebridge —
  // there is no such action in the plugin-ui-utils API. So always tell the user
  // what to do next, rather than assuming the window went away.
  homebridge.toast.success(
    'Configuration saved. Restart Homebridge to apply it — the UI will prompt you.',
    'Saved'
  );
}

/* ─── Utilities ────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* Follow the Homebridge UI's own theme rather than the OS scheme — the two can
 * disagree (host set to a dark theme while the OS is light, or vice versa).
 * serverEnv.theme is available synchronously before first paint; theme names
 * are a color name (light), "dark-mode"/"dark-mode-<color>", or "auto".
 * userCurrentLightingMode() then gives the parent's authoritative answer,
 * resolving "auto" too. When neither works (browser preview), no data-theme is
 * set and the stylesheet's prefers-color-scheme fallback applies. */
function applyHostTheme() {
  const set = (mode) => {
    document.documentElement.dataset.theme = mode;
  };
  const themeName = homebridge.serverEnv?.theme;
  if (typeof themeName === 'string' && themeName.startsWith('dark-mode')) {
    set('dark');
  } else if (typeof themeName === 'string' && themeName && themeName !== 'auto') {
    set('light');
  }
  if (typeof homebridge.userCurrentLightingMode === 'function') {
    homebridge
      .userCurrentLightingMode()
      .then((mode) => {
        if (mode === 'dark' || mode === 'light') set(mode);
      })
      .catch(() => {
        /* keep whatever serverEnv gave us, or the CSS fallback */
      });
  }
}

/* ─── Wire up ──────────────────────────────────────────────────────── */

function resetWizard() {
  state.mode = 'pair';
  state.selectedDevice = null;
  state.matchedConfigHost = null;
  state.pin = null;
  state.name = null;
  state.services = null;
  state.options = { exposeZones: true, exposeLightSensor: true };
  state.names = { main: null, light: null, zones: {} };
  $('#pin-input').value = '';
  $('#name-input').value = '';
  $('#name-main').value = '';
  $('#name-light').value = '';
  $('#zone-names').innerHTML = '';
  $('#opt-zones').checked = true;
  $('#opt-lux').checked = true;
  show('discover');
  // Stay in the user's mode: after a scan-driven pairing this re-reads pairing
  // state from the warm cache; before any scan it just re-checks the config.
  refreshList();
}

function init() {
  applyHostTheme();
  $('#device-list').addEventListener('click', onDeviceListClick);
  $('#rescan-btn').addEventListener('click', runDiscover);
  $('#rescan-btn-main').addEventListener('click', runDiscover);
  $('#manual-entry-btn').addEventListener('click', () => {
    state.selectedDevice = { manual: true, host: '', deviceId: null };
    state.name = '';
    $('#manual-host-field').hidden = false;
    $('#manual-host-input').value = '';
    show('pin');
    $('#manual-host-input').focus();
  });
  $('#pin-next-btn').addEventListener('click', submitPin);
  $('#pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPin();
  });
  $('#name-next-btn').addEventListener('click', submitName);
  $('#name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });
  $('#services-next-btn').addEventListener('click', submitServices);
  // Hide the per-service name inputs when their group is toggled off.
  $('#opt-zones').addEventListener('change', () => {
    if (state.services) $('#zone-names').hidden = !$('#opt-zones').checked;
  });
  $('#opt-lux').addEventListener('change', () => {
    const field = $('#light-name-field');
    if (state.services?.light?.present) field.hidden = !$('#opt-lux').checked;
  });
  $('#save-another-btn').addEventListener('click', saveAndAddAnother);
  $('#finish-btn').addEventListener('click', finish);

  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cur = $$('.step').find((s) => !s.hidden)?.dataset.step;
      // Configure mode jumps straight from discover → services, so Back from
      // services returns to discover rather than the skipped pin/name steps.
      if (state.mode === 'configure' && cur === 'services') {
        show('discover');
        return;
      }
      const i = STEP_ORDER.indexOf(cur);
      if (i > 0) show(STEP_ORDER[i - 1]);
    });
  });

  homebridge.disableSaveButton();
  show('discover');
  // On open: render config + check that those devices are reachable. The full
  // network scan only runs when the user presses "Scan network".
  runCheck();
}

if (window.homebridge) {
  window.homebridge.addEventListener('ready', init);
} else {
  // Running outside the Homebridge UI iframe (e.g. browser preview). Render
  // fixture cards covering every category so the whole design is reviewable
  // in a plain browser; theme follows the OS via the CSS fallback.
  document.addEventListener('DOMContentLoaded', () => {
    // ?theme=dark / ?theme=light forces a theme in preview (no host to ask).
    const params = new URLSearchParams(location.search);
    const forcedTheme = params.get('theme');
    if (forcedTheme === 'dark' || forcedTheme === 'light') {
      document.documentElement.dataset.theme = forcedTheme;
    }
    // ?step=services jumps straight to a step to review its styling.
    show(STEP_ORDER.includes(params.get('step')) ? params.get('step') : 'discover');
    const fixtures = [
      buildLiveVm(
        { name: 'Presence-Sensor-FP2-6A0D', host: '192.168.1.116', port: 57897, deviceId: 'EC:35:4A:1F:1B:1F', knownByUs: true, availableToPair: false },
        { name: 'fp2Office', host: 'Presence-Sensor-FP2-6A0D' },
        'cfg:presence-sensor-fp2-6a0d'
      ),
      buildLiveVm(
        { name: 'Presence-Sensor-FP2-BFEA', host: '192.168.1.197', port: 51451, deviceId: '65:25:B4:5A:03:E2', knownByUs: true, availableToPair: false },
        null,
        'dev:65:25:B4:5A:03:E2'
      ),
      buildLiveVm(
        { name: 'Presence-Sensor-FP2-D00D', host: '192.168.1.77', port: 5543, deviceId: '77:88:99:AA:BB:CC', knownByUs: true, availableToPair: false, fromStore: true },
        { name: 'fp2Cellar', host: 'Presence-Sensor-FP2-D00D' },
        'cfg:presence-sensor-fp2-d00d'
      ),
      buildConfigVm({ name: 'fp2Mudroom', host: 'Presence-Sensor-FP2-A1B2' }, true),
      buildConfigVm({ name: 'fp2Attic', host: 'Presence-Sensor-FP2-C3D4' }, false),
      buildLiveVm(
        { name: 'Presence-Sensor-FP2-1234', host: '192.168.1.50', port: 5541, deviceId: '11:22:33:44:55:66', knownByUs: false, availableToPair: true },
        null,
        'dev:11:22:33:44:55:66'
      ),
      buildLiveVm(
        { name: 'Hall FP2', host: '192.168.1.242', port: 57708, deviceId: '2F:58:33:3C:3D:82', knownByUs: false, availableToPair: false },
        null,
        'dev:2F:58:33:3C:3D:82'
      ),
      buildLiveVm(
        { name: 'Presence-Sensor-FP2-9999', host: '192.168.1.60', port: 5542, deviceId: 'AA:BB:CC:DD:EE:FF', stalePairing: true, staleDeviceId: '99:88:77:66:55:44', pairingKey: 'fixture', availableToPair: false },
        null,
        'dev:AA:BB:CC:DD:EE:FF'
      ),
    ];
    currentVms = new Map(fixtures.map((vm) => [vm.key, vm]));
    renderList();
    setScanning(true);
  });
}
