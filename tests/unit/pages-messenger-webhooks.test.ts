import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerPageCommands } from '../../src/commands/pages.js';
import { registerMessengerCommands } from '../../src/commands/messenger.js';
import { registerWebhookCommands } from '../../src/commands/webhooks.js';
import type { MetaClient } from '../../src/meta-client.js';

function mockClient() {
  return {
    request: vi.fn().mockResolvedValue({ data: { id: '1' }, status: 200 }),
    requestAllPages: vi.fn().mockResolvedValue({ data: { data: [] }, status: 200 }),
    uploadFile: vi.fn().mockResolvedValue({ data: { id: 'v1' }, status: 200 }),
    getPageToken: vi.fn().mockResolvedValue('PAGE_TOKEN'),
  };
}

async function run(client: ReturnType<typeof mockClient>, args: string[]) {
  const program = new Command();
  program.exitOverride();
  const getClient = () => client as unknown as MetaClient;
  registerPageCommands(program, getClient);
  registerMessengerCommands(program, getClient);
  registerWebhookCommands(program, getClient);
  await program.parseAsync(['node', 'meta-ads', ...args]);
}

describe('Page token usage (BUG-19)', () => {
  let client: ReturnType<typeof mockClient>;
  beforeEach(() => {
    client = mockClient();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('pages create-post fetches the Page token and posts with it', async () => {
    await run(client, ['pages', 'create-post', '111', '--message', 'hi']);
    expect(client.getPageToken).toHaveBeenCalledWith('111');
    expect(client.request).toHaveBeenCalledWith('111/feed', expect.objectContaining({ method: 'POST', accessToken: 'PAGE_TOKEN' }));
  });

  it('pages update-post derives the Page from the post ID prefix', async () => {
    await run(client, ['pages', 'update-post', '111_222', '--message', 'x']);
    expect(client.getPageToken).toHaveBeenCalledWith('111');
    expect(client.request).toHaveBeenCalledWith('111_222', expect.objectContaining({ accessToken: 'PAGE_TOKEN' }));
  });

  it('pages delete-post honours --page-id', async () => {
    await run(client, ['pages', 'delete-post', '999', '--page-id', '111']);
    expect(client.getPageToken).toHaveBeenCalledWith('111');
    expect(client.request).toHaveBeenCalledWith('999', { method: 'DELETE', accessToken: 'PAGE_TOKEN' });
  });

  it('pages reply without a derivable Page asks for --page-id', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await run(client, ['pages', 'reply', '12345', '--message', 'x']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--page-id'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('pages upload-video sends title/description and the Page token', async () => {
    await run(client, ['pages', 'upload-video', '111', '--file', 'v.mp4', '--title', 'T', '--description', 'D']);
    expect(client.uploadFile).toHaveBeenCalledWith('111/videos', 'v.mp4', { title: 'T', description: 'D' }, { accessToken: 'PAGE_TOKEN' });
  });

  it('messenger send uses the Page token', async () => {
    await run(client, ['messenger', 'send', '111', '--recipient-id', '5', '--text', 'hey']);
    expect(client.request).toHaveBeenCalledWith('111/messages', expect.objectContaining({ accessToken: 'PAGE_TOKEN' }));
  });

  it('webhooks page-subscribe uses the Page token', async () => {
    await run(client, ['webhooks', 'page-subscribe', '111', '--fields', 'leadgen']);
    expect(client.request).toHaveBeenCalledWith('111/subscribed_apps', expect.objectContaining({ method: 'POST', accessToken: 'PAGE_TOKEN' }));
  });
});

describe('current insights metrics and Messenger tags (META_API_UPDATES #4, #6)', () => {
  let client: ReturnType<typeof mockClient>;
  beforeEach(() => {
    client = mockClient();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('page insights default to non-deprecated metrics', async () => {
    await run(client, ['pages', 'insights', '111']);
    const metric: string = client.request.mock.calls[0][1].params.metric;
    expect(metric).toContain('page_media_view');
    expect(metric).not.toMatch(/page_fans|page_impressions|page_engaged_users/);
  });

  it('rejects message tags Meta removed', async () => {
    const { checkMessageTag } = await import('../../src/commands/messenger.js');
    expect(() => checkMessageTag('ACCOUNT_UPDATE')).toThrow('removed by Meta');
    expect(checkMessageTag('human_agent')).toBe('HUMAN_AGENT');
  });
});
