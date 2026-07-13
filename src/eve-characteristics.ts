import type { API, Characteristic, WithUUID } from 'homebridge';

/**
 * Eve-style "Last Activation" characteristic. Apple's stock HomeKit doesn't
 * expose this, but Eve and Controller for HomeKit render it as a "X minutes
 * ago" tile and let users build "no motion for 10 min" automations.
 *
 * Stored as seconds since the Eve epoch (2001-01-01).
 */
export const EVE_LAST_ACTIVATION_UUID = 'E863F11A-079E-48FF-8F27-9C2605A29F52';
export const EVE_EPOCH_OFFSET = 978_307_200;

/**
 * Returns the Last Activation characteristic class as a no-arg constructor —
 * the shape Homebridge's `addOptionalCharacteristic` and `getCharacteristic`
 * expect. The runtime class extends `api.hap.Characteristic` (which has a
 * 3-arg constructor); we wrap it in a default-constructed subclass.
 */
export function makeLastActivationCharacteristic(api: API): WithUUID<new () => Characteristic> {
  const Char = api.hap.Characteristic;

  class LastActivation extends Char {
    static readonly UUID = EVE_LAST_ACTIVATION_UUID;
    constructor() {
      super('Last Activation', EVE_LAST_ACTIVATION_UUID, {
        format: 'uint32',
        unit: 'seconds',
        perms: ['pr' as never, 'ev' as never],
      });
      this.value = 0;
    }
  }
  return LastActivation as unknown as WithUUID<new () => Characteristic>;
}

export function nowEveSeconds(): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - EVE_EPOCH_OFFSET);
}
