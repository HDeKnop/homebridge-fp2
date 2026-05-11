import type {
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { FP2Platform } from './platform.js';
import type { Fp2HapClient } from './hap-client.js';
import {
  makeLastActivationCharacteristic,
  nowEveSeconds,
} from './eve-characteristics.js';
import { sanitizeHapName, toHapLux, toHapOccupancy } from './mappers.js';
import { RESET_SWITCH_PULSE_MS } from './settings.js';
import type { Fp2DeviceConfig, Fp2State, ZoneState } from './types.js';

/** Bridges a single FP2 device to one PlatformAccessory carrying all its services. */
export class Fp2Accessory {
  private mainOccupancyService: Service;
  private lightSensorService: Service | null = null;
  private resetSwitchService: Service | null = null;
  private resetSwitchAutoOffTimer: NodeJS.Timeout | null = null;
  /** Zone subtype → Service for fast updates. */
  private zoneServices = new Map<string, Service>();
  /** Eve-style last-activation marker; bumped whenever any occupancy goes high. */
  private lastActivationSeconds = 0;
  private lastOccupancy = false;

  constructor(
    private readonly platform: FP2Platform,
    private readonly accessory: PlatformAccessory,
    private readonly client: Fp2HapClient,
    private readonly cfg: Fp2DeviceConfig,
  ) {
    this.applyAccessoryInfo();
    this.mainOccupancyService = this.ensureMainOccupancyService();
    if (cfg.exposeLightSensor !== false) {
      this.lightSensorService = this.ensureLightSensorService();
    } else {
      this.removeLightSensorIfPresent();
    }

    if (cfg.exposeResetSwitch === true) {
      this.resetSwitchService = this.ensureResetSwitchService();
    } else {
      this.removeResetSwitchIfPresent();
    }

    // Initial sync from current cached state (may be empty pre-connect).
    this.syncFromState(client.getState());

    client.on('state', (state) => this.syncFromState(state));
    client.on('connected', () => this.setStatusActive(true));
    client.on('disconnected', () => this.setStatusActive(false));
    // Without an 'error' listener, EventEmitter treats emit('error') as a throw
    // — that would crash Homebridge on every unreachable FP2. The HAP client
    // already logs at warn level, so this listener just absorbs the event.
    client.on('error', () => { /* logged by Fp2HapClient */ });
  }

  private applyAccessoryInfo(): void {
    const C = this.platform.Characteristic;
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);
    info.setCharacteristic(C.Name, sanitizeHapName(this.cfg.name, 'FP2'));
    info.setCharacteristic(C.Manufacturer, 'Aqara');
    info.setCharacteristic(C.Model, this.client.getModel() ?? 'Presence Sensor FP2');
    // Serial: the HAP-discovered Aqara serial when available, else FP2's MAC-
    // derived deviceId, else fall back to host. Avoid sticking an IP in here
    // (some HomeKit validators flag IP-style serials).
    const serial = this.client.getSerialNumber()
      ?? this.client.getDeviceId()
      ?? `fp2-${this.cfg.host.replace(/\./g, '-')}`;
    info.setCharacteristic(C.SerialNumber, serial);
    // FirmwareRevision must match /^\d+(\.\d+){0,2}$/. Apple Home marks the
    // whole accessory "No Response" when this is malformed (e.g. literal "0").
    // We prefer the FP2's own reported value (normalized) and only fall back
    // to a safe default if we haven't discovered it yet — the live value will
    // be patched in via refreshAccessoryInfo() once the first state arrives.
    info.setCharacteristic(C.FirmwareRevision, this.client.getFirmwareRevision() ?? '0.0.0');
    info.setCharacteristic(C.HardwareRevision, this.client.getHardwareRevision() ?? '0.0.0');
  }

  /** Update AccessoryInformation once we've actually fetched the FP2 service
   *  tree (real serial / model / firmware arrive after the first connect). */
  refreshAccessoryInfo(): void {
    const C = this.platform.Characteristic;
    const info = this.accessory.getService(this.platform.Service.AccessoryInformation);
    if (!info) return;
    const model = this.client.getModel();
    if (model) info.updateCharacteristic(C.Model, model);
    const serial = this.client.getSerialNumber();
    if (serial) info.updateCharacteristic(C.SerialNumber, serial);
    const firmware = this.client.getFirmwareRevision();
    if (firmware) info.updateCharacteristic(C.FirmwareRevision, firmware);
    const hardware = this.client.getHardwareRevision();
    if (hardware) info.updateCharacteristic(C.HardwareRevision, hardware);
  }

  private ensureMainOccupancyService(): Service {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    const subtype = 'main';
    const existing = this.accessory.getServiceById(S.OccupancySensor, subtype)
      ?? this.accessory.getService(S.OccupancySensor);
    const safeName = sanitizeHapName(this.cfg.name, 'FP2');
    const service = existing ?? this.accessory.addService(S.OccupancySensor, safeName, subtype);

    service.setCharacteristic(C.Name, safeName);
    service.getCharacteristic(C.OccupancyDetected)
      .onGet(() => toHapOccupancy(this.client.getState().occupancy));
    service.getCharacteristic(C.StatusActive)
      .onGet(() => this.client.getState().reachable);

    // Eve "Last Activation" — added once per service lifetime. The
    // addOptionalCharacteristic typing wants the full class signature, but
    // getCharacteristic takes the no-arg constructor — cast accordingly.
    const LastActivation = makeLastActivationCharacteristic(this.platform.api);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const LastActivationCls = LastActivation as any;
    if (!service.testCharacteristic(LastActivationCls)) {
      service.addOptionalCharacteristic(LastActivationCls);
    }
    service.getCharacteristic(LastActivation)
      .onGet(() => this.lastActivationSeconds);

    return service;
  }

  private ensureLightSensorService(): Service {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    const existing = this.accessory.getService(S.LightSensor);
    const service = existing ?? this.accessory.addService(
      S.LightSensor,
      sanitizeHapName(`${this.cfg.name} Light`, 'FP2 Light'),
    );
    service.getCharacteristic(C.CurrentAmbientLightLevel)
      .onGet(() => toHapLux(this.client.getState().lightLevel));
    return service;
  }

  private removeLightSensorIfPresent(): void {
    const existing = this.accessory.getService(this.platform.Service.LightSensor);
    if (existing) this.accessory.removeService(existing);
  }

  /**
   * Momentary "Reset Presence" switch. Turning it on writes the reset trigger
   * to the FP2 (clearing stuck presence), then auto-toggles back off ~1s later
   * so the tile behaves as a button.
   */
  private ensureResetSwitchService(): Service {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    const subtype = 'reset-presence';
    const existing = this.accessory.getServiceById(S.Switch, subtype);
    const switchName = sanitizeHapName(`${this.cfg.name} Reset Presence`, 'Reset Presence');
    const service = existing ?? this.accessory.addService(S.Switch, switchName, subtype);
    service.setCharacteristic(C.Name, switchName);
    service.getCharacteristic(C.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (value !== true) return;
        try {
          await this.client.triggerPresenceReset();
        } catch (err) {
          this.platform.log.warn(
            `[${this.cfg.name}] reset-presence write failed: ${(err as Error).message}`,
          );
        }
        if (this.resetSwitchAutoOffTimer) clearTimeout(this.resetSwitchAutoOffTimer);
        this.resetSwitchAutoOffTimer = setTimeout(() => {
          this.resetSwitchService?.updateCharacteristic(C.On, false);
        }, RESET_SWITCH_PULSE_MS);
      });
    return service;
  }

  private removeResetSwitchIfPresent(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'reset-presence');
    if (existing) this.accessory.removeService(existing);
  }

  private syncFromState(state: Fp2State): void {
    const C = this.platform.Characteristic;
    // Pick up the real serial/model from the FP2 if we have them now.
    this.refreshAccessoryInfo();
    if (state.occupancy && !this.lastOccupancy) {
      // Rising edge — bump Last Activation.
      this.lastActivationSeconds = nowEveSeconds();
      const LastActivation = makeLastActivationCharacteristic(this.platform.api);
      this.mainOccupancyService.updateCharacteristic(LastActivation, this.lastActivationSeconds);
    }
    this.lastOccupancy = state.occupancy;

    this.mainOccupancyService
      .updateCharacteristic(C.OccupancyDetected, toHapOccupancy(state.occupancy));
    this.mainOccupancyService
      .updateCharacteristic(C.StatusActive, state.reachable);
    if (this.lightSensorService) {
      this.lightSensorService
        .updateCharacteristic(C.CurrentAmbientLightLevel, toHapLux(state.lightLevel));
      this.lightSensorService
        .updateCharacteristic(C.StatusActive, state.reachable);
    }
    if (this.cfg.exposeZones !== false) {
      this.reconcileZoneServices(state.zones);
    } else {
      this.removeAllZoneServices();
    }
  }

  private reconcileZoneServices(zones: Map<string, ZoneState>): void {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    let structuralChange = false;

    // Remove zones no longer present.
    for (const [subtype, service] of this.zoneServices) {
      if (!zones.has(subtype)) {
        this.accessory.removeService(service);
        this.zoneServices.delete(subtype);
        structuralChange = true;
      }
    }

    for (const [slug, zone] of zones) {
      let service = this.zoneServices.get(slug);
      if (!service) {
        const existing = this.accessory.getServiceById(S.OccupancySensor, slug);
        if (!existing) structuralChange = true;
        const zoneName = sanitizeHapName(this.zoneDisplayName(zone.name), 'Zone');
        service = existing ?? this.accessory.addService(S.OccupancySensor, zoneName, slug);
        service.setCharacteristic(C.Name, zoneName);
        service.getCharacteristic(C.OccupancyDetected)
          .onGet(() => {
            const live = this.client.getState().zones.get(slug);
            return toHapOccupancy(live?.occupancy ?? false);
          });
        service.getCharacteristic(C.StatusActive)
          .onGet(() => this.client.getState().reachable);
        this.zoneServices.set(slug, service);
      }
      service.updateCharacteristic(C.OccupancyDetected, toHapOccupancy(zone.occupancy));
      service.updateCharacteristic(C.StatusActive, this.client.getState().reachable);
    }

    // Critical: if we added or removed any service, publish the updated
    // accessory tree to HAP. Otherwise paired iOS clients keep their stale
    // view, see characteristic events for unknown IIDs, and mark the
    // accessory "No Response". updatePlatformAccessories bumps configVersion
    // and writes cachedAccessories.json.
    if (structuralChange) {
      this.platform.api.updatePlatformAccessories([this.accessory]);
      this.platform.log.debug(
        `[${this.cfg.name}] zone topology changed → published ${this.zoneServices.size} zone service(s) to HAP`,
      );
    }
  }

  private removeAllZoneServices(): void {
    for (const [slug, service] of this.zoneServices) {
      this.accessory.removeService(service);
      this.zoneServices.delete(slug);
    }
  }

  private setStatusActive(active: boolean): void {
    const C = this.platform.Characteristic;
    this.mainOccupancyService.updateCharacteristic(C.StatusActive, active);
    this.lightSensorService?.updateCharacteristic(C.StatusActive, active);
    for (const svc of this.zoneServices.values()) {
      svc.updateCharacteristic(C.StatusActive, active);
    }
  }

  private zoneDisplayName(name: string): string {
    return `${this.cfg.name} ${name}`.trim();
  }

}
