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
export function sanitizeHapName(raw: string, fallback = 'Sensor'): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');
  return cleaned || fallback;
}
