import { describe, it, expect } from 'vitest';
import {
  registerBiddingCommands, validateBidConfig, roasFloor, capChange, significantChangeWarning,
} from '../../src/commands/bidding.js';
import { mockClient, run } from './command-helpers.js';

const insights = (rows: unknown[]) => ({ data: { data: rows }, status: 200 });

describe('validateBidConfig (MEDIA_BUYER_GAPS #12, #13)', () => {
  it('checks objective ↔ goal, goal ↔ billing event and promoted object', () => {
    expect(validateBidConfig({ objective: 'OUTCOME_SALES', optimizationGoal: 'LEAD_GENERATION' }).errors.join(' '))
      .toContain('not a valid optimization goal for OUTCOME_SALES');
    expect(validateBidConfig({ optimizationGoal: 'REACH', billingEvent: 'LINK_CLICKS' }).errors.join(' '))
      .toContain('not allowed with REACH');
    expect(validateBidConfig({ optimizationGoal: 'THRUPLAY', billingEvent: 'THRUPLAY' }).errors).toEqual([]);
    expect(validateBidConfig({ objective: 'OUTCOME_SALES', optimizationGoal: 'OFFSITE_CONVERSIONS' }).errors.join(' '))
      .toContain('pixel_id + custom_event_type');
    expect(validateBidConfig({
      objective: 'OUTCOME_SALES', optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObject: { pixel_id: '1', custom_event_type: 'PURCHASE' },
    }).errors).toEqual([]);
  });

  it('rejects TARGET_COST and enforces bid amount / ROAS goal rules', () => {
    expect(validateBidConfig({ optimizationGoal: 'LINK_CLICKS', bidStrategy: 'TARGET_COST' }).errors.join(' ')).toContain('deprecated');
    expect(validateBidConfig({ optimizationGoal: 'LINK_CLICKS', bidStrategy: 'COST_CAP' }).errors.join(' ')).toContain('needs a bid amount');
    const roas = validateBidConfig({ optimizationGoal: 'OFFSITE_CONVERSIONS', bidStrategy: 'LOWEST_COST_WITH_MIN_ROAS', bidAmount: 100, promotedObject: { pixel_id: '1', custom_event_type: 'PURCHASE' } });
    expect(roas.errors.join(' ')).toMatch(/VALUE[\s\S]*ROAS goal[\s\S]*bid_amount/);
  });

  it('scales the ROAS floor by 10000 and checks the range', () => {
    expect(roasFloor(2.5)).toBe(25000);
    expect(() => roasFloor(0.001)).toThrow('between 0.01 and 1000');
  });

  it('caps changes and warns on significant edits', () => {
    expect(capChange(1000, 5000, 20)).toBe(1200);
    expect(capChange(1000, 100, 20)).toBe(800);
    expect(significantChangeWarning(1000, 1100)).toBeUndefined();
    expect(significantChangeWarning(1000, 2000, 'LEARNING')).toMatch(/100%[\s\S]*learning phase/);
  });

  it('validate command exits non-zero on errors and prints bid_constraints', async () => {
    const { client } = mockClient(async () => ({ data: {}, status: 200 }));
    const good = await run(registerBiddingCommands, client, ['bidding', 'validate', '--optimization-goal', 'VALUE',
      '--bid-strategy', 'LOWEST_COST_WITH_MIN_ROAS', '--target-roas', '1.5', '--promoted-object', '{"pixel_id":"1","custom_event_type":"PURCHASE"}']);
    expect(JSON.parse(good.stdout)).toMatchObject({ valid: true, bid_constraints: { roas_average_floor: 15000 } });
    const bad = await run(registerBiddingCommands, client, ['bidding', 'validate', '--optimization-goal', 'LINK_CLICKS', '--bid-strategy', 'TARGET_COST']);
    expect(bad.exitCode).toBe(1);
  });
});

describe('optimize-budget (MEDIA_BUYER_GAPS #1)', () => {
  const purchases = (n: number, value: number) => ({
    actions: [{ action_type: 'omni_purchase', value: String(n) }, { action_type: 'purchase', value: String(n) }, { action_type: 'link_click', value: '500' }],
    action_values: [{ action_type: 'omni_purchase', value: String(value) }],
  });

  it('ranks by ROAS, holds low-volume and learning campaigns, and caps the change', async () => {
    const { client } = mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/insights') {
        return insights([
          // Cheap clicks but poor ROAS.
          { campaign_id: 'c1', campaign_name: 'Clicky', spend: '100', impressions: '10000', inline_link_clicks: '900', ...purchases(10, 100) },
          // Expensive clicks, strong ROAS.
          { campaign_id: 'c2', campaign_name: 'Profitable', spend: '100', impressions: '10000', inline_link_clicks: '50', ...purchases(20, 600) },
          { campaign_id: 'c3', campaign_name: 'New', spend: '20', impressions: '1000', inline_link_clicks: '10', ...purchases(1, 50) },
          { campaign_id: 'c4', campaign_name: 'Learning', spend: '100', impressions: '10000', inline_link_clicks: '50', ...purchases(20, 500) },
        ]);
      }
      if (endpoint === 'act_1/campaigns') {
        return insights(['c1', 'c2', 'c3', 'c4'].map(id => ({ id, objective: 'OUTCOME_SALES', daily_budget: '10000', effective_status: 'ACTIVE' })));
      }
      if (endpoint === 'act_1/adsets') {
        return insights([{ id: 'a4', campaign_id: 'c4', effective_status: 'ACTIVE', learning_stage_info: { status: 'LEARNING' } }]);
      }
      void opts;
      return { data: {}, status: 200 };
    });
    const out = JSON.parse((await run(registerBiddingCommands, client, ['bidding', 'optimize-budget', '--account-id', 'act_1'])).stdout);
    expect(out.ranked_by).toBe('roas');
    const byId = Object.fromEntries(out.campaigns.map((c: Record<string, unknown>) => [c.campaign_id, c]));
    expect(byId.c2).toMatchObject({ action: 'INCREASE', proposed_daily_budget: 12000, results: 20, roas: 6 });
    expect(byId.c1).toMatchObject({ action: 'DECREASE', proposed_daily_budget: 8000, results: 10 });
    expect(byId.c3.action).toBe('HOLD');
    expect(byId.c4.action).toBe('HOLD');
    expect(byId.c4.reasons.join(' ')).toContain('learning');
  });
});

