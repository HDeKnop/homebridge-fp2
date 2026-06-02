# Changelog

All notable changes to this project are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

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
