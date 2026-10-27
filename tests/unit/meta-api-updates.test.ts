import { describe, it, expect } from 'vitest';
import { mockClient, run } from './command-helpers.js';
import { registerAdSetCommands, assertNoRemovedPlacements } from '../../src/commands/adsets.js';
import { registerInsightCommands, validateBreakdowns, parseAttributionWindows } from '../../src/commands/insights.js';
import { registerCreativeCommands } from '../../src/commands/creatives.js';
import { registerConversionCommands, toPhysicalStoreEvents } from '../../src/commands/conversions.js';
import { registerWhatsAppCommands, validateAnalyticsRange, fieldExpansion } from '../../src/commands/whatsapp.js';
import { registerBiddingCommands, OPTIMIZATION_GOALS } from '../../src/commands/bidding.js';

const ok = async () => ({ data: { id: '1' }, status: 200 });

describe('removed placements (#7)', () => {
  it.each([
    ['facebook_positions', 'video_feeds'],
    ['instagram_positions', 'explore'],
    ['messenger_positions', 'story'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => assertNoRemovedPlacements({ [key]: [value] })).toThrow('no longer supported');
  });

  it('keeps explore_home and sponsored_messages', () => {
    expect(() => assertNoRemovedPlacements({ instagram_positions: ['explore_home'], messenger_positions: ['sponsored_messages'] })).not.toThrow();
  });

  it('blocks removed placements on adsets create before sending', async () => {
    const { client, request } = mockClient(ok);
    await expect(run(registerAdSetCommands, client, ['adsets', 'create', '--account-id', 'act_1', '--campaign-id', '2', '--name', 'n',
      '--optimization-goal', 'REACH', '--billing-event', 'IMPRESSIONS', '--instagram-positions', 'stream,explore'])).rejects.toThrow('Explore');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Advantage+ audience for HEC-F ad sets (#8)', () => {
  const createArgs = ['adsets', 'create', '--account-id', 'act_1', '--campaign-id', '2', '--name', 'n',
    '--optimization-goal', 'REACH', '--billing-event', 'IMPRESSIONS',
    '--targeting', JSON.stringify({ geo_locations: { countries: ['US'] }, custom_audiences: [{ id: '9' }] })];

  it('requires the flag when the campaign has special ad categories', async () => {
    const { client, request } = mockClient(async (endpoint) => (
      endpoint === '2' ? { data: { special_ad_categories: ['HOUSING'] }, status: 200 } : { data: { id: '1' }, status: 200 }
    ));
    await expect(run(registerAdSetCommands, client, createArgs)).rejects.toThrow('--advantage-audience');
    expect(request.mock.calls.some(([e]) => e === 'act_1/adsets')).toBe(false);
  });

  it('puts advantage_audience inside targeting.targeting_automation', async () => {
    const { client, request } = mockClient(ok);
    await run(registerAdSetCommands, client, [...createArgs, '--advantage-audience', '0']);
    const body = request.mock.calls.find(([e]) => e === 'act_1/adsets')![1]!.body!;
    expect(JSON.parse(body.targeting).targeting_automation).toEqual({ advantage_audience: 0 });
    expect(body.targeting_automation).toBeUndefined();
  });

  it('does not check non-HEC-F campaigns beyond one lookup', async () => {
    const { client, request } = mockClient(async (endpoint) => (
      endpoint === '2' ? { data: { special_ad_categories: [] }, status: 200 } : { data: { id: '1' }, status: 200 }
    ));
    await run(registerAdSetCommands, client, createArgs);
    expect(request.mock.calls.some(([e]) => e === 'act_1/adsets')).toBe(true);
  });

  it('merges --advantage-audience into current targeting on update', async () => {
    const { client, request } = mockClient(async (endpoint, opts) => (
      endpoint === '5' && !opts?.method ? { data: { targeting: { geo_locations: { countries: ['US'] } } }, status: 200 } : { data: { success: true }, status: 200 }
    ));
    await run(registerAdSetCommands, client, ['adsets', 'update', '5', '--advantage-audience', '1']);
    const body = request.mock.calls.find(([, o]) => o?.method === 'POST')![1]!.body!;
    expect(JSON.parse(body.targeting)).toEqual({ geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 1 } });
  });
});

describe('insights (#10, #11, #30)', () => {
  it('rejects renamed breakdowns with a hint', () => {
    expect(() => validateBreakdowns('age,dma')).toThrow('comscore_market');
    expect(() => validateBreakdowns('device')).toThrow('device_platform');
    expect(validateBreakdowns('age, publisher_platform')).toBe('age,publisher_platform');
  });

  it('validates attribution windows', () => {
    expect(parseAttributionWindows('7d_click,1d_view')).toBe('["7d_click","1d_view"]');
    expect(() => parseAttributionWindows('28d_view')).toThrow('no longer supported');
    expect(() => parseAttributionWindows('3d_click')).toThrow('Unknown attribution window');
  });

  it('runs an async report, polls, and prints results', async () => {
    let polls = 0;
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/insights') return { data: { report_run_id: 'r1' }, status: 200 };
      if (endpoint === 'r1') {
        polls++;
        return { data: { async_status: polls < 2 ? 'Job Running' : 'Job Completed', async_percent_completion: polls < 2 ? 50 : 100 }, status: 200 };
      }
      if (endpoint === 'r1/insights') return { data: { data: [{ spend: '1.00' }] }, status: 200 };
      throw new Error(`unexpected ${endpoint} ${JSON.stringify(opts)}`);
    });
    const { stdout } = await run(registerInsightCommands, client, ['insights', 'async', 'act_1', '--poll-interval', '0', '--attribution-windows', '7d_click']);
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', body: { action_attribution_windows: '["7d_click"]' } });
    expect(polls).toBe(2);
    expect(stdout).toContain('1.00');
  });

  it('surfaces async job failures', async () => {
    const { client } = mockClient(async (endpoint) => (
      endpoint === 'act_1/insights' ? { data: { report_run_id: 'r1' }, status: 200 }
        : { data: { async_status: 'Job Failed', error_user_msg: 'Too much data' }, status: 200 }
    ));
    await expect(run(registerInsightCommands, client, ['insights', 'async', 'act_1', '--poll-interval', '0'])).rejects.toThrow('Too much data');
  });
});

