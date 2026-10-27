import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { MetaClient } from '../../src/meta-client.js';
import { registerAdSetCommands } from '../../src/commands/adsets.js';
import { registerCreativeCommands } from '../../src/commands/creatives.js';
import { registerDuplicationCommands } from '../../src/commands/duplication.js';
import { registerAudienceCommands } from '../../src/commands/audiences.js';
import { registerCatalogCommands } from '../../src/commands/catalog.js';

type Registrar = (program: Command, getClient: () => MetaClient) => void;

function makeClient() {
  return {
    request: vi.fn().mockResolvedValue({ data: { id: '999' }, status: 200 }),
    uploadFile: vi.fn().mockResolvedValue({ data: { id: 'v1' }, status: 200 }),
    isDryRun: () => false,
  };
}

async function run(register: Registrar, client: ReturnType<typeof makeClient>, args: string[]) {
  const program = new Command();
  program.exitOverride();
  register(program, () => client as unknown as MetaClient);
  await program.parseAsync(['node', 'meta-ads', ...args]);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe('adsets update placements (BUG-16)', () => {
  it('merges placements into the current targeting', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce({ data: { targeting: { geo_locations: { countries: ['US'] } } }, status: 200 });
    await run(registerAdSetCommands, client, ['adsets', 'update', '123', '--facebook-positions', 'feed']);
    expect(client.request.mock.calls[0]).toEqual(['123', { params: { fields: 'targeting' } }]);
    const post = client.request.mock.calls[1][1];
    expect(JSON.parse(post.body.targeting)).toEqual({ geo_locations: { countries: ['US'] }, facebook_positions: ['feed'] });
  });
});

describe('creatives (BUG-24, BUG-28, BUG-33)', () => {
  it('creates a new creative for story updates', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce({
      data: { name: 'Orig', account_id: '42', object_story_spec: { page_id: 'p', link_data: { link: 'https://x' } } }, status: 200,
    });
    await run(registerCreativeCommands, client, ['creatives', 'update', '555', '--headline', 'New', '--ad-id', '777']);
    const [endpoint, opts] = client.request.mock.calls[1];
    expect(endpoint).toBe('act_42/adcreatives');
    expect(JSON.parse(opts.body.object_story_spec).link_data).toEqual({ link: 'https://x', name: 'New' });
    expect(client.request.mock.calls[2]).toEqual(['777', { method: 'POST', body: { creative: JSON.stringify({ creative_id: '999' }) } }]);
  });

  it('name-only update still posts to the creative', async () => {
    const client = makeClient();
    await run(registerCreativeCommands, client, ['creatives', 'update', '555', '--name', 'N']);
    expect(client.request.mock.calls[0]).toEqual(['555', { method: 'POST', body: { name: 'N' } }]);
  });

  it('upload-video --file passes title and description', async () => {
    const client = makeClient();
    await run(registerCreativeCommands, client, ['creatives', 'upload-video', '--account-id', 'act_1', '--file', 'v.mp4', '--title', 'T', '--description', 'D']);
    expect(client.uploadFile).toHaveBeenCalledWith('act_1/advideos', 'v.mp4', { title: 'T', description: 'D' });
  });

  it('save-image fails on a non-OK download', async () => {
    const client = makeClient();
    client.request
      .mockResolvedValueOnce({ data: { creative: { id: 'c1' } }, status: 200 })
      .mockResolvedValueOnce({ data: { image_url: 'https://img' }, status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(run(registerCreativeCommands, client, ['creatives', 'save-image', '1', '--output-path', '/nonexistent/x.jpg']))
      .rejects.toThrow('exit 1');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Image download failed (404'));
  });
});

describe('duplicate (BUG-26)', () => {
  it('sends rename_options with the suffix', async () => {
    const client = makeClient();
    await run(registerDuplicationCommands, client, ['duplicate', 'campaign', '1', '--name-suffix', ' v2']);
    expect(client.request).toHaveBeenCalledTimes(1);
    const body = client.request.mock.calls[0][1].body;
    expect(JSON.parse(body.rename_options)).toEqual({ rename_strategy: 'ONLY_TOP_LEVEL_RENAME', rename_suffix: ' v2' });
  });

  it('creative dup uses --account-id', async () => {
    const client = makeClient();
    client.request.mockResolvedValueOnce({ data: { name: 'C' }, status: 200 });
    await run(registerDuplicationCommands, client, ['duplicate', 'creative', '1', '--account-id', 'act_9']);
    expect(client.request.mock.calls[1][0]).toBe('act_9/adcreatives');
  });
});

describe('lookalike countries (BUG-35)', () => {
  it('keeps single-country form', async () => {
    const client = makeClient();
    await run(registerAudienceCommands, client, ['audiences', 'create-lookalike', '--account-id', 'act_1', '--source-audience-id', '5', '--countries', 'US']);
    const spec = JSON.parse(client.request.mock.calls[0][1].body.lookalike_spec);
    expect(spec.country).toBe('US');
  });

  it('uses location_spec for several countries', async () => {
    const client = makeClient();
    await run(registerAudienceCommands, client, ['audiences', 'create-lookalike', '--account-id', 'act_1', '--source-audience-id', '5', '--countries', 'US,GB']);
    const spec = JSON.parse(client.request.mock.calls[0][1].body.lookalike_spec);
    expect(spec.country).toBeUndefined();
    expect(spec.location_spec).toEqual({ geo_locations: { countries: ['US', 'GB'] } });
  });
});

describe('catalog custom labels (BUG-25)', () => {
  it('sends custom_label_0/1', async () => {
    const client = makeClient();
    await run(registerCatalogCommands, client, ['catalog', 'create-product', '--catalog-id', '1', '--retailer-id', 'sku', '--name', 'n',
      '--price', '1000 JPY', '--url', 'https://u', '--image-url', 'https://i', '--custom-label-0', 'foo', '--custom-label-1', 'bar']);
    const body = client.request.mock.calls[0][1].body;
    expect(body).toMatchObject({ custom_label_0: 'foo', custom_label_1: 'bar', price: '1000', currency: 'JPY' });
  });
});
