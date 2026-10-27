import { describe, it, expect, afterEach, vi } from 'vitest';
import type { MetaClient } from '../../src/meta-client.js';
import { assertRuleWithinGuardrails, registerRuleCommands, type RuleGuardrails } from '../../src/commands/rules.js';
import { spendCapWriteValue, monthProgress, registerAccountCommands } from '../../src/commands/accounts.js';
import {
  assertScheduleWithinCap, scheduledBudget, presetDays, parseNonNegative, zonedToUnix, registerBiddingCommands,
} from '../../src/commands/bidding.js';
import { preflightChecks } from '../../src/commands/campaigns.js';
import { calendarWindows } from '../../src/commands/analytics.js';
import { PolicyError, UsageError } from '../../src/errors.js';
import { mockClient, run } from './command-helpers.js';

const noGuards: RuleGuardrails = { blockGoingLive: false, allowLive: false, spendCapCents: 0, accountCeilingCents: 0, allowBudgetRules: false };
const budgetIncrease = {
  execution_type: 'CHANGE_BUDGET',
  execution_options: [{ field: 'change_spec', value: { amount: 100, unit: 'PERCENTAGE' }, operator: 'EQUAL' }],
};

afterEach(() => { vi.restoreAllMocks(); });

describe('B2-03 rule guardrails', () => {
  it('blocks UNPAUSE and REBALANCE_BUDGET under blockGoingLive unless --allow-live', () => {
    const g = { ...noGuards, blockGoingLive: true };
    expect(() => assertRuleWithinGuardrails({ execution_type: 'UNPAUSE' }, g)).toThrow(PolicyError);
    expect(() => assertRuleWithinGuardrails({ execution_type: 'REBALANCE_BUDGET' }, g)).toThrow(PolicyError);
    expect(() => assertRuleWithinGuardrails({ execution_type: 'UNPAUSE' }, { ...g, allowLive: true })).not.toThrow();
    expect(() => assertRuleWithinGuardrails({ execution_type: 'PAUSE' }, g)).not.toThrow();
  });

  it('blocks budget-raising rules under a cap unless allowed with a limit within the cap', () => {
    const g = { ...noGuards, spendCapCents: 5000 };
    expect(() => assertRuleWithinGuardrails(budgetIncrease, g)).toThrow(/allow-budget-rules/);
    const allowed = { ...g, allowBudgetRules: true };
    expect(() => assertRuleWithinGuardrails(budgetIncrease, allowed)).toThrow(/limit/);
    const withLimit = (limit: number) => ({
      execution_type: 'CHANGE_BUDGET',
      execution_options: [{ field: 'change_spec', value: { amount: 20, unit: 'PERCENTAGE', limit }, operator: 'EQUAL' }],
    });
    expect(() => assertRuleWithinGuardrails(withLimit(9000), allowed)).toThrow(/exceeds/);
    expect(() => assertRuleWithinGuardrails(withLimit(4000), allowed)).not.toThrow();
    // The account ceiling counts as a cap too.
    expect(() => assertRuleWithinGuardrails(budgetIncrease, { ...noGuards, accountCeilingCents: 10000 })).toThrow(PolicyError);
  });

  it('allows budget decreases and anything when no cap is set', () => {
    const decrease = { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: -20, unit: 'PERCENTAGE' } }] };
    expect(() => assertRuleWithinGuardrails(decrease, { ...noGuards, spendCapCents: 5000 })).not.toThrow();
    expect(() => assertRuleWithinGuardrails(budgetIncrease, noGuards)).not.toThrow();
  });

  it('rules create refuses an UNPAUSE rule under the policy before any write', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    Object.assign(client, { getPolicy: () => ({ blockGoingLive: true }), getMaxSpendCapCents: () => 0, isLiveAllowed: () => false });
    await expect(run(registerRuleCommands, client, [
      'rules', 'create', '--account-id', 'act_1', '--name', 'r',
      '--evaluation-spec', '{"evaluation_type":"SCHEDULE","filters":[]}', '--execution-spec', '{"execution_type":"UNPAUSE"}',
    ])).rejects.toThrow(/exit 7/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rules enable checks the stored spec', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '9', name: 'r', execution_spec: budgetIncrease }, status: 200 }));
    Object.assign(client, { getPolicy: () => ({}), getMaxSpendCapCents: () => 5000 });
    await expect(run(registerRuleCommands, client, ['rules', 'enable', '9'])).rejects.toThrow(/exit 7/);
    expect(request.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
  });
});

