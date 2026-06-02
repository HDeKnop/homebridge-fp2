export const PLATFORM_NAME = 'AqaraFP2';
export const PLUGIN_NAME = 'homebridge-fp2';

/** Subdirectory under api.user.storagePath() where pairing data + state lives. */
export const STORAGE_SUBDIR = 'homebridge-fp2';

/** Default fallback poll interval. Subscriptions are the primary update path. */
export const DEFAULT_POLL_SECONDS = 30;

/** HAP-over-IP standard port for FP2. */
export const DEFAULT_HAP_PORT = 80;

export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** Per-round mDNS browse window. Each round spins up a fresh IPDiscovery, i.e.
 *  a fresh multicast query burst. Re-querying in discrete rounds counters WiFi
 *  multicast packet loss (a single dropped response otherwise wastes the whole
 *  window) far better than one long passive wait. */
export const DISCOVERY_ROUND_MS = 6_000;

/** Total mDNS discovery budget per connect attempt, split into
 *  DISCOVERY_ROUND_MS rounds. Bonjour caches can be slow on a cold start and
 *  the FP2 can take ~15-20s to surface after a Homebridge restart, so the
 *  budget covers that while each round re-queries to survive packet loss. */
export const DISCOVERY_TIMEOUT_MS = 18_000;