describe('shop destination (#15)', () => {
  it('opt-out sets destination_spec', async () => {
    const { client, request } = mockClient(ok);
    await run(registerCreativeCommands, client, ['creatives', 'create-image', '--account-id', 'act_1', '--image-hash', 'h', '--shop-destination', 'opt-out']);
    expect(JSON.parse(request.mock.calls[0][1]!.body!.destination_spec)).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' });
  });

  it('default sends nothing', async () => {
    const { client, request } = mockClient(ok);
    await run(registerCreativeCommands, client, ['creatives', 'create-image', '--account-id', 'act_1', '--image-hash', 'h']);
    expect(request.mock.calls[0][1]!.body!.destination_spec).toBeUndefined();
  });
});

describe('offline conversions migration (#18)', () => {
  it('converts legacy events to physical_store CAPI events', () => {
    const [e] = toPhysicalStoreEvents([{ event_name: 'Purchase', match_keys: { em: 'A@B.com' } }]);
    expect(e.action_source).toBe('physical_store');
    expect(e.match_keys).toBeUndefined();
    expect((e.user_data as Record<string, string>).em).toMatch(/^[0-9a-f]{64}$/);
  });

  it('offline-events sends to the dataset events edge', async () => {
    const { client, request } = mockClient(ok);
    await run(registerConversionCommands, client, ['conversions', 'offline-events', '--dataset-id', '77', '--events', '[{"event_name":"Purchase"}]']);
    expect(request.mock.calls[0][0]).toBe('77/events');
    expect(JSON.parse(request.mock.calls[0][1]!.body!.data)[0].action_source).toBe('physical_store');
  });

  it('create-offline-set explains the migration', async () => {
    const { client, request } = mockClient(ok);
    await expect(run(registerConversionCommands, client, ['conversions', 'create-offline-set', '--name', 'x'])).rejects.toThrow('datasets');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('WhatsApp pricing analytics (#20)', () => {
  it('builds the pricing_analytics field expansion', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { client, request } = mockClient(ok);
    await run(registerWhatsAppCommands, client, ['whatsapp', 'pricing-analytics', '5', '--start', String(now - 86400), '--end', String(now),
      '--country-codes', 'us,in']);
    expect(request.mock.calls[0]).toEqual(['5', { params: {
      fields: `pricing_analytics.start(${now - 86400}).end(${now}).granularity(DAILY).country_codes(US,IN).dimensions(PRICING_CATEGORY,PRICING_TYPE)`,
    } }]);
  });

  it('enforces the 1-year lookback', () => {
    const now = 2_000_000_000;
    expect(() => validateAnalyticsRange(String(now - 400 * 86400), String(now), now)).toThrow('1-year lookback');
    expect(() => validateAnalyticsRange(String(now - 10), String(now), now)).not.toThrow();
  });

  it('fieldExpansion skips empty args', () => {
    expect(fieldExpansion('analytics', { start: '1', end: '2', dimensions: [] })).toBe('analytics.start(1).end(2)');
  });
});

describe('optimization goals (#21)', () => {
  it('includes newer goals', () => {
    expect(OPTIMIZATION_GOALS).toEqual(expect.arrayContaining(['PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'THRUPLAY', 'QUALITY_LEAD']));
    expect(OPTIMIZATION_GOALS).not.toContain('CONVERSIONS');
  });

  it('bidding validate accepts PROFILE_VISIT and flags CONVERSIONS', async () => {
    const { client } = mockClient(ok);
    const okRun = await run(registerBiddingCommands, client, ['bidding', 'validate', '--bid-strategy', 'LOWEST_COST_WITHOUT_CAP',
      '--optimization-goal', 'PROFILE_VISIT', '--billing-event', 'IMPRESSIONS']);
    expect(JSON.parse(okRun.stdout).errors).toEqual([]);
    const bad = await run(registerBiddingCommands, client, ['bidding', 'validate', '--bid-strategy', 'LOWEST_COST_WITHOUT_CAP',
      '--optimization-goal', 'CONVERSIONS', '--billing-event', 'IMPRESSIONS']);
    expect(JSON.parse(bad.stdout).errors.join(' ')).toContain('OFFSITE_CONVERSIONS');
  });
});
