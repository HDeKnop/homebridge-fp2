# Changelog

All notable changes to this project are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [0.6.0] — 2026-07-15

First release published to npm since 0.4.3; versions 0.5.0–0.5.13 were internal
test builds and were never published. This entry covers the changes since the
0.5.9 changelog entry — see the 0.5.x entries below for the rest of the line.

### Added

- **A legacy unicast mDNS probe now runs alongside the multicast browser.**
  Queries sent from an ephemeral port must be answered via unicast
  (RFC 6762 §6.7), which sidesteps switches whose IGMP snooping forwards our
  queries to the devices but never forwards the devices' multicast responses
  back. On such networks the probe is what actually finds the FP2s; a scan that
  only succeeded through it logs
  `unicast probe surfaced N device(s) missed by multicast` so the environmental
  gap is visible instead of silent.

### Changed

- **The setup wizard opens onto your devices, not onto a scan.** Configured
  devices render instantly from `config.json` and are then checked for
  reachability individually; enumerating the whole network is now an explicit
  "Scan network" action. The device list renders from a single view-model map,
  grouped into "Your devices", "Available to add", and "Needs attention", so
  overlapping refreshes can no longer produce duplicate rows.
- A scan failure or timeout no longer wipes the list: pairing-store-backed
  devices are still returned (marked "last known address") and the scan problem
  is shown as a warning banner instead of an error state.
- The wizard follows the Homebridge UI's own light/dark theme rather than the
  OS scheme, and general layout/CSS polish throughout.

## [0.5.9] — 2026-07-14

### Changed

- An FP2 that is paired and present in `config.json` is now badged **"Paired and
  configured"** rather than the ambiguous "Set up here", and its action is a
  secondary **Reconfigure** rather than a primary "Configure this device" — a
  sensor that is already working should not read as an outstanding task. Applies to
  a configured device the scan didn't surface, too.

## [0.5.8] — 2026-07-14

### Fixed

- **The device list now distinguishes "fully set up" from "paired, but not
  configured yet."** Holding a pairing and having a `config.json` entry are two
  independent facts, and the UI collapsed them into one state — so a device that
  had just been paired but was not yet in the config looked identical to one that
  was fully configured and running, and every configured sensor showed a
  call-to-action button as if it still needed work. A paired-but-unconfigured FP2
  is now badged "Paired — needs setup" with a primary **Finish setting up** action,
  while a fully configured one is badged "Configured" with a quieter
  **Reconfigure**.

## [0.5.7] — 2026-07-14

### Fixed

- **Finish now always tells you what happened.** The config was being saved and the
  wizard's own form dismissed, but the settings modal did not close and no restart
  was offered, so it looked like nothing happened. A custom UI cannot restart
  Homebridge — there is no such action in the plugin-ui-utils API — and
  `closeSettings()` is fire-and-forget, so it cannot report whether the modal
  actually closed. Finish now re-enables the parent's save button before asking the
  modal to close (leaving it disabled prevented a clean dismiss) and always shows a
  confirmation telling you the config is saved and a restart is needed.

## [0.5.6] — 2026-07-14

### Changed

- **"Save & add another" no longer re-scans the network.** Returning to the device
  list after pairing ran a fresh multicast sweep, even though nothing on the
  network had changed — the only difference is that the FP2 just paired is now
  configured. It now serves from the UI server's warm browser cache (which is
  long-lived and re-querying in the background anyway), so the list comes back
  immediately, and the list no longer blanks to a spinner while it refreshes.
  "Scan again" still performs a real scan.

## [0.5.5] — 2026-07-14

### Fixed

- **"Finish" in the setup wizard did nothing.** The window stayed open, the bridge
  never restarted, and no error was shown. Finish called `POST /api/server/restart`
  on the Config UI X API, but that route is a `PUT` (the `POST` 404s) and it
  requires authentication (401), so the restart could never succeed — and because
  the request was awaited with no timeout, the wizard could sit on a spinner
  indefinitely. The plugin no longer tries to restart Homebridge itself: Config UI
  X owns that and already prompts for a restart once the config is saved. Finish
  now saves, closes the window, and can no longer fail silently — any error is
  surfaced instead of leaving a dead button. (The config _was_ being saved
  correctly throughout; only the restart step failed.)
- **The scan list showed every sensor twice.** Two discovery runs could overlap
  (a rescan click while one was still in flight, or the initial load racing a
  reset); each cleared the device list and then each appended its own results, so
  every device rendered twice. Concurrent callers now share the in-flight scan, and
  the list is rebuilt atomically after the scan resolves rather than cleared before
  it.

## [0.5.4] — 2026-07-14

### Fixed

- **The setup UI's "Scan for devices" could hang until it timed out.** The UI
  server built a fresh mDNS browser for every request, each binding its own UDP
  :5353 sockets; repeatedly binding and tearing those down in a long-lived process
  could wedge it, leaving the request to never settle — the browser showed "Scan
  timed out" with nothing in the log to explain it. The UI server now keeps a
  single browser for its lifetime (a rescan also answers instantly from its warm
  cache), and a scan that fails to complete now raises a real error instead of
  hanging silently.

