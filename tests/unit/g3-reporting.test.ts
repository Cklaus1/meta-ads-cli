import { describe, it, expect } from 'vitest';
import {
  registerInsightCommands, buildInsightParams, previousPeriod, parseSort, parseTimeIncrement, parseFiltering,
  timeParams, joinPreviousPeriod, addDerivedColumns, toMmmRows, attributionGroups,
} from '../../src/commands/insights.js';
import { registerAnalyticsCommands, aggregate, assessFatigue, daysToPreset } from '../../src/commands/analytics.js';
import { registerAiCommands, scoreAgainstPeers, percentileRank } from '../../src/commands/ai.js';
import { curveRows } from '../../src/commands/reach-frequency.js';
import { mockClient, run } from './command-helpers.js';

const purchases = (n: number) => [
  { action_type: 'purchase', value: String(n) },
  { action_type: 'omni_purchase', value: String(n) },
];

describe('insights params', () => {
  it('sends named ranges as date_preset and dates as time_range', () => {
    expect(timeParams('last_14d')).toEqual({ date_preset: 'last_14d' });
    expect(timeParams('last_7d', '2026-10-01', '2026-10-07')).toEqual({ time_range: '{"since":"2026-10-01","until":"2026-10-07"}' });
    expect(() => timeParams('lastweek')).toThrow('Unknown time range');
  });

  it('defaults account objects to campaign level and adds level IDs, link clicks and revenue', () => {
    const p = buildInsightParams('act_1', { timeRange: 'last_7d' });
    expect(p.level).toBe('campaign');
    expect(p.fields).toContain('campaign_id');
    expect(p.fields).toContain('inline_link_clicks');
    expect(p.fields).toContain('action_values');
    expect(p.fields).toContain('attribution_setting');
    expect(buildInsightParams('123', { timeRange: 'last_7d' }).level).toBeUndefined();
  });

  it('validates time increment, sort, filtering and action breakdowns', () => {
    expect(parseTimeIncrement('7')).toBe('7');
    expect(parseTimeIncrement('monthly')).toBe('monthly');
    expect(() => parseTimeIncrement('0')).toThrow('--time-increment');
    expect(parseSort('spend_descending')).toBe('["spend_descending"]');
    expect(() => parseSort('spend')).toThrow('--sort');
    expect(JSON.parse(parseFiltering('{"field":"campaign.name","operator":"CONTAIN","value":"P"}'))).toHaveLength(1);
    expect(() => parseFiltering('[{"field":"x"}]')).toThrow('field, operator and value');
    const p = buildInsightParams('act_1', { timeRange: 'last_7d', actionBreakdowns: 'action_type,action_device', fields: 'spend' });
    expect(p.action_breakdowns).toBe('["action_type","action_device"]');
    expect(p.fields).toContain('actions');
    expect(() => buildInsightParams('act_1', { timeRange: 'last_7d', comparePrevious: true, timeIncrement: '1' })).toThrow('--compare-previous');
  });

  it('computes the previous period of the same length', () => {
    expect(previousPeriod('2026-10-20', '2026-10-26')).toEqual({ since: '2026-10-13', until: '2026-10-19' });
  });
});

describe('derived columns and comparison', () => {
  it('derives results from each row\'s objective without double counting', () => {
    const [row] = addDerivedColumns([{ objective: 'OUTCOME_SALES', spend: '100', impressions: '1000', actions: purchases(4), action_values: [{ action_type: 'omni_purchase', value: '300' }] }]);
    expect(row).toMatchObject({ result_event: 'purchase', results: 4, cost_per_result: 25, revenue: 300, roas: 3, aov: 75 });
  });

  it('joins previous-period rows and computes % change', () => {
    const rows = joinPreviousPeriod(
      [{ campaign_id: '1', spend: 120, results: 6 }],
      [{ campaign_id: '1', spend: 100, results: 4 }],
      ['campaign_id'],
    );
    expect(rows[0]).toMatchObject({ spend_prev: 100, spend_change_pct: 20, results_prev: 4, results_change_pct: 50 });
  });

  it('insights get --compare-previous queries the prior window', async () => {
    const { client, request } = mockClient(async (_e, opts) => {
      const prev = opts?.params?.time_range;
      return {
        data: { data: [{ campaign_id: '1', objective: 'OUTCOME_SALES', spend: prev ? '100' : '150', impressions: '1000', actions: purchases(prev ? 5 : 5), date_start: '2026-10-20', date_stop: '2026-10-26' }] },
        status: 200,
      };
    });
    const { stdout } = await run(registerInsightCommands, client, ['insights', 'get', 'act_1', '--time-range', 'last_7d', '--compare-previous']);
    const out = JSON.parse(stdout);
    expect(request.mock.calls[1][1]?.params?.time_range).toBe('{"since":"2026-10-13","until":"2026-10-19"}');
    expect(request.mock.calls[1][1]?.params?.date_preset).toBeUndefined();
    expect(out.data[0]).toMatchObject({ spend_change_pct: 50, cost_per_result_prev: 20, cost_per_result_change_pct: 50 });
  });
});

