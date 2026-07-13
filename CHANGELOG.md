# Changelog

All notable changes to this project are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [0.4.2] — 2026-07-13

### Fixed

- **Unhandled mDNS socket errors no longer crash the child bridge.** dnssd's
  `Browser` re-emits socket errors (e.g. `ENETUNREACH 224.0.0.251:5353` when
  Homebridge starts before the host has an IPv4 route, common at boot on a
  Raspberry Pi) as `'error'` events, and `hap-controller`'s `IPDiscovery`
  attaches no listener — so the error escaped as an uncaught exception and
  killed the child bridge, which after 5 rapid failures stayed down until
  manually restarted. Both the runtime discovery path and the custom-UI
  scanner now handle these errors and treat them as a failed discovery round.
- **Plugin now self-recovers from a wedged HAP connection.** `hap-controller`
  exposes no per-request timeout, so a stalled FP2 connection left
  `getAccessories()` / `getCharacteristics()` pending forever. That wedged the
  connect path — it never resolved or threw, so the reconnect backoff never
  fired — and the device sat dead (reachable=false → `StatusActive` 0, light
  level frozen at its last value) until a manual restart. Observed on an FP2
  with a chronic "HAP event channel disconnected" churn, where the light sensor
  was stuck reporting `0.0` lux. All HAP calls are now bounded by a 15s timeout
  so a stall rejects into the normal reconnect path, backed by a watchdog that
  forces a reconnect if the client is ever unreachable with nothing scheduled.
- **Light sensor `StatusActive` now reflects live reachability.** It previously
  only tracked the last pushed update, so it could read `0` (stale) while the
  presence sensor read `1`; it now has a live getter like the main sensor and
  zones.
- **Stale-pairing recovery now clears the right file.** When a pairing was
  recovered by device id from a file keyed under a different host than the
  config's (the store saves under the resolved IP), the repair path cleared
  the wrong key and re-found the same stale pairing forever. Address-refresh
  saves also now remove the superseded file instead of accumulating stale
  duplicates.
- **A config typo no longer destroys the accessory.** A device entry that
  fails validation (e.g. malformed pin) previously fell out of the prune set,
  so its cached accessory — with its room and automation assignments — was
  unregistered. Invalid entries now keep their accessory while you fix the
  config. Duplicate `host` entries are also rejected instead of two clients
  fighting over one accessory.
- **Pre-release audit hardening:** connection-failure log lines drop to debug
  after 3 consecutive failures (no more warn spam every backoff cycle for a
  persistently offline FP2); setup pins are no longer echoed into validation
  error messages; pairing files are written atomically (tmp + rename);
  `pollIntervalSeconds` is clamped to ≥5s in code; poll-based recovery resets
  the reconnect backoff; removed the bogus `port` default of 80 from the
  config schema (HAP ports are ephemeral and mDNS-discovered); un-awaited
  startup/shutdown promises now log errors instead of risking unhandled
  rejections.

### Changed

- README and CONTRIBUTING now describe the project's origin (a beginner
  project built entirely with Claude Code) and set maintenance expectations.
- Removed the non-optional `homebridge` peerDependency (breaks global
  installs; engines + devDependencies is the convention).

## [0.4.1] — 2026-06-08

### Fixed

- **Configured FP2s are now always listed in discovery**, even when the mDNS
  scan doesn't surface them that round (briefly offline or slow to announce).
  Previously a configured device that missed the scan window simply vanished
  from setup. Such devices appear as _Set up here_ with a "not detected right
  now" note; **Configure** still works once the device is reachable, and gives a
  clear "not responding right now" message when it isn't.
- **Discovery now runs two browse rounds (~12s) instead of one 8s window.** Each
  round is a fresh multicast query, so an FP2 whose announcement is lost to WiFi
  packet loss in the first round gets another chance — fixing flaky FP2s that
  intermittently failed to appear. The client request timeout was raised to 30s
  to accommodate the longer scan.

## [0.4.0] — 2026-06-08

### Added

- **"Configure this device" flow for already-paired FP2s.** The discovery step
  now recognises FP2s this plugin has already paired (matched by HAP deviceId
  against the stored pairings) and labels them **Set up here**. Picking one opens
  a new `/inspect` UI-server endpoint that reads the device's services using the
  existing pairing — no re-pair — and jumps straight to the **Services & names**
  step with the current names pre-filled, so the main sensor, each zone, and the
  light sensor can be renamed without re-entering the setup code.
- `PairingStore.listAll()` to enumerate stored pairings.

### Changed

- **Discovery now distinguishes three states** instead of just paired/available:
  _Set up here_ (paired by this plugin → Configure), _Paired elsewhere_ (paired
  to another controller such as Apple Home/Aqara → reset guidance, no pick), and
  _Available_ (→ Use this device). Previously every paired FP2 — including those
  this plugin owns — was shown as "claimed by another controller".
- The discovery request now times out (25s) and prompts a retry instead of
  spinning indefinitely when the UI server is still starting after a restart.

## [0.3.0] — 2026-06-08

### Added

- **Live pairing in the setup wizard.** Entering the setup code now pairs with
  the FP2 during setup (via a new `/pair` UI-server endpoint) instead of
  deferring to runtime. This validates the pin immediately and reads the
  device's actual service tree. The pairing is persisted to the same store the
  plugin reads at runtime, so the next Homebridge start reuses it rather than
  pairing a second time. Manual host entry that can't be resolved on the network
  falls back to the previous defer-to-runtime behaviour.
- **Service discovery and renaming in the wizard.** A new **Services & names**
  step lists the main occupancy sensor, each per-zone sensor, and the light
  sensor found on the FP2, and lets you give each a custom HomeKit name.
