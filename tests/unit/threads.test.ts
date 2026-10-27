import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerThreadsCommands } from '../../src/commands/threads.js';
import { THREADS_BASE_URL, type MetaClient } from '../../src/meta-client.js';

describe('threads commands (BUG-19)', () => {
  afterEach(() => { delete process.env.META_ADS_CLI_THREADS_ACCESS_TOKEN; });

  it('targets graph.threads.net with the Threads token', async () => {
    process.env.META_ADS_CLI_THREADS_ACCESS_TOKEN = 'TH_TOKEN';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { request: vi.fn().mockResolvedValue({ data: { id: 'c1' }, status: 200 }) };
    const program = new Command();
    registerThreadsCommands(program, () => client as unknown as MetaClient);
    await program.parseAsync(['node', 'meta-ads', 'threads', 'profile']);
    expect(client.request).toHaveBeenCalledWith('me', expect.objectContaining({ baseUrl: THREADS_BASE_URL, accessToken: 'TH_TOKEN' }));
    expect(THREADS_BASE_URL).toMatch(/^https:\/\/graph\.threads\.net\//);
  });
});
