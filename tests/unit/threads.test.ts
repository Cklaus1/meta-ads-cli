import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerThreadsCommands } from '../../src/commands/threads.js';
import { THREADS_BASE_URL, type MetaClient } from '../../src/meta-client.js';

describe('threads commands (BUG-19)', () => {
  afterEach(() => { delete process.env.META_ADS_CLI_THREADS_ACCESS_TOKEN; });

  it('targets graph.threads.com with the Threads token', async () => {
    process.env.META_ADS_CLI_THREADS_ACCESS_TOKEN = 'TH_TOKEN';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { request: vi.fn().mockResolvedValue({ data: { id: 'c1' }, status: 200 }) };
    const program = new Command();
    registerThreadsCommands(program, () => client as unknown as MetaClient);
    await program.parseAsync(['node', 'meta-ads', 'threads', 'profile']);
    expect(client.request).toHaveBeenCalledWith('me', expect.objectContaining({ baseUrl: THREADS_BASE_URL, accessToken: 'TH_TOKEN' }));
    expect(THREADS_BASE_URL).toMatch(/^https:\/\/graph\.threads\.com\//);
  });

  it('searches via keyword_search', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { request: vi.fn().mockResolvedValue({ data: { data: [] }, status: 200 }) };
    const program = new Command();
    registerThreadsCommands(program, () => client as unknown as MetaClient);
    await program.parseAsync(['node', 'meta-ads', 'threads', 'search', 'coffee', '--search-type', 'recent']);
    expect(client.request).toHaveBeenCalledWith('keyword_search', expect.objectContaining({
      params: expect.objectContaining({ q: 'coffee', search_type: 'RECENT' }),
    }));
  });
});

describe('buildThreadsPostFields', () => {
  it('builds poll, gif, spoiler, reply and share fields', async () => {
    const { buildThreadsPostFields } = await import('../../src/commands/threads.js');
    const body = buildThreadsPostFields({
      text: 'Which one?', mediaType: 'TEXT', poll: 'A, B, C', topicTag: 'coffee',
      spoilerText: '0:5', replyControl: 'followers_only', shareToIgStory: true, countries: 'us,gb',
    });
    expect(JSON.parse(body.poll_attachment)).toEqual({ option_a: 'A', option_b: 'B', option_c: 'C' });
    expect(JSON.parse(body.text_entities)).toEqual([{ entity_type: 'SPOILER', offset: 0, length: 5 }]);
    expect(body).toMatchObject({ topic_tag: 'coffee', reply_control: 'followers_only', crossreshare_to_ig: 'true' });
    expect(JSON.parse(body.allowlisted_country_codes)).toEqual(['US', 'GB']);
    expect(JSON.parse(buildThreadsPostFields({ text: 'x', gifId: 'g1' }).gif_attachment)).toEqual({ gif_id: 'g1', provider: 'GIPHY' });
  });

  it('rejects invalid input', async () => {
    const { buildThreadsPostFields } = await import('../../src/commands/threads.js');
    const sixLinks = Array.from({ length: 6 }, (_, i) => `https://a${i}.com`).join(' ');
    expect(() => buildThreadsPostFields({ text: sixLinks })).toThrow('at most 5 links');
    expect(() => buildThreadsPostFields({ text: 'x', poll: 'only one' })).toThrow('2 to 4');
    expect(() => buildThreadsPostFields({ text: 'x', imageUrl: 'https://i', poll: 'a,b' })).toThrow('text posts');
    expect(() => buildThreadsPostFields({ text: 'x', topicTag: 'a.b' })).toThrow('topic-tag');
    expect(() => buildThreadsPostFields({ text: 'x', replyControl: 'nobody' })).toThrow('--reply-control');
    expect(() => buildThreadsPostFields({ text: 'x'.repeat(501) })).toThrow('500 characters');
  });
});