describe('MMM export and attribution audit', () => {
  it('builds long-format rows with currency and timezone', () => {
    const [row] = toMmmRows([{ date_start: '2026-10-01', campaign_id: '1', campaign_name: 'C', country: 'US', spend: '10', impressions: '100', reach: '80', inline_link_clicks: '5', actions: purchases(1), action_values: [{ action_type: 'omni_purchase', value: '40' }] }], 'purchase', 'USD', 'America/New_York');
    expect(row).toMatchObject({ date: '2026-10-01', country: 'US', spend: 10, results: 1, revenue: 40, currency: 'USD', timezone: 'America/New_York' });
  });

  it('export-mmm runs an async report at campaign × country daily', async () => {
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1') return { data: { currency: 'EUR', timezone_name: 'Europe/Berlin' }, status: 200 };
      if (opts?.method === 'POST') return { data: { report_run_id: '99' }, status: 200 };
      if (endpoint === '99') return { data: { async_status: 'Job Completed' }, status: 200 };
      return { data: { data: [{ date_start: '2026-10-01', campaign_id: '1', country: 'DE', spend: '5', impressions: '50' }] }, status: 200 };
    });
    const { stdout } = await run(registerInsightCommands, client, ['insights', 'export-mmm', '--account-id', 'act_1', '-o', 'json']);
    const post = request.mock.calls.find(([, o]) => o?.method === 'POST')?.[1]?.body;
    expect(post).toMatchObject({ level: 'campaign', breakdowns: 'country', time_increment: '1', date_preset: 'last_90d' });
    expect(JSON.parse(stdout)[0]).toMatchObject({ country: 'DE', currency: 'EUR', timezone: 'Europe/Berlin' });
  });

  it('groups ad sets by attribution window', () => {
    const groups = attributionGroups([
      { name: 'a', attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }] },
      { name: 'b', attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 1 }] },
    ]);
    expect(groups.map(g => g.attribution).sort()).toEqual(['1d_click', '1d_view+7d_click']);
  });
});

describe('analytics', () => {
  const day = (i: number, o: Partial<Record<string, unknown>> = {}) => ({
    date_start: `2026-10-${String(i).padStart(2, '0')}`, date_stop: `2026-10-${String(i).padStart(2, '0')}`,
    impressions: '1000', reach: '900', spend: '10', inline_link_clicks: '20', objective: 'OUTCOME_SALES', actions: purchases(1), ...o,
  });

  it('aggregates windows from sums, not averaged ratios', () => {
    const t = aggregate([day(1, { impressions: '100', inline_link_clicks: '10' }), day(2, { impressions: '900', inline_link_clicks: '10' })], 'purchase');
    expect(t.link_ctr).toBe(2); // 20 / 1000, not mean(10%, 1.1%)
    expect(t.cost_per_result).toBe(10);
  });

  it('flags fatigue on a link CTR drop with high lifetime frequency, and needs volume', () => {
    const daily = [...Array.from({ length: 7 }, (_, i) => day(i + 1)), ...Array.from({ length: 7 }, (_, i) => day(i + 8, { inline_link_clicks: '10' }))];
    const o = { ctrDrop: 20, cprRise: 25, maxFrequency: 4, minImpressions: 1000, minResults: 5 };
    expect(assessFatigue(daily, { impressions: '50000', reach: '10000' }, 'purchase', o).status).toBe('fatigued');
    expect(assessFatigue(daily, { impressions: '20000', reach: '10000' }, 'purchase', o).status).toBe('declining');
    expect(assessFatigue(daily.slice(0, 10), undefined, 'purchase', o).status).toBe('insufficient_data');
  });

  it('maps --days to a Meta preset', () => {
    expect(daysToPreset('14')).toBe('last_14d');
    expect(() => daysToPreset('10')).toThrow('--days');
  });

  it('analytics report honours --time-range and adds derived columns', async () => {
    const { client, requestAllPages } = mockClient(async () => ({ data: { data: [{ campaign_id: '1', objective: 'OUTCOME_SALES', spend: '50', actions: purchases(2) }] }, status: 200 }));
    const { stdout } = await run(registerAnalyticsCommands, client, ['analytics', 'report', '--account-id', 'act_1', '--time-range', 'last_7d']);
    expect(requestAllPages.mock.calls[0][1]?.params).toMatchObject({ date_preset: 'last_7d', level: 'campaign' });
    expect(JSON.parse(stdout).data[0]).toMatchObject({ results: 2, cost_per_result: 25 });
  });
});

