import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { hashUserData } from '../../src/commands/conversions.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('hashUserData', () => {
  it('normalizes and hashes em and ph', () => {
    const out = hashUserData({ em: ' A@B.com ', ph: '+1 (555) 123-4567', client_ip_address: '1.2.3.4' });
    expect(out.em).toBe(sha('a@b.com'));
    expect(out.ph).toBe(sha('15551234567'));
    expect(out.client_ip_address).toBe('1.2.3.4');
  });

  it('passes through values that are already hashed', () => {
    const h = sha('a@b.com');
    expect(hashUserData({ em: h.toUpperCase() }).em).toBe(h);
  });

  it('hashes each element of array values', () => {
    const out = hashUserData({ em: ['x@y.com', 'Z@Y.com'] });
    expect(out.em).toEqual([sha('x@y.com'), sha('z@y.com')]);
  });
});