describe('B2-07 account spend cap units', () => {
  it('writes spend_cap in standard currency units', () => {
    expect(spendCapWriteValue(5000, 'USD')).toBe('50');
    expect(spendCapWriteValue(2350, 'USD')).toBe('23.5');
    expect(spendCapWriteValue(5000, 'JPY')).toBe('5000');
  });

  it('set-spend-cap sends 50 for --cents 5000 on a USD account and checks the cap in cents', async () => {
    const { client, request } = mockClient(async (_e, o) => ({ data: o?.method === 'POST' ? { success: true } : { currency: 'USD' }, status: 200 }));
    Object.assign(client, { getMaxSpendCapCents: () => 0 });
    await run(registerAccountCommands, client, ['accounts', 'set-spend-cap', 'act_1', '--cents', '5000']);
    expect(request.mock.calls.find(c => c[1]?.method === 'POST')?.[1]?.body).toEqual({ spend_cap: '50' });

    const capped = mockClient(async () => ({ data: { currency: 'USD' }, status: 200 }));
    Object.assign(capped.client, { getMaxSpendCapCents: () => 1000 });
    await expect(run(registerAccountCommands, capped.client, ['accounts', 'set-spend-cap', 'act_1', '--cents', '5000'])).rejects.toThrow(/exit 7/);
  });
});

describe('B2-45 month progress', () => {
  it('counts the elapsed part of today in the account timezone', () => {
    // 2026-10-10 18:00 UTC is 11:00 in Los Angeles: 9 full days + 11/24.
    const p = monthProgress(new Date(Date.UTC(2026, 9, 10, 18, 0)), 'America/Los_Angeles');
    expect(p.daysInMonth).toBe(31);
    expect(p.daysElapsed).toBeCloseTo(9 + 11 / 24, 5);
  });
});

describe('B2-12 budget schedules', () => {
  it('checks the resulting budget, not the increase', () => {
    expect(scheduledBudget(4000, 4000, 'ABSOLUTE')).toBe(8000);
    expect(scheduledBudget(4000, 50, 'MULTIPLIER')).toBe(6000);
    expect(() => assertScheduleWithinCap(5000, 4000, 4000, 'ABSOLUTE', 'c1')).toThrow(PolicyError);
    expect(() => assertScheduleWithinCap(5000, 4000, 500, 'ABSOLUTE', 'c1')).not.toThrow();
  });

  it('seasonal-schedule --apply is blocked when the boosted budget exceeds the cap', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'c1', name: 'C', daily_budget: '4000' }, status: 200 }));
    Object.assign(client, { getMaxSpendCapCents: () => 5000 });
    await expect(run(registerBiddingCommands, client, [
      'bidding', 'seasonal-schedule', '--campaign-ids', 'c1', '--adjustment', '100', '--start-date', '2026-11-27', '--end-date', '2026-11-30', '--apply',
    ])).rejects.toThrow(/exit 7/);
    expect(request.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
  });

  it('converts schedule dates in the account timezone', () => {
    // Midnight in New York (EST, UTC-5) on 2026-11-27 is 05:00 UTC.
    expect(zonedToUnix('2026-11-27', '00:00:00', 'America/New_York', '--start-date')).toBe(String(Date.UTC(2026, 10, 27, 5) / 1000));
  });
});

describe('B2-43 input validation', () => {
  it('rejects NaN floors and ranges without a fixed day count', () => {
    expect(() => parseNonNegative('abc', '--min-spend')).toThrow(UsageError);
    expect(parseNonNegative('0', '--min-spend')).toBe(0);
    expect(() => presetDays('this_month')).toThrow(UsageError);
    expect(presetDays('last_14d')).toBe(14);
  });

  it('optimize-budget --min-spend abc exits 2', async () => {
    const { client } = mockClient(async () => ({ data: { data: [] }, status: 200 }));
    await expect(run(registerBiddingCommands, client, ['bidding', 'optimize-budget', '--account-id', 'act_1', '--min-spend', 'abc']))
      .rejects.toThrow(/exit 2/);
  });

  it('auto-adjustments skips a zero bid instead of sending bid_amount=0', async () => {
    const { client, request } = mockClient(async (endpoint) => (endpoint.endsWith('/insights')
      ? { data: { data: [{ spend: '10', impressions: '1000', actions: [{ action_type: 'link_click', value: '50' }] }] }, status: 200 }
      : { data: { id: 'a1', bid_strategy: 'COST_CAP', bid_amount: 0, daily_budget: '1000', optimization_goal: 'LINK_CLICKS' }, status: 200 }));
    const { stdout } = await run(registerBiddingCommands, client, ['bidding', 'auto-adjustments', 'a1', '--min-results', '1', '--apply']);
    expect(request.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0);
    expect(stdout).toContain('No current bid amount');
  });
});

