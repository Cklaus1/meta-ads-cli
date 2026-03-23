import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTimeRange } from '../../src/time-range.js';

describe('resolveTimeRange', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for "maximum"', () => {
    expect(resolveTimeRange('maximum')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(resolveTimeRange('')).toBeUndefined();
  });

  it('returns undefined for unrecognized range', () => {
    expect(resolveTimeRange('last_999d')).toBeUndefined();
  });

  it('resolves "today" to same since/until', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('today')!);
    expect(result.since).toBe('2026-03-20');
    expect(result.until).toBe('2026-03-20');
  });

  it('resolves "yesterday"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('yesterday')!);
    expect(result.since).toBe('2026-03-19');
    expect(result.until).toBe('2026-03-19');
  });

  it('resolves "last_7d"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('last_7d')!);
    expect(result.since).toBe('2026-03-13');
    expect(result.until).toBe('2026-03-20');
  });

  it('resolves "last_30d"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('last_30d')!);
    expect(result.since).toBe('2026-02-18');
    expect(result.until).toBe('2026-03-20');
  });

  it('resolves "last_90d"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('last_90d')!);
    expect(result.since).toBe('2025-12-20');
    expect(result.until).toBe('2026-03-20');
  });

  it('resolves "this_month"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('this_month')!);
    expect(result.since).toBe('2026-03-01');
    expect(result.until).toBe('2026-03-20');
  });

  it('resolves "last_month"', () => {
    vi.useFakeTimers({ now: new Date('2026-03-20T12:00:00Z') });
    const result = JSON.parse(resolveTimeRange('last_month')!);
    expect(result.since).toBe('2026-02-01');
    expect(result.until).toBe('2026-02-28');
  });

  it('returns valid JSON string', () => {
    const result = resolveTimeRange('last_7d');
    expect(result).toBeDefined();
    expect(() => JSON.parse(result!)).not.toThrow();
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveProperty('since');
    expect(parsed).toHaveProperty('until');
  });
});