describe('ai scoring', () => {
  const m = (cpr: number | null, results: number, extra: Record<string, unknown> = {}) => ({
    result_event: 'purchase', spend: 100, impressions: 10000, reach: 5000, clicks: 100, results, cost_per_result: cpr,
    revenue: 0, roas: null, ctr: 1, cpc: 1, cpm: 10, frequency: 2, link_ctr: 1, ...extra,
  });

  it('ranks against peers on cost per result, not CTR/CPC', () => {
    expect(percentileRank(10, [20, 30, 40], true)).toBe(100);
    const peers = [m(20, 10), m(30, 10), m(40, 10)];
    const good = scoreAgainstPeers(m(10, 10, { link_ctr: 0.2, ctr: 0.2 }), peers);
    const bad = scoreAgainstPeers(m(50, 10, { link_ctr: 5, ctr: 5 }), peers);
    expect(good.overall_score!).toBeGreaterThan(bad.overall_score!);
  });

  it('returns no score without enough results', () => {
    const s = scoreAgainstPeers(m(5, 1), [m(20, 10), m(30, 10), m(40, 10)]);
    expect(s.overall_score).toBeNull();
    expect(s.components.cost_per_result.note).toBe('not enough volume');
  });

  it('heuristic recommendations are relative and never push cost caps', async () => {
    const campaigns = Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), name: `c${i + 1}`, objective: 'OUTCOME_SALES', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }));
    const insights = campaigns.map((c, i) => ({ campaign_id: c.id, spend: String(100 * (i === 3 ? 4 : 1)), impressions: '10000', reach: '5000', inline_link_clicks: '100', actions: purchases(10) }));
    const { client } = mockClient(async (endpoint) => {
      if (endpoint.endsWith('/campaigns')) return { data: { data: campaigns }, status: 200 };
      if (endpoint.endsWith('/adsets')) return { data: { data: [{ campaign_id: '2', learning_stage_info: { status: 'FAIL' } }] }, status: 200 };
      return { data: { data: insights }, status: 200 };
    });
    const { stdout } = await run(registerAiCommands, client, ['ai', 'recommendations', '--account-id', 'act_1', '--no-llm']);
    const out = JSON.parse(stdout);
    const text = JSON.stringify(out.recommendations);
    expect(text).not.toContain('COST_CAP');
    expect(out.recommendations.find((r: { campaign: string }) => r.campaign === 'c4').recommendations[0]).toContain("worst quarter");
    expect(out.recommendations.find((r: { campaign: string }) => r.campaign === 'c2').recommendations.join(' ')).toContain('learning-limited');
  });
});

describe('reach & frequency curve', () => {
  it('zips parallel arrays into rows with frequency', () => {
    expect(curveRows({ budget: [1000, 2000], reach: [100, 150], impression: [200, 450] })).toEqual([
      { budget: 1000, reach: 100, impressions: 200, frequency: 2 },
      { budget: 2000, reach: 150, impressions: 450, frequency: 3 },
    ]);
    expect(curveRows(undefined)).toEqual([]);
  });
});
