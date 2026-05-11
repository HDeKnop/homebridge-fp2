/**
 * Pure parsing helpers for FP2 HAP payloads.
 *
 * Extracted from hap-client so they can be unit-tested without the runtime
 * `hap-controller` HttpClient or a real device. Everything here is a pure
 * function: HAP payload in, structured object out.
 */

import type { Fp2State, ZoneState } from './types.js';

export interface CharacteristicObject {
  aid?: number;
  iid?: number;
  type?: string;
  value?: unknown;
  format?: string;
  perms?: string[];
  description?: string;
}
export interface ServiceObject {
  iid: number;
  type: string;
  characteristics: CharacteristicObject[];
}
export interface AccessoryObject {
  aid: number;
  services: ServiceObject[];
}
export interface Accessories {
  accessories: AccessoryObject[];
}

/** Apple HAP service type UUIDs (short form). */
export const SERVICE_OCCUPANCY = '86';
export const SERVICE_LIGHT_SENSOR = '84';
export const SERVICE_ACCESSORY_INFO = '3E';

/** Apple HAP characteristic type UUIDs (short form). */
export const CHAR_OCCUPANCY_DETECTED = '71';
export const CHAR_AMBIENT_LIGHT = '6B';
export const CHAR_NAME = '23';
export const CHAR_CONFIGURED_NAME = 'E3';
export const CHAR_SERIAL_NUMBER = '30';
export const CHAR_MODEL = '21';
export const CHAR_FIRMWARE_REVISION = '52';
export const CHAR_HARDWARE_REVISION = '53';

/**
 * Compare HAP type UUIDs which may arrive as either short ("86") or
 * full ("00000086-0000-1000-8000-0026BB765291") form, with any casing.
 */
export function isHapType(actual: string | undefined, shortHex: string): boolean {
  if (!actual) return false;
  const a = actual.toLowerCase();
  const s = shortHex.toLowerCase();
  if (a === s) return true;
  return a.startsWith(`${s.padStart(8, '0')}-`);
}

export function findChar(
  service: ServiceObject,
  shortHex: string,
): CharacteristicObject | undefined {
  if (!Array.isArray(service.characteristics)) return undefined;
  return service.characteristics.find((c) => isHapType(c.type, shortHex));
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'zone';
}

/**
 * Coerce a HAP revision string into the `X[.X[.X]]` shape Apple Home expects.
 * If the FP2 reports a literal `"0"` (or anything that doesn't match) we
 * upgrade it to `"0.0.0"` so iOS doesn't reject the accessory. Whitespace is
 * trimmed; multi-dot suffixes beyond three components are kept (HAP allows it
 * but Apple Home tolerates extras).
 */
export function normalizeRevisionString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '0.0.0';
  if (/^\d+(\.\d+){0,3}$/.test(trimmed)) {
    // Pad to 3 components — Apple Home occasionally flags single-digit values.
    const parts = trimmed.split('.');
    while (parts.length < 3) parts.push('0');
    return parts.slice(0, 3).join('.');
  }
  // Fall back to a safe default rather than passing through invalid input.
  return '0.0.0';
}

export interface ParsedAccessories {
  state: Fp2State;
  primaryOccupancyIid: number | null;
  lightLevelIid: number | null;
  serial: string | null;
  model: string | null;
  /** Firmware revision string as reported by the FP2 (e.g. `"1.1.7"`). */
  firmware: string | null;
  /** Hardware revision string (e.g. `"1.0.0"`). */
  hardware: string | null;
}

export interface ParseOptions {
  excludedZones?: string[];
}

/**
 * Parse the FP2's HAP accessory tree into a structured state object.
 *
 * Strategy:
 *   - Walk every service. AccessoryInformation gives us serial / model.
 *   - Every OccupancySensor service is a candidate. The "primary" is the one
 *     whose user-facing Name matches the accessory's Name (or no Name set);
 *     the rest are zones.
 *   - LightSensor characteristic provides the lux reading.
 *   - Excluded zone names are dropped.
 *
 * Returns a fully-formed Fp2State plus the IIDs needed for subscriptions.
 */
