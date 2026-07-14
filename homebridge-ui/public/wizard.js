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

const state = {
  mode: 'pair',         // 'pair' (new device) | 'configure' (already paired by us)
  selectedDevice: null, // discovered service or {manual: true}
  matchedConfigHost: null, // existing config `host` to edit in place (configure mode)
  pin: null,            // canonical HAP form
  name: null,
  deviceId: null,
  port: null,
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

/* A configured FP2 the live scan didn't surface this round. Rendered so it's
 * always reachable for reconfiguration; Configure still requires it to be
 * online (the pairing read goes over the network). */
function renderOfflineDevice(block) {
  const li = document.createElement('li');
  li.className = 'device';
  li.innerHTML = `
    <div class="device-row">
      <div class="device-main">
        <div class="device-name">${escapeHtml(block.name ?? block.host)}</div>
        <div class="device-meta">
          <span>${escapeHtml(block.host)}</span>
          <span aria-hidden="true">·</span>
          <span>not detected right now</span>
        </div>
      </div>
      <span class="badge info">Set up here</span>
    </div>
    <p class="hint">In your config but it didn't answer the scan just now — it may be
       slow to announce or briefly offline. Configure still needs it reachable to
       read its sensors.</p>
    <button type="button" class="btn primary device-configure-offline" data-config-host="${escapeHtml(block.host)}">
      Configure this device
    </button>
    <button type="button" class="btn device-remove" data-config-host="${escapeHtml(block.host)}" data-pairing-key="">
      Remove device
    </button>
  `;
  return li;
}

/* ─── Step 1: Discover ─────────────────────────────────────────────── */

async function runDiscover() {
  const statusEl = $('#discover-status');
  const listEl = $('#device-list');
  const emptyEl = $('#no-devices');

  statusEl.hidden = false;
  listEl.hidden = true;
  listEl.innerHTML = '';
  emptyEl.hidden = true;

  try {
    // The UI server can take a moment to come up right after a bridge restart;
    // a plain request would then spin forever. Bound it and surface a retry.
    const [{ devices }, configured] = await Promise.all([
      withTimeout(homebridge.request('/discover'), 30_000, 'discover'),
      loadConfiguredDevices(),
    ]);
    statusEl.hidden = true;

    // Config blocks rendered via a live (discovered) device; the remainder are
    // appended afterwards as "configured but not detected right now".
    const matchedBlocks = new Set();

    for (const dev of devices) {
      const block = matchConfigBlock(dev, configured);
      if (block) matchedBlocks.add(block);
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
      const category = dev.stalePairing
        ? 'stale'
        : dev.knownByUs
          ? 'configured'
          : !dev.availableToPair
            ? 'claimed'
            : 'available';
      dev._configBlock = block;
      dev._category = category;

      const li = document.createElement('li');
      li.className = 'device';
      const badge =
        category === 'stale'
          ? '<span class="badge warn">Stale pairing</span>'
          : category === 'configured'
            ? '<span class="badge info">Set up here</span>'
            : category === 'claimed'
              ? '<span class="badge warn">Paired elsewhere</span>'
              : '<span class="badge ok">Available</span>';
      const displayName = block?.name ?? dev.name ?? 'Unknown FP2';

      li.innerHTML = `
        <div class="device-row">
          <div class="device-main">
            <div class="device-name">${escapeHtml(displayName)}</div>
            <div class="device-meta">
              <span>${escapeHtml(dev.host)}</span>
              <span aria-hidden="true">·</span>
              <span>port ${dev.port}</span>
              <span aria-hidden="true">·</span>
              <span class="mono">${escapeHtml(dev.deviceId)}</span>
            </div>
          </div>
          ${badge}
        </div>
        ${
          category === 'stale'
            ? `<p class="device-warn">This FP2 was factory-reset since it was paired here, so the
                 saved pairing (HAP id <span class="mono">${escapeHtml(dev.staleDeviceId ?? '?')}</span>) can no
                 longer work — the device now reports
                 <span class="mono">${escapeHtml(dev.deviceId)}</span>.
                 Remove the dead pairing, then pair it again.</p>
               <button type="button" class="btn device-forget" data-pairing-key="${escapeHtml(dev.pairingKey ?? '')}">
                 Forget pairing
               </button>`
            : ''
        }
        ${
          category === 'claimed'
            ? `<p class="device-warn">This FP2 is paired with another controller.
                 Open <strong>Aqara Home</strong> → tap the FP2 → and either
                 use <em>Remove from Home</em>, or factory-reset the device
                 (10-second long-press) before adding it here.</p>`
            : ''
        }
        ${
          category === 'configured'
            ? `<button type="button" class="btn primary device-configure" data-device-id="${escapeHtml(dev.deviceId)}">
                 Configure this device
               </button>`
            : category === 'available'
              ? `<button type="button" class="btn primary device-pick" data-device-id="${escapeHtml(dev.deviceId)}">
                   Use this device
                 </button>`
              : ''
        }
        ${
          // Offered whenever this FP2 has a config entry — including a working one,
          // since removing a device you no longer want is a normal thing to do.
          // "Forget pairing" (above) only drops the credential so the same sensor
          // can be re-paired; this removes the device from the plugin entirely.
          block
            ? `<button type="button" class="btn device-remove" data-config-host="${escapeHtml(block.host)}"
                       data-pairing-key="${escapeHtml(dev.pairingKey ?? '')}">
                 Remove device
               </button>`
            : ''
        }
      `;
      listEl.appendChild(li);
    }

    // Always list FP2s already in config, even if the scan missed them this
    // round (a briefly-offline or slow-to-announce device) — a configured
    // device should never silently disappear from setup.
    const offlineBlocks = configured.filter((b) => b.host && !matchedBlocks.has(b));
    for (const block of offlineBlocks) {
      listEl.appendChild(renderOfflineDevice(block));
    }

    if (devices.length + offlineBlocks.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    listEl.hidden = false;

    listEl.querySelectorAll('.device-configure-offline').forEach((btn) => {
      btn.addEventListener('click', () => {
        const block = configured.find((b) => b.host === btn.dataset.configHost);
        if (block) enterConfigure({ name: block.name, host: null, port: block.port ?? null, deviceId: null, _configBlock: block, _offline: true });
      });
    });

    listEl.querySelectorAll('.device-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dev = devices.find((d) => d.deviceId === btn.dataset.deviceId);
        if (!dev) return;
        state.mode = 'pair';
        // An FP2 being re-paired (its pairing was forgotten, or it was reset)
        // usually still has its config entry. Reuse it so we update that block in
        // place — keeping the user's chosen name, zone names and options — rather
        // than appending a duplicate entry for the same device.
        const existing = dev._configBlock;
        state.matchedConfigHost = existing?.host ?? null;
        state.selectedDevice = dev;
        state.name = existing?.name ?? suggestDefaultName(dev);
        $('#manual-host-field').hidden = true;
        show('pin');
        $('#pin-input').focus();
      });
    });

    listEl.querySelectorAll('.device-configure').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dev = devices.find((d) => d.deviceId === btn.dataset.deviceId);
        if (dev) enterConfigure(dev);
      });
    });

    listEl.querySelectorAll('.device-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const configHost = btn.dataset.configHost;
        if (!configHost) return;
        // Destructive and not undoable from here: it drops the pairing, the config
        // entry, and (on restart) the HomeKit accessory along with its room and any
        // automations referencing it. Confirm first.
        if (!window.confirm(`Remove "${configHost}" from this plugin?\n\nThis deletes its pairing and its config entry. Its HomeKit accessory (and any automations using it) will be removed when Homebridge restarts.`)) {
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          await removeDevice({ configHost, pairingKey: btn.dataset.pairingKey || null });
          await runDiscover();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Remove device';
          homebridge.toast.error(err?.message ?? String(err), 'Could not remove device');
        }
      });
    });

    listEl.querySelectorAll('.device-forget').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.pairingKey;
        if (!key) return;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          await homebridge.request('/forget', { key });
          // Re-scan so the device drops out of "stale" and back into
          // "available" — i.e. ready to pair again.
          await runDiscover();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Forget pairing';
          homebridge.toast.error(err?.message ?? String(err), 'Could not remove pairing');
        }
      });
    });
  } catch (err) {
    statusEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.querySelector('h3').textContent = err?.timedOut ? 'Scan timed out' : 'Discovery failed';
    emptyEl.querySelector('p').textContent = err?.timedOut
      ? 'The setup server may still be starting up after a restart. Wait a moment and scan again.'
      : (err && err.message) ? err.message : 'Could not run mDNS discovery on the host.';
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
  state.deviceId = dev.deviceId ?? null;
  state.port = dev.port ?? null;
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
    if (res.deviceId) state.deviceId = res.deviceId;
    if (res.port) state.port = res.port;
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
      state.deviceId = res.deviceId ?? null;
      state.port = res.port ?? null;
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

/* Mirror the plugin's sanitizeHapName acceptance so users see the same rules. */
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

  const mainRaw = $('#name-main').value.trim();
  if (mainRaw && !isValidHapName(mainRaw)) return { error: `Main sensor name is invalid: ${nameRuleHint()}` };
  result.main = mainRaw || null;

  for (const inp of $$('.zone-name-input')) {
    const raw = inp.value.trim();
    if (raw && !isValidHapName(raw)) return { error: `Zone name "${raw}" is invalid: ${nameRuleHint()}` };
    if (raw) result.zones[inp.dataset.zoneName] = raw;
  }

  if (state.services.light?.present) {
    const lightRaw = $('#name-light').value.trim();
    if (lightRaw && !isValidHapName(lightRaw)) return { error: `Light sensor name is invalid: ${nameRuleHint()}` };
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

async function renderConfirm() {
  const block = buildDeviceBlock();
  $('#config-preview').textContent = JSON.stringify(block, null, 2);

  // Keep the host-level in-memory config current so a save is always safe.
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
    const block = buildDeviceBlock();
    const all = await homebridge.getPluginConfig();
    let platform = (all ?? []).find((p) => p.platform === PLATFORM_NAME);
    if (!platform) {
      platform = { platform: PLATFORM_NAME, name: PLATFORM_NAME, devices: [] };
      all.push(platform);
    }
    if (!Array.isArray(platform.devices)) platform.devices = [];

    // Replace an existing entry that targets the same host (re-running
    // the wizard for an already-configured device is "edit", not "add").
    const existingIdx = platform.devices.findIndex((d) => d.host === block.host);
    if (existingIdx >= 0) {
      platform.devices[existingIdx] = { ...platform.devices[existingIdx], ...block };
    } else {
      platform.devices.push(block);
    }

    await homebridge.updatePluginConfig(all);
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
  const ok = await save();
  if (!ok) return;
  await restartAndFinish();
}

async function restartAndFinish() {
  const errEl = $('#restart-error');
  errEl.hidden = true;
  homebridge.showSpinner();
  try {
    const { restarted, message } = await homebridge.request('/restart-bridge');
    homebridge.hideSpinner();
    if (restarted) {
      homebridge.toast.success('Child bridge is restarting…', 'Restart triggered');
    } else {
      homebridge.toast.info(message ?? 'Please restart Homebridge manually.', 'Restart manually');
    }
  } catch (err) {
    homebridge.hideSpinner();
    homebridge.toast.info('Please restart Homebridge manually to apply the new config.', 'Restart manually');
  }
  homebridge.closeSettings();
}

/* ─── Utilities ────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ─── Wire up ──────────────────────────────────────────────────────── */

function resetWizard() {
  state.mode = 'pair';
  state.selectedDevice = null;
  state.matchedConfigHost = null;
  state.pin = null;
  state.name = null;
  state.deviceId = null;
  state.port = null;
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
  runDiscover();
}

function init() {
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
  runDiscover();
}

if (window.homebridge) {
  window.homebridge.addEventListener('ready', init);
} else {
  // Running outside the Homebridge UI iframe (e.g. browser preview).
  document.addEventListener('DOMContentLoaded', () => {
    show('discover');
    $('#discover-status').hidden = true;
    $('#no-devices').hidden = false;
    $('#no-devices').querySelector('h3').textContent = 'Preview mode';
    $('#no-devices').querySelector('p').textContent =
      'mDNS discovery only runs inside the Homebridge UI. Open this plugin in Homebridge Config UI X to scan for live FP2 devices.';
  });
}
