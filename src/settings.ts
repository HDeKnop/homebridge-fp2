export const PLATFORM_NAME = 'AqaraFP2';
export const PLUGIN_NAME = 'homebridge-fp2';

/** Subdirectory under api.user.storagePath() where pairing data + state lives. */
export const STORAGE_SUBDIR = 'homebridge-fp2';

/** Default fallback poll interval. Subscriptions are the primary update path. */
export const DEFAULT_POLL_SECONDS = 30;

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** How many consecutive failed connect attempts are logged at warn level.
 *  After this many, retries continue but their log lines drop to debug so a
 *  persistently-offline FP2 doesn't fill the log every backoff cycle. */
export const FAILURE_WARN_ATTEMPTS = 3;

/** Hard ceiling on any single HAP network call (getAccessories / subscribe /
 *  getCharacteristics). hap-controller exposes no timeout, so a stalled FP2
 *  connection would otherwise leave the awaiting promise pending forever —
 *  wedging connect() so the reconnect backoff never fires. On expiry the call
 *  rejects and the normal disconnect/reconnect path takes over. */
export const HAP_CALL_TIMEOUT_MS = 15_000;

/** Watchdog tick. If the client is unreachable with no reconnect already
 *  scheduled (and not closed / terminally failed), the watchdog forces a fresh
 *  connect — a safety net for any "in-flight forever" gap a per-call timeout
 *  doesn't cover. */
export const WATCHDOG_INTERVAL_MS = 60_000;

/** Aqara FP2 mDNS model identifier (HAP TXT `md`). Discovery filters on this. */
export const FP2_MODEL = 'PS-S02D';

/** How often the shared browser re-issues its multicast query while a scan is
 *  in flight. The residual discovery misses are real WiFi multicast packet
 *  loss — no library avoids them by listening harder. Actively re-querying
 *  turns a dropped response into a retry, which is what took discovery from an
 *  intermittent 4/5 to 5/5 across 10 consecutive runs against 5 real FP2s. */
export const DISCOVERY_REQUERY_MS = 1_500;

/** Upper bound on a discovery wait. The shared browser answers from its warm
 *  cache almost always, and a cold scan found all devices within ~5s in
 *  testing, so this is a ceiling rather than a duration we expect to spend. */
export const DISCOVERY_TIMEOUT_MS = 8_000;

/** How often scanAll() re-checks its cache for growth while waiting. Purely a
 *  polling granularity — results arrive via mDNS events, not this loop. */
export const SCAN_POLL_MS = 250;

/** A cold scan (empty cache) must stay open for at least this many re-query
 *  rounds. The first FP2 can answer within 200ms while others need a retry or
 *  two (real multicast loss); exiting on the first quiet spell returned
 *  inconsistent partial sets. */
export const SCAN_COLD_MIN_ROUNDS = 3;

/** scanAll() exits early once the device count has been stable for this many
 *  full re-query rounds — the LAN has gone quiet. */
export const SCAN_QUIET_ROUNDS = 2;

/** Extra margin the Config UI server adds on top of a scan timeout before it
 *  fails the IPC request loudly. scanAll is bounded internally; this is the
 *  backstop for "the scan never settled at all". */
export const SCAN_RACE_MARGIN_MS = 5_000;

/** How long /check-known waits for a configured device to answer. Shorter than
 *  a full scan window: resolve() answers the moment the device replies (the
 *  unicast probe typically lands within a second), so this is a ceiling. */
export const CHECK_KNOWN_TIMEOUT_MS = 5_000;