## [0.5.3] — 2026-07-14

### Added

- **"Remove device" in the setup UI.** Deletes an FP2's stored pairing _and_ its
  `config.json` entry; its HomeKit accessory is unregistered on the next restart.
  This is deliberately separate from **Forget pairing**, which drops only the
  credential so the _same_ sensor can be re-paired while keeping its name, zone
  names, room and automations. Available for any configured FP2, including one
  that is offline (a sensor you have permanently removed could otherwise never be
  cleared from the UI, since "Configure" needs the device reachable).

## [0.5.2] — 2026-07-14

### Fixed

- **A device whose pairing was just forgotten no longer offers "Configure this
  device."** The setup UI treated a device as configured if it merely had a config
  entry, so after "Forget pairing" it still showed a Configure button — which could
  only fail with "no saved pairing was found". A config entry alone is no longer
  enough; the plugin must actually hold a valid pairing. Such a device now shows its
  true state (claimed by another controller, or available to pair).
- **Re-pairing an FP2 that still has a config entry updates that entry instead of
  appending a duplicate**, so its name, zone names and options survive.

## [0.5.1] — 2026-07-14

### Added

- **Pairings are keyed by the Aqara hardware serial** (e.g. `54EF44508EA8` — the
  accessory ID the Aqara app shows, and the device's MAC). It is the only
  identifier stable for the life of the device: the HAP `deviceId` is regenerated
  by a factory reset and the IP moves with DHCP, so keying on either could strand
  a pairing. The serial comes from the `_Aqara-FP2._tcp` advertisement, joined to
  the HAP record by their shared `.local` hostname. Records written by older
  versions (keyed by IP, no serial) still load and are re-keyed automatically on
  the next successful connect — no re-pairing, no factory reset.
- **Stale pairings are detected and can be removed from the plugin settings.**
  When the plugin holds a pairing for a device whose HAP id has since changed, the
  FP2 was factory-reset and the saved credential can never work again. The setup
  UI now flags it as "Stale pairing" and offers a **Forget pairing** button.
  Pairing data is never deleted automatically — it is the only thing standing
  between a working FP2 and a physical factory reset.

### Fixed

- **A stale pairing is no longer misreported as "already paired with another
  controller."** A factory-reset FP2 also advertises `sf=0`, so the old guard sent
  users to remove a device from Apple Home when the real fix was to discard the
  dead pairing. The two cases are now distinguished and each gets accurate advice.
- **A broken FP2 is now visible in the Home app instead of silently reporting "no
  occupancy" forever.** A sensor that has permanently given up (claimed by another
  controller, wrong pin, pairing dead after a reset) sets `StatusFault`, which Home
  actually surfaces — `StatusActive` alone was close to invisible. An FP2 that has
  never connected is no longer published to HomeKit at all; one that previously
  worked stays published and is faulted, so its room assignment and any automations
  referencing it survive.

## [0.5.0] — 2026-07-14

### Fixed

- **mDNS discovery is now reliable.** The config wizard's scan could return 0, 1
  or all of the FP2s on the network at random, and the same flakiness slowed
  runtime connects. Browsing no longer goes through `hap-controller`'s
  `IPDiscovery`, which wraps the unmaintained `dnssd@0.4.1`:
  - `dnssd` only emits a service once its SRV, TXT **and** A/AAAA records have
    all arrived, and allows its resolver 10s to get there — longer than the 6s
    browse window we gave it. A device that needed a re-query was silently
    dropped, with no error raised.
  - The plugin now browses `_hap._tcp` with `bonjour-service` and **actively
    re-issues the multicast query** while a scan is in flight. Swapping the
    library alone was not enough — the residual misses are genuine WiFi
    multicast packet loss, and re-querying is what turns a dropped response into
    a retry. Measured against five real FP2s: 10/10 scans found all five, versus
    an intermittent 4/5 (and worse in the wild) before.
- **A link-local IPv6 address is no longer handed to the HAP connection.** Every
  FP2 advertises both an IPv4 and an `fe80::` address, and `IPDiscovery` reported
  whichever arrived first (`addresses[0]`) with no family preference. A bare
  `fe80::` address cannot be connected to, and `HttpClient` takes a single
  address with no fallback, so this produced connect failures that looked random.
  Address selection now prefers IPv4 and never returns a bare link-local
  (upstream: hap-controller#192).

### Changed

- Discovery is now a single shared, long-lived browser owned by the platform,
  replacing the duplicated per-device and wizard scanners. A reconnect resolves
  from its live cache in ~1ms instead of re-running an 18s multicast scan, and
  the cache follows an FP2 across a DHCP lease change or the new ephemeral HAP
  port it picks after rebooting.
- Display name in the Homebridge UI is now "Homebridge Aqara FP2 Presence".

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

[Unreleased]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.9...HEAD
[0.5.9]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.8...v0.5.9
[0.5.8]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.4.3...v0.5.0
[0.2.0]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/HDeKnop/homebridge-fp2/releases/tag/v0.1.0