describe('learning-phase (MEDIA_BUYER_GAPS #7)', () => {
  it('reads learning_stage_info and flags learning-limited ad sets', async () => {
    const { client, request } = mockClient(async () => ({
      data: { id: 'a1', name: 'A', learning_stage_info: { status: 'FAIL', conversions: 3 } }, status: 200,
    }));
    const out = JSON.parse((await run(registerBiddingCommands, client, ['bidding', 'learning-phase', 'a1'])).stdout);
    expect(request.mock.calls[0][1]?.params?.fields).toContain('learning_stage_info');
    expect(out.summary.learning_limited).toBe(1);
    expect(out.adsets[0].notes[0]).toContain('Learning limited');
  });
});

describe('cpm-benchmark (MEDIA_BUYER_GAPS #38)', () => {
  it('keeps the competitor-analysis alias and compares with the account baseline', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint === 'c1') return { data: { id: 'c1', name: 'C', account_id: '9' }, status: 200 };
      if (endpoint === 'c1/insights') return insights([{ publisher_platform: 'facebook', cpm: '20', impressions: '1000' }]);
      if (endpoint === 'act_9/insights') return insights([{ publisher_platform: 'facebook', cpm: '10', impressions: '99999' }]);
      return { data: {}, status: 200 };
    });
    const out = JSON.parse((await run(registerBiddingCommands, client, ['bidding', 'competitor-analysis', 'c1'])).stdout);
    expect(out.cpm_by_platform[0]).toMatchObject({ cpm: 20, account_baseline_cpm: 10, delta_pct: 100 });
    expect(out.note).toContain('does not expose auction insights');
  });
});

describe('auto-adjustments (MEDIA_BUYER_GAPS #1, #45)', () => {
  it('raises a too-tight cost cap only when under-delivering below target, and skips learning ad sets', async () => {
    const make = (learning: string) => mockClient(async (endpoint) => {
      if (endpoint.endsWith('/insights')) {
        return insights([{ spend: '100', actions: [{ action_type: 'lead', value: '20' }] }]);
      }
      return {
        data: {
          id: 'a1', name: 'A', bid_strategy: 'COST_CAP', bid_amount: '1000', daily_budget: '5000',
          optimization_goal: 'LEAD_GENERATION', learning_stage_info: { status: learning }, campaign: { objective: 'OUTCOME_LEADS' },
        },
        status: 200,
      };
    });
    const ok = make('SUCCESS');
    const out = JSON.parse((await run(registerBiddingCommands, ok.client, ['bidding', 'auto-adjustments', 'a1'])).stdout);
    // $100 over 7 days on a $50/day budget = 29% delivery; CPA $5 ≤ $10 cap.
    expect(out[0]).toMatchObject({ action: 'raise_bid', recommended: { bid_amount: 1100 } });

    const learning = make('LEARNING');
    const out2 = JSON.parse((await run(registerBiddingCommands, learning.client, ['bidding', 'auto-adjustments', 'a1', '--apply'])).stdout);
    expect(out2[0].action).toBe('no_change');
    expect(learning.request.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  });
});

describe('seasonal-schedule and pacing (MEDIA_BUYER_GAPS #39)', () => {
  it('creates an ABSOLUTE budget schedule with --apply', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'c1', name: 'C', daily_budget: '10000' }, status: 200 }));
    await run(registerBiddingCommands, client, ['bidding', 'seasonal-schedule', '--campaign-ids', 'c1', '--adjustment', '20',
      '--start-date', '2026-11-27', '--end-date', '2026-11-30', '--apply']);
    const post = request.mock.calls.find(([e, o]) => e === 'c1/budget_schedules' && o?.method === 'POST');
    expect(post?.[1]?.body).toMatchObject({ budget_value: '2000', budget_value_type: 'ABSOLUTE' });
  });

  it('reports lifetime pacing against the flight', async () => {
    const start = new Date(Date.now() - 5 * 86400000).toISOString();
    const stop = new Date(Date.now() + 5 * 86400000).toISOString();
    const { client } = mockClient(async () => ({
      data: { id: 'c1', name: 'C', lifetime_budget: '100000', budget_remaining: '80000', start_time: start, stop_time: stop }, status: 200,
    }));
    const out = JSON.parse((await run(registerBiddingCommands, client, ['bidding', 'pacing', 'c1'])).stdout);
    expect(out.pace).toBe('under_pacing');
    expect(out.spent).toBe(200);
  });
});
