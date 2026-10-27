import { describe, it, expect } from 'vitest';
import { parsePrice } from '../../src/commands/catalog.js';

describe('parsePrice', () => {
  it('parses dot and comma decimals into cents', () => {
    expect(parsePrice('29.99 USD')).toEqual({ amount: 2999, currency: 'USD' });
    expect(parsePrice('29,99 EUR')).toEqual({ amount: 2999, currency: 'EUR' });
    expect(parsePrice('1,299.50 USD')).toEqual({ amount: 129950, currency: 'USD' });
    expect(parsePrice('1,299 USD')).toEqual({ amount: 129900, currency: 'USD' });
  });

  it('uses minor units for zero-decimal currencies', () => {
    expect(parsePrice('1000 JPY')).toEqual({ amount: 1000, currency: 'JPY' });
  });

  it('defaults the currency', () => {
    expect(parsePrice('5', 'GBP')).toEqual({ amount: 500, currency: 'GBP' });
  });

  it('rejects junk', () => {
    expect(() => parsePrice('abc')).toThrow('Invalid price');
    expect(() => parsePrice('1.2.3 USD')).toThrow('Invalid price');
    expect(() => parsePrice('10 XYZ')).toThrow();
  });
});
