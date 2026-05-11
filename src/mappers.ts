/**
 * Pure value mappers. Hard-coded HAP enum values are guaranteed by the HAP
 * spec (Chapter 9): OccupancyDetected = 1, OccupancyNotDetected = 0;
 * CurrentAmbientLightLevel range = 0.0001..100000 lux.
 */

export const HAP_OCCUPANCY_DETECTED = 1;
export const HAP_OCCUPANCY_NOT_DETECTED = 0;

export const LUX_MIN = 0.0001;
export const LUX_MAX = 100_000;

export function toHapOccupancy(detected: boolean): 0 | 1 {
  return detected ? HAP_OCCUPANCY_DETECTED : HAP_OCCUPANCY_NOT_DETECTED;
}

/**
 * Clamp / coerce an FP2 lux reading into the HomeKit-valid range. Null and
 * NaN both collapse to LUX_MIN — HomeKit can't represent "unknown" for this
 * characteristic, so the dimmest valid value is the safest substitute.
 */
export function toHapLux(lux: number | null | undefined): number {
  if (lux === null || lux === undefined || Number.isNaN(lux)) return LUX_MIN;
  if (lux < LUX_MIN) return LUX_MIN;
  if (lux > LUX_MAX) return LUX_MAX;
  return lux;
}

/**
 * Coerce a string into a HAP-2.0-compliant Name characteristic value.
 *
 * HAP-NodeJS 2.0 strictly validates names: "only alphanumeric, space, and
 * apostrophe characters. Ensure it starts and ends with an alphabetic or
 * numeric character". Invalid names produce warnings in v2 and "may prevent
 * the accessory from being added in the Home App or cause unresponsiveness".
 *
 * This helper replaces invalid characters (parentheses, dashes, periods, etc.)
 * with spaces, collapses runs of whitespace, and strips leading/trailing
 * non-alphanumerics. Returns a safe default if the input collapses to empty.
 */
/**
 * hap-controller's `AccessoryPairingID` is stored as hex-encoded ASCII
 * (e.g. `"33343a38463a43313a..."` → `"34:8F:C1:76:..."`). mDNS reports
 * the canonical colon form. Normalize so cross-source comparisons work.
 *
 * Idempotent: if the input is already in `XX:XX:...` form it's returned
 * verbatim. Returns null when the input is null/undefined.
 */
export function normalizeDeviceId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.includes(':')) return id;
  if (/^[0-9a-f]+$/i.test(id) && id.length % 2 === 0) {
    try {
      const decoded = Buffer.from(id, 'hex').toString('utf8');
      if (decoded.includes(':')) return decoded;
    } catch { /* noop */ }
  }
  return id;
}

export function sanitizeHapName(raw: string, fallback = 'Sensor'): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');
  return cleaned || fallback;
}
