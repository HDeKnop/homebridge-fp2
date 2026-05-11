# Contributing to homebridge-fp2

Thanks for your interest! This plugin started as a personal project for one
home's set of FP2s, and outside contributions are welcome — especially
firmware-specific quirks, additional zone behaviours, or platform
compatibility fixes.

## Development setup

```sh
git clone git@github.com:HDeKnop/homebridge-fp2.git
cd homebridge-fp2
npm install
npm run build
npm test
npm run lint
```

Requirements:

- Node.js **18.20+** (LTS 20 or 22 also fine — CI runs all three)
- A real FP2 is **not** required for development — the parser and mapper
  modules are exercised entirely from HAP fixtures in `test/fixtures.ts`.

## Testing your changes against a real FP2

1. `npm link` from this repo to make the plugin globally available
2. In your Homebridge dir: `npm link homebridge-fp2`
3. Add the FP2 to your `config.json` (see [README](README.md#configuration))
4. Start Homebridge with `homebridge -D` for debug output
5. Watch the log for `connected — occupancy=…` and live `event:` lines

If you don't have an FP2 to test against, that's fine — call it out in your
PR description and a maintainer will run the live test.

## Code style

- TypeScript strict mode, ESM modules, no `any` outside the
  `hap-controller` interop boundary
- ESLint flat config (`eslint.config.js`) — `npm run lint` must be clean
- Vitest for tests; new logic should land with tests covering the happy
  path and at least one failure mode
- Coverage thresholds in `vitest.config.ts` (80% statements/branches/
  functions/lines) — CI enforces these

## Architecture overview

See [DESIGN.md](DESIGN.md) for the state model and rationale. Quick
orientation:

- `src/index.ts` — Homebridge plugin entry
- `src/platform.ts` — DynamicPlatformPlugin, accessory lifecycle
- `src/accessory.ts` — projects HAP state onto HomeKit services
- `src/hap-client.ts` — wraps `hap-controller`, owns the FP2 session
- `src/parser.ts` — pure parsing of HAP accessory trees (well-tested)
- `src/mappers.ts` — pure value coercion (well-tested)
- `src/discovery.ts` — mDNS lookup wrapper
- `src/pairing-store.ts` — persistence for HAP long-term keys

## Pull-request workflow

1. Open an issue first for non-trivial changes — saves time if the
   direction needs discussion before code is written
2. Branch from `main`, make your changes, push, open a PR
3. CI must be green (lint, typecheck, test, build, coverage on Node 18/20/22)
4. PR description: link the issue, note any FP2 firmware tested against,
   and mention anything subtle for the reviewer
5. Squash-merge is the default — keep your branch's history tidy or let
   the maintainer collapse it

## Reporting bugs

Please use the [bug report
template](.github/ISSUE_TEMPLATE/bug_report.yml). The FP2's behaviour
varies meaningfully across firmware revisions, so the **FP2 firmware
version** is the single most valuable field on the form.

## Security

If you spot a credential leak (e.g. the plugin logging a pin or pairing
key), please email rather than opening a public issue. There are no API
keys in this codebase, but if you find a way to extract them from a
deployed Homebridge instance, that's worth a private heads-up.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
