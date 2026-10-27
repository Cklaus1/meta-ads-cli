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

describe('Instagram insights defaults (META_API_UPDATES #5)', () => {
  it('uses current metrics with total_value for account insights', async () => {
    const { Command } = await import('commander');
    const { registerInstagramCommands } = await import('../../src/commands/instagram.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const request = vi.fn().mockResolvedValue({ data: {}, status: 200 });
    const program = new Command();
    registerInstagramCommands(program, () => ({ request } as unknown as MetaClient));
    await program.parseAsync(['node', 'meta-ads', 'instagram', 'insights', '1']);
    await program.parseAsync(['node', 'meta-ads', 'instagram', 'media-insights', '2']);
    const [account, media] = request.mock.calls.map(c => c[1].params);
    expect(account.metric_type).toBe('total_value');
    for (const p of [account, media]) {
      expect(p.metric).toContain('views');
      expect(p.metric).not.toMatch(/impressions|profile_views|website_clicks|video_views/);
    }
  });
});