describe('B2-22 zero-decimal currencies', () => {
  it('reads JPY budgets without dividing by 100', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint === 'act_9') return { data: { currency: 'JPY' }, status: 200 };
      if (endpoint.endsWith('/insights')) {
        return { data: { data: [{ spend: '28000', impressions: '100000', actions: [{ action_type: 'link_click', value: '500' }] }] }, status: 200 };
      }
      return { data: { id: 'a1', account_id: '9', bid_strategy: 'COST_CAP', bid_amount: 60, daily_budget: '5000', optimization_goal: 'LINK_CLICKS' }, status: 200 };
    });
    const { stdout } = await run(registerBiddingCommands, client, ['bidding', 'auto-adjustments', 'a1', '--min-results', '1']);
    const [entry] = JSON.parse(stdout);
    // 28000 spent over 7 days against a 5000 JPY daily budget: 0.8 delivery.
    expect(entry.metrics.delivery_ratio).toBeCloseTo(0.8, 5);
  });
});

describe('B2-23 KPI groups', () => {
  it('does not cut a lead campaign that beats its CPA target because another campaign has revenue', async () => {
    const insights = [
      { campaign_id: 's1', campaign_name: 'Sales', spend: '1000', impressions: '50000', actions: [{ action_type: 'omni_purchase', value: '20' }], action_values: [{ action_type: 'omni_purchase', value: '4000' }] },
      { campaign_id: 'l1', campaign_name: 'Leads', spend: '300', impressions: '20000', actions: [{ action_type: 'lead', value: '20' }] },
    ];
    const campaigns = [
      { id: 's1', objective: 'OUTCOME_SALES', daily_budget: '10000' },
      { id: 'l1', objective: 'OUTCOME_LEADS', daily_budget: '5000' },
    ];
    const { client } = mockClient(async (endpoint) => ({
      data: { data: endpoint.endsWith('/insights') ? insights : endpoint.endsWith('/campaigns') ? campaigns : [] }, status: 200,
    }));
    const { stdout } = await run(registerBiddingCommands, client, [
      'bidding', 'optimize-budget', '--account-id', 'act_1', '--min-results', '5', '--target-cpa', '20',
    ]);
    const lead = JSON.parse(stdout).campaigns.find((c: { campaign_id: string }) => c.campaign_id === 'l1');
    expect(lead.action).toBe('INCREASE');
    expect(lead.roas).toBeNull();
  });
});

describe('B2-28 preflight', () => {
  it('a paused, empty ad set does not block a healthy active one', () => {
    const campaign = { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '1000', objective: 'OUTCOME_TRAFFIC' };
    const adsets = [
      { id: 'a1', name: 'live', status: 'ACTIVE', targeting: { geo_locations: { countries: ['US'] } }, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' },
      { id: 'a2', name: 'old', status: 'PAUSED', targeting: {} },
    ];
    const ads = [{ id: 'ad1', adset_id: 'a1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: 'c1' } }];
    const checks = preflightChecks(campaign, { account_status: 1 }, adsets, ads);
    expect(checks.filter(c => c.status === 'fail')).toEqual([]);
    expect(checks.some(c => c.scope.startsWith('adset a2') && c.status === 'warn')).toBe(true);
  });
});

describe('B2-45 trends windows', () => {
  it('compares equal calendar windows when a day is missing', () => {
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
      '2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']; // 10-10 missing
    const rows = dates.map(d => ({ date_start: d }));
    const { window, before, after } = calendarWindows(rows, 7);
    expect(window).toBe(7);
    expect(after.map(r => r.date_start)).toEqual(['2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
    expect(before.map(r => r.date_start)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  });
});

// Keep the MetaClient type import used.
export type _Client = MetaClient;
