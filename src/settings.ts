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
