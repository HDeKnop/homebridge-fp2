import type { Accessories } from '../src/parser.js';

/** Reasonable approximation of an FP2 with two zones, lux, and accessory info. */
export const fp2WithTwoZones: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 1,
          type: '3E',
          characteristics: [
            { iid: 2, type: '23', value: 'Living Room FP2', format: 'string', perms: ['pr'] },
            { iid: 3, type: '30', value: 'AQ-FP2-12345', format: 'string', perms: ['pr'] },
            { iid: 4, type: '21', value: 'PS-S02D', format: 'string', perms: ['pr'] },
            { iid: 5, type: '52', value: '1.1.7', format: 'string', perms: ['pr'] },
            { iid: 6, type: '53', value: '1.0.0', format: 'string', perms: ['pr'] },
          ],
        },
        {
          iid: 10,
          type: '86',
          characteristics: [
            { iid: 11, type: '71', value: 1, format: 'uint8', perms: ['pr', 'ev'] },
            { iid: 12, type: '23', value: 'Living Room FP2', format: 'string', perms: ['pr'] },
          ],
        },
        {
          iid: 20,
          type: '84',
          characteristics: [
            { iid: 21, type: '6B', value: 142.5, format: 'float', perms: ['pr', 'ev'] },
          ],
        },
        {
          iid: 30,
          type: '86',
          characteristics: [
            { iid: 31, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
            { iid: 32, type: 'E3', value: 'Sofa', format: 'string', perms: ['pr', 'pw'] },
          ],
        },
        {
          iid: 40,
          type: '86',
          characteristics: [
            { iid: 41, type: '71', value: 1, format: 'uint8', perms: ['pr', 'ev'] },
            { iid: 42, type: '23', value: 'Desk', format: 'string', perms: ['pr'] },
          ],
        },
      ],
    },
  ],
};

/** Same but with full-form HAP UUIDs to validate isHapType normalization. */
export const fp2WithFullUuids: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 1,
          type: '0000003E-0000-1000-8000-0026BB765291',
          characteristics: [
            { iid: 2, type: '00000023-0000-1000-8000-0026BB765291', value: 'FP2', format: 'string', perms: ['pr'] },
          ],
        },
        {
          iid: 10,
          type: '00000086-0000-1000-8000-0026BB765291',
          characteristics: [
            { iid: 11, type: '00000071-0000-1000-8000-0026BB765291', value: true, format: 'bool', perms: ['pr', 'ev'] },
          ],
        },
        {
          iid: 20,
          type: '00000084-0000-1000-8000-0026BB765291',
          characteristics: [
            { iid: 21, type: '0000006B-0000-1000-8000-0026BB765291', value: 50.0, format: 'float', perms: ['pr', 'ev'] },
          ],
        },
      ],
    },
  ],
};

/** FP2 with a zone-like service that has no name characteristic. */
export const fp2WithUnnamedZone: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 1,
          type: '3E',
          characteristics: [
            { iid: 2, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
          ],
        },
        {
          iid: 10,
          type: '86',
          characteristics: [
            { iid: 11, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
            { iid: 12, type: '23', value: 'FP2', format: 'string', perms: ['pr'] },
          ],
        },
        {
          iid: 30,
          type: '86',
          characteristics: [
            { iid: 31, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
          ],
        },
      ],
    },
  ],
};

/** FP2 with a writable Boolean whose description matches a reset keyword. */
export const fp2WithResetByDescription: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 10,
          type: '86',
          characteristics: [
            { iid: 11, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
            {
              iid: 99,
              type: '00000050-AQAR-1000-8000-VENDORDATA01',
              format: 'bool',
              perms: ['pw'],
              description: 'Reset Presence',
            },
          ],
        },
      ],
    },
  ],
};

/** FP2 whose only writable Boolean lives on a vendor (non-Apple) UUID. */
export const fp2WithVendorWritable: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 10,
          type: '86',
          characteristics: [
            { iid: 11, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
            {
              iid: 50,
              type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD4444',
              format: 'bool',
              perms: ['pw'],
            },
          ],
        },
      ],
    },
  ],
};

/** FP2 with multiple candidates: one description-match, one vendor-uuid. */
export const fp2WithMultipleResetCandidates: Accessories = {
  accessories: [
    {
      aid: 1,
      services: [
        {
          iid: 10,
          type: '86',
          characteristics: [
            { iid: 11, type: '71', value: 0, format: 'uint8', perms: ['pr', 'ev'] },
            {
              iid: 50,
              type: 'AAAA1111-BBBB-2222-CCCC-3333DDDD4444',
              format: 'bool',
              perms: ['pw'],
            },
            {
              iid: 51,
              type: '00000050-AQAR-1000-8000-VENDORDATA01',
              format: 'bool',
              perms: ['pw'],
              description: 'Clear Presence',
            },
          ],
        },
      ],
    },
  ],
};

/** Pathologically empty / malformed payloads. */
export const emptyPayload: Accessories = { accessories: [] };
