import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerCreativeCommands, buildDegreesOfFreedom, buildAssetFeedSpec } from '../../src/commands/creatives.js';
import { registerAccountCommands, assessAccountHealth, rollupAccounts } from '../../src/commands/accounts.js';
import { registerCatalogCommands, summarizeProductPerformance } from '../../src/commands/catalog.js';
import { registerBrandedContentCommands } from '../../src/commands/branded-content.js';
import { mockClient, run } from './command-helpers.js';

describe('creative enhancements', () => {
  it('builds per-feature opt in/out', () => {
    expect(JSON.parse(buildDegreesOfFreedom('image_touchups,image_animation', 'music_generation')!)).toEqual({
      creative_features_spec: {
        image_touchups: { enroll_status: 'OPT_IN' },
        image_animation: { enroll_status: 'OPT_IN' },
        music_generation: { enroll_status: 'OPT_OUT' },
      },
    });
    expect(buildDegreesOfFreedom()).toBeUndefined();
  });

  it('rejects the retired bundle and contradictions', () => {
    expect(() => buildDegreesOfFreedom('standard_enhancements')).toThrow('retired');
    expect(() => buildDegreesOfFreedom('text_optimizations', 'text_optimizations')).toThrow('both');
  });

  it('create-image sends degrees_of_freedom_spec', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'c1' }, status: 200 }));
    await run(registerCreativeCommands, client, ['creatives', 'create-image', '--account-id', 'act_1', '--image-hash', 'h', '--enhancements', 'text_optimizations']);
    expect(JSON.parse(request.mock.calls[0][1]!.body!.degrees_of_freedom_spec).creative_features_spec.text_optimizations.enroll_status).toBe('OPT_IN');
  });
});

describe('dynamic creative', () => {
  it('builds asset_feed_spec and picks the ad format', () => {
    const spec = buildAssetFeedSpec({ imageHashes: ['a', 'b'], bodies: ['x', 'y'], titles: ['t'], linkUrls: ['https://s'], ctas: ['shop_now'] });
    expect(spec).toEqual({
      ad_formats: ['SINGLE_IMAGE'],
      link_urls: [{ website_url: 'https://s' }],
      images: [{ hash: 'a' }, { hash: 'b' }],
      bodies: [{ text: 'x' }, { text: 'y' }],
      titles: [{ text: 't' }],
      call_to_action_types: ['SHOP_NOW'],
    });
    expect(buildAssetFeedSpec({ imageHashes: ['a'], videoIds: ['v'], linkUrls: ['https://s'] }).ad_formats).toEqual(['AUTOMATIC_FORMAT']);
  });

  it('validates inputs', () => {
    expect(() => buildAssetFeedSpec({ linkUrls: ['https://s'] })).toThrow('--image-hash or --video-id');
    expect(() => buildAssetFeedSpec({ imageHashes: ['a'] })).toThrow('--link-url');
    expect(() => buildAssetFeedSpec({ imageHashes: ['a'], videoIds: ['v'], linkUrls: ['u'], adFormat: 'SINGLE_IMAGE' })).toThrow('AUTOMATIC_FORMAT');
    expect(() => buildAssetFeedSpec({ imageHashes: ['a'], linkUrls: ['u'], customizationRules: [{}] })).toThrow('at least two rules');
  });

  it('create-dynamic posts asset_feed_spec with repeatable flags', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'c1' }, status: 200 }));
    await run(registerCreativeCommands, client, [
      'creatives', 'create-dynamic', '--account-id', 'act_1', '--page-id', 'p',
      '--image-hash', 'a', '--image-hash', 'b', '--body', 'one', '--body', 'two', '--link-url', 'https://s',
    ]);
    const body = request.mock.calls[0][1]!.body!;
    expect(JSON.parse(body.asset_feed_spec).bodies).toHaveLength(2);
    expect(JSON.parse(body.object_story_spec)).toEqual({ page_id: 'p' });
  });
});

