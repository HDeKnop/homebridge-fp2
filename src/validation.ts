/**
 * Shared validation rules for user-supplied config values.
 *
 * Dependency-free leaf module (same convention as discovery.ts): the compiled
 * dist/validation.js is also imported by the Config UI server (plain JS), so
 * nothing here may depend on homebridge or any non-leaf module.
 *
 * The same rules exist as literals in two places that cannot import this
 * module — config.schema.json (data) and homebridge-ui/public/wizard.js (a
 * plain browser script Config UI X serves as-is). test/validation.test.ts
 * asserts those copies stay in sync with the constants below.
 */

/** HAP-canonical setup code: ###-##-### (8 digits). */
export const HAP_PIN_REGEX = /^\d{3}-\d{2}-\d{3}$/;

/** HAP-NodeJS 2.0 Name rule: alphanumeric, space, apostrophe only; must start
 *  and end with a letter or number (a lone apostrophe-ish char is tolerated by
 *  the single-char form). Mirrors what sanitizeHapName() would accept as-is. */
export const HAP_NAME_REGEX = /^[a-zA-Z0-9 '][a-zA-Z0-9 ']{0,38}[a-zA-Z0-9']$/;
export const HAP_NAME_SINGLE_CHAR_REGEX = /^[a-zA-Z0-9']$/;

export function isValidHapName(raw: string): boolean {
  return HAP_NAME_REGEX.test(raw) || HAP_NAME_SINGLE_CHAR_REGEX.test(raw);
}

/**
 * Coerce a setup code in any common form (sticker XXXX-XXXX, spaced, bare
 * digits) to HAP-canonical `XXX-XX-XXX`. Returns `{ ok: false }` with the
 * digit count when the input doesn't contain exactly 8 digits — the caller
 * owns the user-facing error message.
 */
export function normalizePin(pin: string): { ok: true; pin: string } | { ok: false; digitCount: number } {
  const digits = pin.replace(/\D/g, '');
  if (digits.length !== 8) return { ok: false, digitCount: digits.length };
  return { ok: true, pin: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 8)}` };
}
