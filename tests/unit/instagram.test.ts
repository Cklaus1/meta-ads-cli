import { describe, it, expect, vi } from 'vitest';
import { waitForContainer } from '../../src/commands/instagram.js';
import type { MetaClient } from '../../src/meta-client.js';

function clientWith(statuses: string[]) {
  const request = vi.fn();
  for (const s of statuses) request.mockResolvedValueOnce({ data: { status_code: s }, status: 200 });
  return { client: { request, isDryRun: () => false } as unknown as MetaClient, request };
}

describe('waitForContainer', () => {
  it('returns once the container is FINISHED', async () => {
    const { client, request } = clientWith(['IN_PROGRESS', 'FINISHED']);
    await waitForContainer(client, '1', { intervalMs: 0 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('throws on ERROR', async () => {
    const { client } = clientWith(['ERROR']);
    await expect(waitForContainer(client, '1', { intervalMs: 0 })).rejects.toThrow('ERROR');
  });

  it('throws on timeout instead of returning', async () => {
    const { client } = clientWith(['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS']);
    await expect(waitForContainer(client, '1', { intervalMs: 0, maxAttempts: 3 })).rejects.toThrow('still processing');
  });

  it('skips polling in dry-run', async () => {
    const request = vi.fn();
    await waitForContainer({ request, isDryRun: () => true } as unknown as MetaClient, '1');
    expect(request).not.toHaveBeenCalled();
  });
});
