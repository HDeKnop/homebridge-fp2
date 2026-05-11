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

/** How long to wait for mDNS to surface the FP2 before giving up. Bonjour
 *  caches can be slow on first cold start, so 10s gives a comfortable margin. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** Auto-off duration for the momentary Reset Presence switch. */
export const RESET_SWITCH_PULSE_MS = 1_000;