export function parseAccessories(
  payload: Accessories | null | undefined,
  opts: ParseOptions = {},
): ParsedAccessories {
  const state: Fp2State = {
    occupancy: false,
    lightLevel: null,
    zones: new Map(),
    reachable: false,
  };
  const result: ParsedAccessories = {
    state,
    primaryOccupancyIid: null,
    lightLevelIid: null,
    serial: null,
    model: null,
    firmware: null,
    hardware: null,
  };

  const accessories = payload?.accessories;
  if (!Array.isArray(accessories)) return result;

  for (const accessory of accessories) {
    if (!accessory || !Array.isArray(accessory.services)) continue;
    const aid = accessory.aid ?? 1;
    const services = accessory.services;

    const occupancyServices: Array<{ svc: ServiceObject; name: string | null }> = [];
    let primaryAccessoryName: string | null = null;

    for (const svc of services) {
      if (!svc || typeof svc.type !== 'string') continue;
      if (isHapType(svc.type, SERVICE_ACCESSORY_INFO)) {
        const nameChar = findChar(svc, CHAR_NAME);
        if (typeof nameChar?.value === 'string') primaryAccessoryName = nameChar.value;
        const serial = findChar(svc, CHAR_SERIAL_NUMBER);
        if (serial?.value !== undefined && serial.value !== null) {
          result.serial = String(serial.value);
        }
        const model = findChar(svc, CHAR_MODEL);
        if (model?.value !== undefined && model.value !== null) {
          result.model = String(model.value);
        }
        const firmware = findChar(svc, CHAR_FIRMWARE_REVISION);
        if (firmware?.value !== undefined && firmware.value !== null) {
          result.firmware = normalizeRevisionString(String(firmware.value));
        }
        const hardware = findChar(svc, CHAR_HARDWARE_REVISION);
        if (hardware?.value !== undefined && hardware.value !== null) {
          result.hardware = normalizeRevisionString(String(hardware.value));
        }
      }
      if (isHapType(svc.type, SERVICE_OCCUPANCY)) {
        const configured = findChar(svc, CHAR_CONFIGURED_NAME);
        const named = findChar(svc, CHAR_NAME);
        const name = (typeof configured?.value === 'string' ? configured.value : null)
          ?? (typeof named?.value === 'string' ? named.value : null);
        occupancyServices.push({ svc, name });
      }
      if (isHapType(svc.type, SERVICE_LIGHT_SENSOR)) {
        const lux = findChar(svc, CHAR_AMBIENT_LIGHT);
        if (lux?.iid !== undefined) {
          result.lightLevelIid = lux.iid;
          if (typeof lux.value === 'number') state.lightLevel = lux.value;
        }
      }
    }

    let primary: ServiceObject | null = null;
    for (const { svc, name } of occupancyServices) {
      if (!name || name === primaryAccessoryName) {
        primary = svc;
        break;
      }
    }
    if (!primary && occupancyServices.length > 0) primary = occupancyServices[0].svc;

    if (primary) {
      const det = findChar(primary, CHAR_OCCUPANCY_DETECTED);
      if (det?.iid !== undefined) {
        result.primaryOccupancyIid = det.iid;
        state.occupancy = det.value === 1 || det.value === true;
      }
    }

    const excluded = new Set((opts.excludedZones ?? []).map((s) => s.toLowerCase()));
    for (const { svc, name } of occupancyServices) {
      if (svc === primary) continue;
      const zoneName = name ?? `Zone ${svc.iid}`;
      if (excluded.has(zoneName.toLowerCase())) continue;
      const det = findChar(svc, CHAR_OCCUPANCY_DETECTED);
      if (det?.iid === undefined) continue;
      const slug = slugify(zoneName);
      const zone: ZoneState = {
        name: zoneName,
        slug,
        occupancy: det.value === 1 || det.value === true,
        aid,
        serviceIid: svc.iid,
        occupancyIid: det.iid,
      };
      state.zones.set(slug, zone);
    }
  }

  return result;
}

export interface ResetCandidate {
  id: string;
  description: string;
  reason: 'config-override' | 'description-match' | 'vendor-uuid';
}

export interface ResetDetection {
  chosen: ResetCandidate | null;
  /** All candidates the heuristic identified, in priority order. */
  candidates: ResetCandidate[];
}

/**
 * Pick a candidate "reset presence" trigger characteristic.
 *
 * Priority:
 *   1. Explicit override (`override = "aid.iid"`) — highest priority.
 *   2. Writable Boolean characteristics whose description matches
 *      /reset|clear|presence|train/ — most likely the right one.
 *   3. Writable Boolean characteristics on a vendor (non-Apple-standard) UUID.
 *   4. Otherwise null.
 */
export function detectResetCharacteristic(
  payload: Accessories | null | undefined,
  override?: string,
): ResetDetection {
  if (override && /^\d+\.\d+$/.test(override)) {
    const cand: ResetCandidate = {
      id: override,
      description: 'config override',
      reason: 'config-override',
    };
    return { chosen: cand, candidates: [cand] };
  }

  const candidates: ResetCandidate[] = [];
  if (!payload?.accessories) return { chosen: null, candidates };

  for (const accessory of payload.accessories) {
    if (!accessory) continue;
    const aid = accessory.aid ?? 1;
    for (const svc of accessory.services ?? []) {
      if (!svc) continue;
      for (const ch of svc.characteristics ?? []) {
        if (ch.iid === undefined) continue;
        const writable = Array.isArray(ch.perms)
          && (ch.perms.includes('pw') || ch.perms.includes('tw'));
        if (!writable) continue;
        const isBool = ch.format === 'bool' || ch.format === 'uint8';
        if (!isBool) continue;

        const id = `${aid}.${ch.iid}`;
        const desc = (ch.description ?? '').toLowerCase();
        const isAppleStandard = typeof ch.type === 'string'
          && /^[0-9a-f]{8}-0000-1000-8000-0026bb765291$/i.test(ch.type);
        const isShortAppleStandard = typeof ch.type === 'string'
          && /^[0-9a-f]{1,8}$/i.test(ch.type);

        if (/reset|clear|presence|train/i.test(desc)) {
          candidates.push({ id, description: desc || ch.type || '', reason: 'description-match' });
        } else if (!isAppleStandard && !isShortAppleStandard) {
          candidates.push({ id, description: desc || ch.type || '', reason: 'vendor-uuid' });
        }
      }
    }
  }

  // Stable sort: description-match before vendor-uuid.
  const ordered = [...candidates].sort((a, b) => {
    const score = (r: ResetCandidate['reason']) => (r === 'description-match' ? 0 : 1);
    return score(a.reason) - score(b.reason);
  });

  return {
    chosen: ordered[0] ?? null,
    candidates: ordered,
  };
}
