import { describe, it, expect } from 'vitest';
import { registerConversionCommands } from '../../src/commands/conversions.js';
import { mockClient, run } from './command-helpers.js';

describe('conversions stats', () => {
  it('sums hourly buckets per week and filters events', async () => {
    const { client, request } = mockClient(async () => ({
      data: { data: [
        { start_time: '2026-11-02', data: [{ value: 'Purchase', count: 2 }, { value: 'PageView', count: 9 }] },
        { start_time: '2026-11-01', data: [{ value: 'Purchase', count: '3' }] },
      ] }, status: 200,
    }));
    const { stdout } = await run(registerConversionCommands, client, ['conversions', 'stats', '1', '--weeks', '2', '--events', 'Purchase']);
    const rows = JSON.parse(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Purchase: 5, buckets: 2, first_bucket: '2026-11-01' });
    expect(rows[0].PageView).toBeUndefined();
    const [a, b] = request.mock.calls.map(([, o]) => o!.params!);
    expect(Number(a.end_time) - Number(a.start_time)).toBe(7 * 86400);
    expect(b.end_time).toBe(a.start_time);
  });

  it('rejects a bad --weeks', async () => {
    const { client, request } = mockClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerConversionCommands, client, ['conversions', 'stats', '1', '--weeks', '0'])).rejects.toThrow('--weeks');
    expect(request).not.toHaveBeenCalled();
  });
});
