import { describe, it, expect } from 'vitest';
import { registerAbTestingCommands, planBudgetSplit } from '../../src/commands/ab-testing.js';
import { mockClient, run } from './command-helpers.js';

describe('planBudgetSplit', () => {
  it('splits a daily budget', () => {
    expect(planBudgetSplit({ daily_budget: '10000' }, 0.5)).toEqual({ field: 'daily_budget', control: 5000, variant: 5000 });
  });
  it('keeps the lifetime budget field for lifetime-budget campaigns', () => {
    expect(planBudgetSplit({ lifetime_budget: '30000' }, 0.6)).toEqual({ field: 'lifetime_budget', control: 18000, variant: 12000 });
  });
  it('refuses campaigns without a campaign budget', () => {
    expect(() => planBudgetSplit({}, 0.5)).toThrow('no campaign-level budget');
  });
});

describe('ab-test create', () => {
  const base = ['ab-test', 'create', '--account-id', 'act_1', '--name', 'T', '--campaign-id', '100', '--variant-bid-strategy', 'COST_CAP'];

  it('gives control and variant each their share of the original daily budget', async () => {
    let copy = 0;
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === '100' && !opts?.method) return { data: { id: '100', daily_budget: '10000' }, status: 200 };
      if (endpoint === '100/copies') return { data: { copied_campaign_id: String(201 + copy++) }, status: 200 };
      return { data: { success: true }, status: 200 };
    });
    await run(registerAbTestingCommands, client, base);
    const updates = request.mock.calls.filter(([e, o]) => (e === '201' || e === '202') && o?.method === 'POST');
    expect(updates.find(([e]) => e === '201')?.[1]?.body?.daily_budget).toBe('5000');
    expect(updates.find(([e]) => e === '202')?.[1]?.body?.daily_budget).toBe('5000');
  });

  it('errors before copying when the campaign has no campaign budget', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '100' }, status: 200 }));
    await expect(run(registerAbTestingCommands, client, base)).rejects.toThrow('no campaign-level budget');
    expect(request.mock.calls.some(([e]) => e === '100/copies')).toBe(false);
  });

  it.each(['0', '1', '1.5', 'abc'])('rejects --budget-split %s', async (split) => {
    const { client, request } = mockClient(async () => ({ data: { daily_budget: '10000' }, status: 200 }));
    await expect(run(registerAbTestingCommands, client, [...base, '--budget-split', split])).rejects.toThrow('--budget-split');
    expect(request).not.toHaveBeenCalled();
  });
});