describe('creatives from posts, previews, assets', () => {
  it('create-from-post uses object_story_id', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'c1' }, status: 200 }));
    await run(registerCreativeCommands, client, ['creatives', 'create-from-post', '--account-id', 'act_1', '--post-id', '1_2']);
    expect(request.mock.calls[0][1]!.body).toEqual({ object_story_id: '1_2' });
    await expect(run(registerCreativeCommands, client, ['creatives', 'create-from-post', '--account-id', 'act_1', '--instagram-media-id', '9']))
      .rejects.toThrow('--instagram-user-id');
  });

  it('preview fetches each format', async () => {
    const { client, request } = mockClient(async (_e, o) => ({ data: { data: [{ body: `<iframe ${o?.params?.ad_format}>` }] }, status: 200 }));
    const { stdout } = await run(registerCreativeCommands, client, ['creatives', 'preview', 'c1', '--format', 'mobile_feed_standard,INSTAGRAM_STORY']);
    expect(request.mock.calls.map(c => c[0])).toEqual(['c1/previews', 'c1/previews']);
    expect(JSON.parse(stdout).map((p: { format: string }) => p.format)).toEqual(['MOBILE_FEED_STANDARD', 'INSTAGRAM_STORY']);
  });

  it('bulk-create uploads images from a folder and creates one creative each', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-bulk-'));
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'b.png'), 'y');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'z');
    const { client, request } = mockClient(async (endpoint, o) => {
      if (endpoint.endsWith('/adimages')) return { data: { images: { [o!.body!.name]: { hash: `h-${o!.body!.name}` } } }, status: 200 };
      return { data: { id: `c-${JSON.parse(o!.body!.object_story_spec).link_data.image_hash}` }, status: 200 };
    });
    const { stdout } = await run(registerCreativeCommands, client, [
      'creatives', 'bulk-create', '--account-id', 'act_1', '--folder', dir, '--page-id', 'p', '--link-url', 'https://s',
    ]);
    const out = JSON.parse(stdout);
    expect(out.created.map((c: { creative_id: string }) => c.creative_id)).toEqual(['c-h-a.jpg', 'c-h-b.png']);
    expect(out.failed).toEqual([]);
    expect(request.mock.calls.filter(([e]) => e === 'act_1/adimages')).toHaveLength(2);
  });
});

describe('accounts', () => {
  it('flags blockers and warnings', () => {
    const issues = assessAccountHealth(
      { account_status: 3, disable_reason: 3, spend_cap: '10000', amount_spent: '9500', funding_source: '1' },
      { adsRunning: 250, adsLimit: 250, disapprovedAds: 2 },
    );
    const text = issues.map(i => `${i.severity}:${i.issue}`).join('\n');
    expect(text).toContain('blocker:Account status is UNSETTLED (disable reason: RISK_PAYMENT)');
    expect(text).toContain('warning:Account spend cap 95% used');
    expect(text).toContain('blocker:250 ads running');
    expect(text).toContain('warning:2 ad(s) disapproved');
    expect(assessAccountHealth({ account_status: 1, funding_source: '1' })).toEqual([]);
    expect(assessAccountHealth({ account_status: 1 })[0].issue).toContain('No payment method');
  });

  it('set-spend-cap validates and sends standard currency units (B2-07)', async () => {
    const { client, request } = mockClient(async (_e, o) => ({ data: o?.method === 'POST' ? { success: true } : { currency: 'USD' }, status: 200 }));
    await run(registerAccountCommands, client, ['accounts', 'set-spend-cap', '123', '--cents', '500000']);
    const posts = () => request.mock.calls.filter(c => c[1]?.method === 'POST');
    expect(posts()[0]).toEqual(['act_123', { method: 'POST', body: { spend_cap: '5000' } }]);
    await run(registerAccountCommands, client, ['accounts', 'set-spend-cap', 'act_123', '--remove']);
    expect(posts()[1][1]!.body).toEqual({ spend_cap_action: 'delete' });
    await expect(run(registerAccountCommands, client, ['accounts', 'set-spend-cap', '123', '--cents', '50.5'])).rejects.toThrow('whole number');
    await expect(run(registerAccountCommands, client, ['accounts', 'set-spend-cap', '123'])).rejects.toThrow('exactly one');
  });

  it('rollup sums matching currencies and refuses to mix', () => {
    const same = rollupAccounts([
      { currency: 'USD', spend: 100, impressions: 10, clicks: 1, results: 4, revenue: 400 },
      { currency: 'USD', spend: 100, impressions: 10, clicks: 1, results: 6, revenue: 200 },
    ]);
    expect(same.totals).toMatchObject({ spend: 200, results: 10, cost_per_result: 20, revenue: 600, roas: 3 });
    expect(rollupAccounts([{ currency: 'USD', spend: 1 }, { currency: 'EUR', spend: 1 }]).totals).toBeNull();
  });

  it('rollup command queries each account', async () => {
    const { client, request } = mockClient(async (endpoint) => (endpoint.endsWith('/insights')
      ? { data: { data: [{ spend: '50', actions: [{ action_type: 'purchase', value: '5' }] }] }, status: 200 }
      : { data: { name: endpoint, currency: 'USD' }, status: 200 }));
    const { stdout } = await run(registerAccountCommands, client, ['accounts', 'rollup', '--accounts', '1,act_2']);
    expect(request.mock.calls.map(c => c[0]).sort()).toEqual(['act_1', 'act_1/insights', 'act_2', 'act_2/insights']);
    expect(JSON.parse(stdout).totals).toMatchObject({ spend: 100, results: 10 });
  });
});

