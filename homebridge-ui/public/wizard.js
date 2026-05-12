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

const state = {
  selectedDevice: null, // discovered service or {manual: true}
  pin: null,            // canonical HAP form
  name: null,
  options: { exposeZones: true, exposeLightSensor: true },
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
    const order = ['discover', 'pin', 'name', 'options', 'confirm'];
    const i = order.indexOf(li.dataset.step);
    const cur = order.indexOf(stepName);
    li.classList.toggle('done', cur > i);
  });
  // Scroll to top inside the iframe so each step starts at the top.
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

  try {
    const { pin } = await homebridge.request('/normalize-pin', { pin: input.value });
    state.pin = pin;
    show('name');
    $('#name-input').value = state.name ?? '';
    $('#name-input').focus();
  } catch (err) {
    errEl.textContent = err?.message ?? 'Invalid setup code';
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
  // Mirror the plugin's sanitizeHapName check so the user sees the same
  // restrictions the plugin applies at runtime.
  if (!/^[a-zA-Z0-9 '][a-zA-Z0-9 ']{0,38}[a-zA-Z0-9']$/.test(raw)
      && !/^[a-zA-Z0-9']$/.test(raw)) {
    errEl.textContent =
      'Only letters, numbers, spaces, and apostrophes. Must start and end with a letter or number.';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  state.name = raw;
  show('options');
}

/* ─── Step 4: Options ──────────────────────────────────────────────── */

function submitOptions() {
  state.options.exposeZones = $('#opt-zones').checked;
  state.options.exposeLightSensor = $('#opt-lux').checked;
  renderConfirm();
  show('confirm');
}

/* ─── Step 5: Confirm + save ───────────────────────────────────────── */

function buildDeviceBlock() {
  const dev = state.selectedDevice;
  // For discovered devices: prefer the mDNS bonjour name (stable across
  // DHCP and factory resets). For manual entry: whatever the user typed.
  const host = dev?.manual
    ? dev.host
    : (dev?.name ?? dev?.host ?? '');
  const block = {
    name: state.name,
    host,
    pin: state.pin,
  };
  // Only emit non-default option values to keep config.json tidy.
  if (!state.options.exposeZones) block.exposeZones = false;
  if (!state.options.exposeLightSensor) block.exposeLightSensor = false;
  return block;
}

function renderConfirm() {
  $('#config-preview').textContent = JSON.stringify(buildDeviceBlock(), null, 2);
}

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

    $('#done-name').textContent = block.name;
    show('done');
  } catch (err) {
    errEl.textContent =
      `Could not save: ${err?.message ?? err}. ` +
      'You can still copy the JSON above into config.json manually.';
    errEl.hidden = false;
  }
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
  state.options = { exposeZones: true, exposeLightSensor: true };
  $('#pin-input').value = '';
  $('#name-input').value = '';
  $('#opt-zones').checked = true;
  $('#opt-lux').checked = true;
  show('discover');
  runDiscover();
}

function init() {
  $('#rescan-btn').addEventListener('click', runDiscover);
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
  $('#options-next-btn').addEventListener('click', submitOptions);
  $('#save-btn').addEventListener('click', save);
  $('#add-another-btn').addEventListener('click', resetWizard);

  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cur = $$('.step').find((s) => !s.hidden)?.dataset.step;
      const order = ['discover', 'pin', 'name', 'options', 'confirm'];
      const i = order.indexOf(cur);
      if (i > 0) show(order[i - 1]);
    });
  });

  // Special case: manual entry needs the host field too. Add it lazily so
  // it doesn't clutter the discover-path UI.
  // (Implemented inline in the pin step's host field below if manual.)

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
