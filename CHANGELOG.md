# Changelog

All notable changes to this project are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

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

[Unreleased]: https://github.com/HDeKnop/homebridge-fp2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HDeKnop/homebridge-fp2/releases/tag/v0.1.0