describe('catalog', () => {
  it('joins product insights to catalog products', () => {
    const rows = [
      { product_id: 'SKU1, Red shoe', spend: '30', actions: [{ action_type: 'purchase', value: '3' }], action_values: [{ action_type: 'purchase', value: '90' }] },
      { product_id: 'SKU1, Red shoe', spend: '20', actions: [{ action_type: 'purchase', value: '1' }] },
      { product_id: 'SKU2', spend: '60' },
    ];
    const out = summarizeProductPerformance(rows, [{ id: '9', retailer_id: 'SKU1', name: 'Red shoe' }], 'purchase');
    expect(out[0]).toMatchObject({ product_id: 'SKU2', spend: 60, results: 0, cost_per_result: null });
    expect(out[1]).toMatchObject({ product_id: 'SKU1', name: 'Red shoe', spend: 50, results: 4, cost_per_result: 12.5, revenue: 90, roas: 1.8 });
  });

  it('collection-ad links the cover to the Instant Experience', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'x' }, status: 200 }));
    await run(registerCatalogCommands, client, [
      'catalog', 'collection-ad', '--account-id', 'act_1', '--adset-id', '5', '--page-id', 'p', '--canvas-id', '42', '--image-hash', 'h',
    ]);
    const spec = JSON.parse(request.mock.calls[0][1]!.body!.object_story_spec);
    expect(spec.link_data).toMatchObject({ link: 'https://fb.com/canvas_doc/42', image_hash: 'h' });
  });

  it('diagnostics passes filters as JSON lists', async () => {
    const { client, request } = mockClient(async () => ({ data: { data: [] }, status: 200 }));
    await run(registerCatalogCommands, client, ['catalog', 'diagnostics', '9', '--severities', 'must_fix', '--types', 'EVENT_SOURCE_ISSUES']);
    expect(request.mock.calls[0]).toEqual(['9/diagnostics', { params: { severities: '["MUST_FIX"]', types: '["EVENT_SOURCE_ISSUES"]' } }]);
  });
});

describe('branded content', () => {
  it('filters permissions by creator username', async () => {
    const { client, request } = mockClient(async () => ({ data: { data: [{ username: 'alice' }, { username: 'bob' }] }, status: 200 }));
    const { stdout } = await run(registerBrandedContentCommands, client, ['branded-content', 'eligible-sponsors', '1', '--creator-username', '@Alice']);
    expect(request.mock.calls[0][1]!.params!.creator_username).toBe('Alice');
    expect(JSON.parse(stdout).data).toEqual([{ username: 'alice' }]);
  });
});

vi.restoreAllMocks();
