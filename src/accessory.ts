import type { PlatformAccessory, Service } from 'homebridge';

import type { FP2Platform } from './platform.js';
import type { Fp2HapClient } from './hap-client.js';
import { makeLastActivationCharacteristic, nowEveSeconds } from './eve-characteristics.js';
import { sanitizeHapName, toHapLux, toHapOccupancy } from './mappers.js';
import type { Fp2DeviceConfig, Fp2State, ZoneState } from './types.js';

/** Bridges a single FP2 device to one PlatformAccessory carrying all its services. */
export class Fp2Accessory {
  private mainOccupancyService: Service;
  private lightSensorService: Service | null = null;
  /** Zone subtype → Service for fast updates. */
  private zoneServices = new Map<string, Service>();
  /** Eve-style last-activation marker; bumped whenever any occupancy goes high. */
  private lastActivationSeconds = 0;
  private lastOccupancy = false;

  constructor(
    private readonly platform: FP2Platform,
    private readonly accessory: PlatformAccessory,
    private readonly client: Fp2HapClient,
    private readonly cfg: Fp2DeviceConfig
  ) {
    this.applyAccessoryInfo();
    this.mainOccupancyService = this.ensureMainOccupancyService();
    if (cfg.exposeLightSensor !== false) {
      this.lightSensorService = this.ensureLightSensorService();
    } else {
      this.removeLightSensorIfPresent();
    }

    // Defensive: a previous version of the plugin exposed a "Reset Presence"
    // Switch service. If the cached accessory still has it, remove it so the
    // tree matches what's documented now.
    this.removeLegacyResetSwitchIfPresent();

    // Initial sync from current cached state (may be empty pre-connect).
    this.syncFromState(client.getState());

    client.on('state', state => this.syncFromState(state));
    client.on('connected', () => this.setStatusActive(true));
    client.on('disconnected', () => this.setStatusActive(false));
    // Without an 'error' listener, EventEmitter treats emit('error') as a throw
    // — that would crash Homebridge on every unreachable FP2. The HAP client
    // already logs at warn level, so this listener only refreshes StatusFault:
    // a terminal give-up isn't a 'disconnected' transition, so nothing else
    // would surface it.
    client.on('error', () => {
      this.refreshFault();
    });
  }

  private applyAccessoryInfo(): void {
    const C = this.platform.Characteristic;
    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ??
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    info.setCharacteristic(C.Name, sanitizeHapName(this.cfg.name, 'FP2'));
    info.setCharacteristic(C.Manufacturer, 'Aqara');
    info.setCharacteristic(C.Model, this.client.getModel() ?? 'Presence Sensor FP2');
    // Serial: the HAP-discovered Aqara serial when available, else FP2's MAC-
    // derived deviceId, else fall back to host. Avoid sticking an IP in here
    // (some HomeKit validators flag IP-style serials).
    const serial = this.client.getSerialNumber() ?? this.client.getDeviceId() ?? `fp2-${this.cfg.host.replace(/\./g, '-')}`;
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
    const existing = this.accessory.getServiceById(S.OccupancySensor, subtype) ?? this.accessory.getService(S.OccupancySensor);
    const safeName = sanitizeHapName(this.cfg.mainSensorName ?? this.cfg.name, 'FP2');
    const service = existing ?? this.accessory.addService(S.OccupancySensor, safeName, subtype);

    service.setCharacteristic(C.Name, safeName);
    service.getCharacteristic(C.OccupancyDetected).onGet(() => toHapOccupancy(this.client.getState().occupancy));
    service.getCharacteristic(C.StatusActive).onGet(() => this.client.getState().reachable);
    this.wireFault(service);

    // Eve "Last Activation" — added once per service lifetime. The
    // addOptionalCharacteristic typing wants the full class signature, but
    // getCharacteristic takes the no-arg constructor — cast accordingly.
    const LastActivation = makeLastActivationCharacteristic(this.platform.api);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const LastActivationCls = LastActivation as any;
    if (!service.testCharacteristic(LastActivationCls)) {
      service.addOptionalCharacteristic(LastActivationCls);
    }
    service.getCharacteristic(LastActivation).onGet(() => this.lastActivationSeconds);

    return service;
  }