- **Custom name config fields**: `mainSensorName`, `lightSensorName`, and
  `zoneNames` (per-zone overrides keyed by the Aqara zone name). Each defaults
  to the previous derived name when unset.
- **"Scan again" button** on the discovery step, always available, to re-run
  mDNS discovery when a sensor doesn't surface on the first pass.

### Changed

- The wizard's final step now offers **Finish** (save + restart bridge + close)
  and **Save & add another** (save + return to discovery), replacing the
  separate confirm → done flow.

## [0.2.1] — 2026-06-01

### Fixed

- mDNS discovery is now retried in discrete browse rounds
  (`DISCOVERY_ROUND_MS` = 6s) up to a total `DISCOVERY_TIMEOUT_MS` budget
  (raised 10s → 18s). Each round is a fresh `IPDiscovery` query burst, so a
  dropped multicast response (common on WiFi) or a cold Bonjour cache no longer
  wastes the whole window. This addresses connect attempts falling into 60s
  reconnect loops with `mDNS discovery yielded nothing` when the FP2 was in fact
  online but slow to surface after a Homebridge restart.
- Reworded the "no port" connection error: it no longer advises setting `"port"`
  in config. The FP2 advertises HAP on ephemeral ports, so mDNS is the only
  supported discovery path; the message now points at network reachability
  instead.
- The "FP2 IP changed … (DHCP lease)" notice now only logs on a genuine address
  change (live mDNS address vs. last-known stored address). Previously it fired
  on every connect when `host` was an mDNS name — the resolved IP never equals
  the hostname string — falsely implying a DHCP change on each reconnect.

## [0.2.0] — 2026-05-13

### Changed

- **Breaking**: dropped Homebridge 1.x support. `engines.homebridge` and the
  `peerDependencies.homebridge` range narrowed to `^2.0.0`. This is an
  informed deviation from the official `homebridge/homebridge-plugin-template`
  (which still ships dual `^1.8.0 || ^2.0.0`) — motivated by the fact that
  this plugin has no Homebridge 1.x users to migrate.
- **Breaking**: dropped Node.js 18 and 20 support. `engines.node` narrowed
  to `^22.0.0 || ^24.0.0`.

### Internal

- Migrated ESLint to v10 with the `typescript-eslint` v8 unified meta-package
  (replaces the deprecated `@typescript-eslint/eslint-plugin` +
  `@typescript-eslint/parser` split). Added `@eslint/js` recommended baseline.
- Migrated the test runner to Vitest 4 + `@vitest/coverage-v8` 4.
- Bumped TypeScript to ^6.0.3, rimraf to ^6, `@types/node` to ^22.
- Added Prettier 3 with `eslint-config-prettier`. Plugin source and tests are
  now formatted by Prettier; stylistic ESLint rules deferred.
- CI: dropped Node 18/20 matrix entries; reorganised into `build-and-test`
  (Node 22.x / 24.x), `audit`, and `package-check` jobs. Coverage now
  uploaded as `coverage-lcov` artifact from the Node 22.x run.
- Added `preversion` / `postversion` scripts for safer `npm version`
  workflows.
- Lint scope extended to `test/`.
- `.gitignore`: pinned out legacy ESLint config filenames as a guard against
  iCloud-sync restoring them from other machines.

### Compatibility

- This is a pre-1.0 breaking-change release. Users still on Homebridge 1.x or
  Node 18/20 must remain on `homebridge-fp2@0.1.x`.

## [0.1.0] — 2026-05-11

### Added

- Initial Homebridge dynamic platform plugin for the Aqara Presence Sensor FP2 (model PS-S02D).
- mDNS discovery via `hap-controller`'s `IPDiscovery`, with discovery-driven
  port resolution (FP2 advertises on ephemeral HAP ports).
- Pair-setup using the right HAP pair method for the FP2's feature flags
  (`ff=2` → `PairSetup`/software auth, not `PairSetupWithAuth`).
- Persistent pairing store under `~/.homebridge/homebridge-fp2/`.
- Stale-credential recovery: detects pair-verify rejection on stored
  pairings, clears them, and re-runs pair-setup once.
- Hard guard against attempting pair-setup on an `sf=0` (already-paired)
  device — terminal config error, no retry loop.
- Per-zone Occupancy sensors discovered dynamically from the FP2's HAP
  service tree.
- HomeKit Light Sensor service for ambient lux (toggleable).
- Eve-style "Last Activation" custom characteristic for time-since-motion
  automations in Eve / Controller for HomeKit.
- Real-time HAP event subscriptions with periodic polling as a safety net.
- Reset Presence Switch service with auto-detected trigger characteristic
  (opt-in via `exposeResetSwitch`, default off).
- AccessoryInformation populated with the FP2's real Aqara serial, model,
  firmware revision, and hardware revision — extracted from the FP2's own
  HAP `AccessoryInformation` service.
- Exponential-backoff reconnect (1s → 60s cap) with terminal-error
  detection so the plugin doesn't burn through the FP2's pair-setup
  attempt budget on wrong pin / rate-limit / already-paired states.
- Vitest test suite: 58 tests across parser, mappers, pairing store, and
  reset detection. 100% statement coverage on tested modules.

### Architecture

- Homebridge 1.8+ and 2.0 compatible (peer dep `^1.8.0 || ^2.0.0`).
- TypeScript strict, ESM module, Node 18.20+ required.
- Pure-function parser / mapper modules isolated from `hap-controller` and
  Homebridge runtime, enabling fixture-based testing without a live FP2.

[Unreleased]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HDeKnop/homebridge-fp2/releases/tag/v0.1.0
