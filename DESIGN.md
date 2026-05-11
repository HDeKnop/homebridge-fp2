# homebridge-fp2 — Design

## Goal

Expose the Aqara Presence Sensor FP2 to HomeKit through Homebridge with richer surface area than the FP2's native HomeKit integration: per-zone Occupancy sensors, light level, and reliable state-management around real-time HAP events.

## High-level architecture

```
Homebridge process
└── FP2Platform                        (registered with Homebridge as plugin alias "AqaraFP2")
    ├── PairingStore                   (~/.homebridge/homebridge-fp2/{deviceId}.json)
    └── one Fp2Device per config entry
        ├── Fp2HapClient               (wraps hap-controller HttpClient)
        │     ├─ ensurePaired()        (PairSetup on first run)
        │     ├─ readAll()             (getAccessories → typed FP2State)
        │     ├─ subscribe()           (HAP event subscriptions)
        │     └─ EventEmitter          ('state', 'connected', 'disconnected')
        └── Fp2Accessory               (one PlatformAccessory)
              ├─ Main Occupancy service
              ├─ Light Sensor service
              └─ Per-zone Occupancy services (one per detected zone)
```

## Why these choices

| Decision | Why |
|---|---|
| `hap-controller`'s `HttpClient` (not raw HAP) | Battle-tested HAP/PV pairing, pair-verify, encrypted-session and event handling. Directly maps to FP2 (an mDNS-advertised HAP accessory). |
| Standard PlatformAccessory cache (`configureAccessory`) | Stable HomeKit identifiers across restarts. External accessories aren't needed (FP2 is just sensors). |
| **mDNS discovery before pair-setup** | The FP2's HAP `id` (formatted `XX:XX:XX:XX:XX:XX`) is what `pair-setup` records as the AccessoryPairingID. Using mDNS to look it up keeps the pairing record clean and human-readable; if mDNS fails we fall back to using the configured IP as a placeholder and let `pair-setup` populate the real id from `getLongTermData()`. |
| **Stale-pair recovery** | `getAccessories()` is run as a "smoke test" right after attaching stored pairing data. If pair-verify fails (FP2 was reset or re-paired elsewhere), we wipe the persisted file and run `pair-setup` once more with the configured pin — fully inside the Homebridge plugin lifecycle, no manual cleanup needed. |
| Pin-only config + auto-pair on first run | No separate `homebridge-fp2 pair` CLI to maintain; pairing data is persisted to `~/.homebridge/homebridge-fp2/` after first successful PairSetup, then reused via PairVerify. |
| Event subscriptions, polling as safety net | The FP2 emits HAP events for occupancy / lux changes within ~250ms. Polling at 30s catches missed events / disconnects. |
| Dynamic zone discovery | Zone count is configured in the Aqara app, not the plugin. We enumerate Occupancy services on the FP2 accessory at connect time and create one HomeKit sensor per non-primary zone. |
| Stable per-zone UUID via `uuid.generate("fp2-${deviceId}-zone-${zoneName}")` | Zone HAP IIDs may renumber on firmware upgrades; deriving from the user-facing name keeps the cache valid. |
| **Reset-trigger heuristic** | Public reverse-engineering hasn't pinned down a single canonical UUID for the FP2's "Reset Presence" command — different firmware revisions surface it differently. We auto-detect by scanning for writable Booleans whose `description` matches /reset\|clear\|presence\|train/ or that sit on a non-Apple-standard (vendor) UUID, log the chosen candidate, and let users override via `resetCharId`. |
| **Homebridge 2.0 primary target** | Peer-deps and engines pin `^1.8.0 \|\| ^2.0.0` so the plugin is forward-compatible. All HAP types are accessed via `api.hap.*` — no direct `hap-nodejs` imports. ESM module + Node 18.20+. |

## State model

```ts
interface Fp2State {
  occupancy: boolean;          // primary mmWave detection
  lightLevel: number | null;   // lux (HAP returns 0.0001-100000, we forward as-is)
  zones: Map<string, ZoneState>;
}
interface ZoneState {
  name: string;                // human-readable, from the FP2 service Name characteristic
  occupancy: boolean;
  iid: number;                 // HAP instance id of the OccupancySensor service
  occIid: number;              // HAP instance id of the OccupancyDetected characteristic
}
```

The `Fp2HapClient` keeps the latest snapshot internally; the `Fp2Accessory` reads from it on every characteristic `onGet` and also subscribes to `state` events to push values into HomeKit.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| FP2 unreachable at startup | Connection retried with exponential backoff (1s → 60s cap). Cached PlatformAccessory characteristics return their last known value. Log at `warn` level. |
| Wrong / expired pin | `PairSetup` returns 6/M4 error → log error with reset instructions, schedule reconnect (won't loop tightly because backoff applies). |
| **Stale persisted pairing** (FP2 was reset / paired with a different controller) | First post-attach `getAccessories()` fails with pair-verify error → match against known stale-error patterns, clear `~/.homebridge/homebridge-fp2/{ip}.json`, and re-run `pair-setup` with the configured pin. Single retry only — second failure surfaces to the user. |
| HAP session drop mid-run | `event-disconnect` triggers reconnect via PairVerify (no pin needed). Subscriptions re-established cleanly via the `detachClient` cleanup path. |
| Missing characteristics in response | Skip the affected service, keep the others. Defensive null-checks throughout `parseAccessories`. |
| Reset trigger missing | Auto-detection logs "no candidate" and the Reset switch surfaces a warning at write-time rather than crashing. |
| Homebridge restart | Cached accessories rehydrated via `configureAccessory`; `Fp2HapClient` re-pair-verifies using stored long-term keys. |
| Memory leak | All `setInterval`s and `setTimeout`s (reconnect, poll, reset auto-off) tracked on the device instance and cleared on `shutdown`. Subscriptions explicitly disposed in `Fp2HapClient.close()`. |

## Out of scope

- Custom zone configuration (must be done in the Aqara app first).
- Aqara cloud / matter bridge integration.
- deCONZ relay (handled by the separate `fp2-proxy` daemon if needed).
- Fall detection (FP2 firmware does not currently expose it via HAP).

## Open questions

- **Multiple primary occupancy services**: the FP2 may expose a "presence" service AND separate per-zone services. The primary is identified as the service where `Service.Name` is empty / equals the accessory display name; everything else is treated as a zone.
- **lux units**: hap-controller returns the raw HAP value (lux). We forward verbatim; if a future firmware uses a different unit we will have to scale.