  private ensureLightSensorService(): Service {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    const existing = this.accessory.getService(S.LightSensor);
    const lightName = sanitizeHapName(this.cfg.lightSensorName ?? `${this.cfg.name} Light`, 'FP2 Light');
    const service = existing ?? this.accessory.addService(S.LightSensor, lightName);
    service.setCharacteristic(C.Name, lightName);
    service.getCharacteristic(C.CurrentAmbientLightLevel).onGet(() => toHapLux(this.client.getState().lightLevel));
    // Live getter so the light sensor's StatusActive reflects current
    // reachability on every read — matching the main occupancy sensor and zones.
    // Without it the value only tracks the last pushed update and can read 0
    // (stale) while the presence sensor reads 1.
    service.getCharacteristic(C.StatusActive).onGet(() => this.client.getState().reachable);
    this.wireFault(service);
    return service;
  }

  private removeLightSensorIfPresent(): void {
    const existing = this.accessory.getService(this.platform.Service.LightSensor);
    if (existing) this.accessory.removeService(existing);
  }

  /**
   * Earlier versions of the plugin exposed a momentary "Reset Presence" Switch
   * that wrote a discovered writable boolean characteristic on the FP2.
   * Public reverse-engineering hasn't pinned down a reliable trigger across
   * firmware revisions, so the feature is parked. This helper strips the
   * service from a cached accessory left over from those earlier versions.
   */
  private removeLegacyResetSwitchIfPresent(): void {
    const existing = this.accessory.getServiceById(this.platform.Service.Switch, 'reset-presence');
    if (existing) {
      this.accessory.removeService(existing);
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
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

    this.mainOccupancyService.updateCharacteristic(C.OccupancyDetected, toHapOccupancy(state.occupancy));
    this.mainOccupancyService.updateCharacteristic(C.StatusActive, state.reachable);
    if (this.lightSensorService) {
      this.lightSensorService.updateCharacteristic(C.CurrentAmbientLightLevel, toHapLux(state.lightLevel));
      this.lightSensorService.updateCharacteristic(C.StatusActive, state.reachable);
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
        service.getCharacteristic(C.OccupancyDetected).onGet(() => {
          const live = this.client.getState().zones.get(slug);
          return toHapOccupancy(live?.occupancy ?? false);
        });
        service.getCharacteristic(C.StatusActive).onGet(() => this.client.getState().reachable);
        this.wireFault(service);
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
      this.platform.log.debug(`[${this.cfg.name}] zone topology changed → published ${this.zoneServices.size} zone service(s) to HAP`);
    }
  }

  private removeAllZoneServices(): void {
    for (const [slug, service] of this.zoneServices) {
      this.accessory.removeService(service);
      this.zoneServices.delete(slug);
    }
  }

  /** Wire a service's StatusFault to the client's terminal-error state, so a
   *  read (not just a push) reports the fault. Mirrors the StatusActive getters. */
  private wireFault(service: Service): void {
    const C = this.platform.Characteristic;
    service
      .getCharacteristic(C.StatusFault)
      .onGet(() => (this.client.getTerminalReason() ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT));
  }

  private setStatusActive(active: boolean): void {
    const C = this.platform.Characteristic;
    // StatusActive alone is close to invisible in the Home app — an unreachable
    // occupancy sensor still renders as a normal "No Motion" tile. StatusFault is
    // what Home actually surfaces, so a device that has permanently given up
    // (claimed by another controller, wrong pin, pairing dead after a factory
    // reset) shows as faulty instead of silently reporting "nobody home" forever.
    const fault = this.client.getTerminalReason() ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT;
    for (const svc of [this.mainOccupancyService, this.lightSensorService, ...this.zoneServices.values()]) {
      if (!svc) continue;
      svc.updateCharacteristic(C.StatusActive, active);
      svc.updateCharacteristic(C.StatusFault, fault);
    }
  }

  /** Re-evaluate StatusFault without changing reachability — called when the
   *  client gives up terminally, which is not a 'disconnected' transition. */
  private refreshFault(): void {
    this.setStatusActive(this.client.getState().reachable);
  }

  private zoneDisplayName(name: string): string {
    return (this.cfg.zoneNames?.[name] ?? `${this.cfg.name} ${name}`).trim();
  }
}
