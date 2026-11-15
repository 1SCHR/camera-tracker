// The check-digit numbers below are made up (or the standard textbook UPC
// example), not real product barcodes.

import { describe, it, expect } from 'vitest';
import { isValidGtin } from '../../src/seed/gtin.ts';

describe('GTIN check digit', () => {
  it('accepts a correct 12-digit UPC', () => {
    expect(isValidGtin('012345678905')).toBe(true);
  });

  it('accepts correct 13-digit and 8-digit codes', () => {
    expect(isValidGtin('2000000000008')).toBe(true);
    expect(isValidGtin('20000004')).toBe(true);
  });

  it('refuses a code whose last digit is off by one (a typical typo)', () => {
    expect(isValidGtin('012345678904')).toBe(false);
    expect(isValidGtin('2000000000009')).toBe(false);
  });

  it('refuses two swapped neighbouring digits', () => {
    // 012345678905 with the "4" and "5" swapped.
    expect(isValidGtin('012354678905')).toBe(false);
  });

  it('refuses letters, spaces and wrong lengths', () => {
    expect(isValidGtin('01234567890A')).toBe(false);
    expect(isValidGtin('0 12345 67890 5')).toBe(false);
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('')).toBe(false);
  });
});
