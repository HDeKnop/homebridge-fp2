# homebridge-fp2

[![CI](https://github.com/HDeKnop/homebridge-fp2/actions/workflows/ci.yml/badge.svg)](https://github.com/HDeKnop/homebridge-fp2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Homebridge](https://img.shields.io/badge/Homebridge-1.8%20%7C%202.0-blue)](https://homebridge.io)
[![Node](https://img.shields.io/badge/node-%3E%3D18.20-brightgreen)](package.json)

Homebridge plugin for the **Aqara Presence Sensor FP2**. Surfaces the
mmWave presence detection, light level, and per-zone occupancy as native
HomeKit services through HAP-over-WiFi.

> **Why bother?** The FP2 has stock HomeKit support, but its zones — the
> killer feature configured in the Aqara app — are _not_ exposed to
> HomeKit. This plugin exposes each zone as its own Occupancy Sensor so
> you can build per-area automations.

## Features

- **Main Occupancy** — primary mmWave detection
- **Per-zone Occupancy** — one HomeKit sensor per zone configured in the Aqara app
- **Light Sensor** — ambient lux (toggleable)
- **Real-time** — HAP event subscriptions (sub-second updates)
- **mDNS discovery** — locates the FP2's HAP identity automatically; pin from config drives pair-setup
- **Stale-credential recovery** — detects re-paired / reset FP2s and re-pairs without manual cleanup
- **Reachability** — `StatusActive` characteristic reflects connection health
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

### Setup wizard (Homebridge UI)

This plugin ships a custom **setup wizard** for the Homebridge Config UI X
interface. After installing, click **Settings** on the plugin tile and the
wizard takes you through:

1. **Discover** — scans your network via mDNS for Aqara FP2 devices.
   Each candidate is shown with its mDNS name, IP, port, and pairing
   status. Devices already claimed by another controller are flagged
   with the workaround.
2. **Setup code** — accepts the pin in any common format (sticker
   `XXXX-XXXX`, plain `XXXXXXXX`, or HAP canonical `XXX-XX-XXX`) and
   normalises it.
3. **Name** — what the device shows up as in the Home app. Validated
   against HomeKit's stricter 2.0 naming rules so you don't end up with
   "No Response".
4. **Options** — zone exposure and light-sensor exposure toggles.
5. **Confirm** — shows the exact JSON block being added to your
   Homebridge config, then writes it via the UI API.

If the wizard's discovery doesn't surface your FP2, an
**"Enter details manually"** path lets you type the identifier yourself.

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

| Field                 | Type     | Default | Description                                                                |
| --------------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `name`                | string   | —       | Display name in HomeKit (required)                                         |
| `host`                | string   | —       | FP2 identifier — mDNS bonjour name, hostname, or IP (required, see below)  |
| `port`                | int      | (mDNS)  | HAP port. Usually omit — mDNS discovery resolves the FP2's ephemeral port. |
| `pin`                 | string   | —       | Setup pin `###-##-###` (required, first run only)                          |
| `exposeZones`         | bool     | `true`  | Create per-zone Occupancy sensors                                          |
| `exposeLightSensor`   | bool     | `true`  | Create Light Sensor service                                                |
| `pollIntervalSeconds` | int      | `30`    | Fallback poll. Real-time uses HAP events                                   |
| `excludedZones`       | string[] | `[]`    | Zone names (Aqara app) to skip                                             |
| `debug`               | bool     | `false` | Verbose logs                                                               |

### Identifying your FP2 (the `host` field)

The plugin accepts **three forms** for `host`, in order of robustness:

1. **mDNS bonjour name** (recommended): `Presence-Sensor-FP2-A73D`
   Stable across DHCP lease changes _and_ factory resets — the suffix is
   derived from the FP2's Wi-Fi MAC. Find it via `dns-sd -B _hap._tcp`
   on macOS or `avahi-browse -r _hap._tcp` on Linux.
2. **mDNS hostname**: `Presence-Sensor-FP2-A73D.local`
   Same stability as (1).
3. **IPv4 address**: `192.168.1.123`
   Only stable if you've reserved the DHCP lease in your router.

After the first successful pair, the plugin also remembers the FP2's HAP
device id and uses that to follow it across DHCP changes — so even an
IP-based config keeps working when the lease renews, as long as the FP2
is still on the LAN with mDNS reachable.

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

## Potential next steps

These features are not currently implemented but are under consideration:

- **Reset Presence switch** — a momentary HomeKit Switch that writes the FP2's reset trigger to clear stuck presence. The plugin already auto-detects the trigger characteristic in the HAP service tree; exposing it as a HomeKit tile is the remaining step.
- **Eve Last Activation** — adds an Eve-compatible "Last Activation" timestamp to the occupancy sensor, enabling "no motion in 10 minutes" automations in Eve and Controller for HomeKit.

If either of these would be useful to you, please open an issue or comment on an existing one.

## Architecture

See [DESIGN.md](DESIGN.md) for the architecture, state model, and design
trade-offs.

## Acknowledgements

The approach of talking directly to the FP2 over HAP-over-IP — including the relevant characteristic UUIDs and the pair-method selection based on the FP2's mDNS feature flags — was informed by [ebaauw/fp2-proxy](https://github.com/ebaauw/fp2-proxy) by Erik Baauw. That project proxies the FP2 to a deCONZ gateway and has no code overlap with this plugin, but its exploration of the FP2's HAP structure was a valuable reference.

## License

MIT
