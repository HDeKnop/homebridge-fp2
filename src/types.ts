/**
 * Public, plugin-internal types. Anything related to the wire format of HAP
 * stays inside hap-client.ts; everything else consumes these.
 */

export interface Fp2DeviceConfig {
  name: string;
  host: string;
  port?: number;
  pin: string;
  exposeZones?: boolean;
  exposeLightSensor?: boolean;
  pollIntervalSeconds?: number;
  excludedZones?: string[];
  debug?: boolean;
}

export interface Fp2PlatformConfig {
  name?: string;
  devices?: Fp2DeviceConfig[];
}

export interface ZoneState {
  /** Human-readable zone name (HAP Service.Name characteristic). */
  name: string;
  /** Stable id derived from the name; used for HomeKit UUID generation. */
  slug: string;
  occupancy: boolean;
  /** HAP accessory id of the zone-bearing accessory (usually 1). */
  aid: number;
  /** HAP instance id of the OccupancySensor service. */
  serviceIid: number;
  /** HAP instance id of the OccupancyDetected characteristic. */
  occupancyIid: number;
}

export interface Fp2State {
  /** Primary mmWave occupancy. */
  occupancy: boolean;
  /** Light level in lux, or null if device doesn't expose / hasn't reported it yet. */
  lightLevel: number | null;
  /** Zones, keyed by slug. */
  zones: Map<string, ZoneState>;
  /** True after at least one successful read from the device. */
  reachable: boolean;
}

/** Persistent pairing data — exactly what hap-controller hands us from PairSetup. */
export interface PairingData {
  AccessoryPairingID: string;
  AccessoryLTPK: string;
  iOSDevicePairingID: string;
  iOSDeviceLTSK: string;
  iOSDeviceLTPK: string;
}

export interface StoredPairing {
  deviceId: string;
  host: string;
  port: number;
  pairing: PairingData;
  pairedAt: string;
}
