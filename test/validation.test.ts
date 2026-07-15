import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HAP_NAME_REGEX, HAP_NAME_SINGLE_CHAR_REGEX, HAP_PIN_REGEX, isValidHapName, normalizePin } from '../src/validation.js';

describe('normalizePin', () => {
  it('canonicalizes the sticker format', () => {
    expect(normalizePin('1234-5678')).toEqual({ ok: true, pin: '123-45-678' });
    expect(normalizePin('12345678')).toEqual({ ok: true, pin: '123-45-678' });
    expect(normalizePin('123-45-678')).toEqual({ ok: true, pin: '123-45-678' });
    expect(normalizePin(' 1234 5678 ')).toEqual({ ok: true, pin: '123-45-678' });
  });

  it('rejects anything without exactly 8 digits', () => {
    expect(normalizePin('1234-567')).toEqual({ ok: false, digitCount: 7 });
    expect(normalizePin('123456789')).toEqual({ ok: false, digitCount: 9 });
    expect(normalizePin('')).toEqual({ ok: false, digitCount: 0 });
  });
});

describe('isValidHapName', () => {
  it('accepts HAP-2.0-safe names', () => {
    expect(isValidHapName('Living Room FP2')).toBe(true);
    expect(isValidHapName("Bob's Office")).toBe(true);
    expect(isValidHapName('A')).toBe(true);
  });

  it('rejects invalid characters and edges', () => {
    expect(isValidHapName('FP2 (office)')).toBe(false);
    expect(isValidHapName('trailing ')).toBe(false);
    expect(isValidHapName('')).toBe(false);
  });
});

/* The same rules exist as literals in two artifacts that cannot import
 * src/validation.ts: config.schema.json (data consumed by Config UI X) and
 * homebridge-ui/public/wizard.js (a plain browser script). These tests fail
 * when either copy drifts from the shared source of truth. */
describe('validation-rule drift guards', () => {
  const root = join(__dirname, '..');

  it('config.schema.json pin pattern matches HAP_PIN_REGEX behavior', () => {
    const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8'));
    const pattern: string = schema.schema.properties.devices.items.properties.pin.pattern;
    const schemaRegex = new RegExp(pattern);
    const samples = ['123-45-678', '000-00-000', '12345678', '1234-5678', '123-456-78', 'abc-de-fgh', ''];
    for (const s of samples) {
      expect(schemaRegex.test(s), `schema and HAP_PIN_REGEX disagree on "${s}"`).toBe(HAP_PIN_REGEX.test(s));
    }
  });

  it('wizard.js contains the exact HAP name regexes', () => {
    const wizard = readFileSync(join(root, 'homebridge-ui', 'public', 'wizard.js'), 'utf8');
    expect(wizard).toContain(HAP_NAME_REGEX.source);
    expect(wizard).toContain(HAP_NAME_SINGLE_CHAR_REGEX.source);
  });
});
