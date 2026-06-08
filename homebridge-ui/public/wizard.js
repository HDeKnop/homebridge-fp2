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
  selectedDevice: null, // discovered service or {manual: true}
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
 * we hand to /pair so the saved pairing file is keyed identically. */
function configHostFor(dev) {
  if (!dev) return '';
  return dev.manual ? dev.host : (dev.name ?? dev.host ?? '');
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
    const { devices } = await homebridge.request('/discover');
    statusEl.hidden = true;

    if (!devices.length) {
      emptyEl.hidden = false;
      return;
    }

    for (const dev of devices) {
      const li = document.createElement('li');
      li.className = 'device';
      const claimed = !dev.availableToPair;
      const statusLabel = claimed ? 'Already paired' : 'Available';
      li.innerHTML = `
        <div class="device-row">
          <div class="device-main">
            <div class="device-name">${escapeHtml(dev.name ?? 'Unknown FP2')}</div>
            <div class="device-meta">
              <span>${escapeHtml(dev.host)}</span>
              <span aria-hidden="true">·</span>
              <span>port ${dev.port}</span>
              <span aria-hidden="true">·</span>
              <span class="mono">${escapeHtml(dev.deviceId)}</span>
            </div>
          </div>
          <span class="badge ${claimed ? 'warn' : 'ok'}">${statusLabel}</span>
        </div>
        ${
          claimed
            ? `<p class="device-warn">This FP2 is claimed by another controller.
                 Open <strong>Aqara Home</strong> → tap the FP2 → and either
                 use <em>Remove from Home</em>, or factory-reset the device
                 (10-second long-press) before pairing here.</p>`
            : ''
        }
        <button type="button" class="btn primary device-pick" data-device-id="${escapeHtml(dev.deviceId)}">
          Use this device
        </button>
      `;
      listEl.appendChild(li);
    }
    listEl.hidden = false;

    listEl.querySelectorAll('.device-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deviceId;
        const dev = devices.find((d) => d.deviceId === id);
        if (!dev) return;
        state.selectedDevice = dev;
        state.name = suggestDefaultName(dev);
        $('#manual-host-field').hidden = true;
        show('pin');
        $('#pin-input').focus();
      });
    });
  } catch (err) {
    statusEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.querySelector('h3').textContent = 'Discovery failed';
    emptyEl.querySelector('p').textContent =
      (err && err.message) ? err.message : 'Could not run mDNS discovery on the host.';
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
    pin: state.pin,
  };
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
  state.selectedDevice = null;
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
