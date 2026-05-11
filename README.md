# homebridge-fp2

Homebridge plugin for the **Aqara Presence Sensor FP2**. Surfaces the
mmWave presence detection, light level, and per-zone occupancy as native
HomeKit services through HAP-over-WiFi.

> **Why bother?** The FP2 has stock HomeKit support, but its zones — the
> killer feature configured in the Aqara app — are *not* exposed to
> HomeKit. This plugin exposes each zone as its own Occupancy Sensor so
> you can build per-area automations.

## Features

- **Main Occupancy** — primary mmWave detection
- **Per-zone Occupancy** — one HomeKit sensor per zone configured in the Aqara app
- **Light Sensor** — ambient lux (toggleable)
- **Reset Presence switch** — momentary HomeKit Switch that clears stuck presence (opt-in)
- **Real-time** — HAP event subscriptions (sub-second updates)
- **mDNS discovery** — locates the FP2's HAP identity automatically; pin from config drives pair-setup
- **Stale-credential recovery** — detects re-paired / reset FP2s and re-pairs without manual cleanup
- **Reachability** — `StatusActive` characteristic reflects connection health
- **Eve Last Activation** — for "no motion in 10 min" automations in Eve / Controller
- **Multi-device** — manage any number of FP2s from one config
- **Cloud-free** — no Aqara cloud, no Matter bridge needed

## Requirements

- Homebridge **2.0** (also supports 1.8+)
- Node **18.20+**
- An FP2 reachable on the local network with mDNS / Bonjour traffic allowed

## Install

From Homebridge UI: search for `homebridge-fp2` and install.

From the CLI:

```sh
npm install -g homebridge-fp2
```

## Pairing the FP2

The FP2 ships paired to whichever Apple Home claims it first. To use this
plugin you need a **fresh setup pin**:

1. **Remove the FP2 from the Aqara/Apple Home app** if it's currently paired.
2. **Long-press the FP2's button for ~10 seconds** until the LED flashes — this resets the HAP pairing.
3. The setup pin is on the **sticker on the back of the FP2** (and inside the Aqara app under "Manual Setup").
4. Add the device to your Homebridge config (below) using that pin.
5. On first start, this plugin runs HAP `pair-setup` and stores the long-term pairing data under `~/.homebridge/homebridge-fp2/{ip}.json`.

If pairing fails, the most common causes are:

- Wrong pin format — must be `###-##-###` (with dashes).
- The FP2 is still paired with Apple Home.
- The FP2 setup window has timed out — long-press again to re-arm.

## Configuration

Add to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AqaraFP2",
      "name": "AqaraFP2",
      "devices": [
        {
          "name": "Living Room FP2",
          "host": "192.168.1.123",
          "pin": "123-45-678",
          "exposeZones": true,
          "exposeLightSensor": true,
          "pollIntervalSeconds": 30
        }
      ]
    }
  ]
}
```

Or use the **Homebridge Config UI** — the schema renders a form.

### Per-device options

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — | Display name (required) |
| `host` | string | — | IP address (required) |
| `port` | int | `80` | HAP port |
| `pin` | string | — | Setup pin `###-##-###` (required, first run only) |
| `exposeZones` | bool | `true` | Create per-zone Occupancy sensors |
| `exposeLightSensor` | bool | `true` | Create Light Sensor service |
| `exposeResetSwitch` | bool | `false` | Add a momentary Reset Presence Switch (see below) |
| `resetCharId` | string | auto | Override the auto-detected reset trigger as `"aid.iid"` |
| `pollIntervalSeconds` | int | `30` | Fallback poll. Real-time uses HAP events |
| `excludedZones` | string[] | `[]` | Zone names (Aqara app) to skip |
| `debug` | bool | `false` | Verbose logs |

### Reset Presence switch

Set `exposeResetSwitch: true` to add a momentary HomeKit **Switch** named
"`<your name>` Reset Presence". Toggling it on writes the FP2's
reset trigger and the switch auto-flips back off ~1 second later. Use it when
the FP2 is stuck reporting presence (e.g. after picking up a moving object as
a person).

The plugin **auto-detects** the trigger characteristic by scanning the FP2's
HAP service tree for writable Boolean characteristics that look like reset
controls — it logs its choice at startup, e.g.:

```
[Living Room FP2] reset characteristic detected at 1.42 (description-match: "reset presence")
```

If auto-detection picks the wrong one, override with `resetCharId: "1.42"` in
config and restart Homebridge. Different FP2 firmware revisions expose this
differently — file an issue with your firmware version if your FP2 has no
detectable candidate.

## Configuring zones

Zones are configured in the **Aqara Home** app, **not** here. Open the FP2
in the Aqara app, define your zones, then restart Homebridge. The plugin
reads the zone list from the FP2 itself; whatever you name them in the
Aqara app is what you'll see in HomeKit.

Removing a zone in Aqara → restart Homebridge → that sensor disappears
from HomeKit. Renaming a zone changes the HomeKit accessory's name.

## Troubleshooting

### "pair-setup failed" on startup

Reset the FP2 (10s long-press) and try again with the fresh pin.
Already-paired FP2s **cannot** be re-paired without a reset.

### Accessory shows "No Response" in Home app

The plugin sets `StatusActive` to `false` when it loses connection — the
Home app surfaces that as "No Response". It will recover automatically
once the FP2 is reachable again (exponential backoff up to 60s between
attempts). Check Homebridge logs for the underlying error.

### Zones don't appear

- Make sure they're configured in the Aqara app first.
- Confirm `exposeZones: true` (it is by default).
- Restart Homebridge — zones are read on connect.

### Resetting pairing

Delete `~/.homebridge/homebridge-fp2/{ip}.json`, reset the FP2, and
restart Homebridge. The next start will re-pair.

## Architecture

See [DESIGN.md](DESIGN.md) for the architecture, state model, and design
trade-offs.

## License

MIT
