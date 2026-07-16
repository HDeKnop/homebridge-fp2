# homebridge-fp2 — Claude project guide

Plugin development for the Aqara Presence Sensor FP2.

## Quick orientation

- See [DESIGN.md](DESIGN.md) for architecture rationale and state model.
- Plugin alias: `AqaraFP2` (config.schema.json `pluginAlias`)
- Entry point: `src/index.ts` → `FP2Platform`
- HAP communication: `src/hap-client.ts` (wraps `hap-controller`)
- HomeKit surface: `src/accessory.ts`

## Build

```sh
npm install
npm run build           # tsc → dist/
npm run lint
```

To install locally into Homebridge:

```sh
npm link                # then from ~/.homebridge: npm link homebridge-fp2
```

## Testing against a real FP2

1. Reset the FP2 (10s long-press) to obtain a fresh setup pin.
2. Add the device to Homebridge `config.json` under platform `AqaraFP2`.
3. Start Homebridge with `homebridge -D` for debug output.
4. First run pairs and writes `~/.homebridge/homebridge-fp2/{deviceId}.json`.

## Conventions

- TypeScript strict, no `any` outside of `hap-controller` interop boundaries.
- All log lines prefixed `[name]` for multi-device clarity.
- Persist nothing outside `api.user.storagePath()/homebridge-fp2/`.
