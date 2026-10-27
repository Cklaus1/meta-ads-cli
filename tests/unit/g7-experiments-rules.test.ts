import { describe, it, expect } from 'vitest';
import { registerExperimentCommands, parseCell, validateCells, buildStudyBody, toUnix } from '../../src/commands/experiments.js';
import { registerRuleCommands, buildPresetRule, assertRuleAllowed } from '../../src/commands/rules.js';
import { registerAbTestingCommands, compareArms } from '../../src/commands/ab-testing.js';
import { deriveMetrics } from '../../src/metrics.js';
import { mockClient, run } from './command-helpers.js';

describe('experiments', () => {
  it('parses --cell specs', () => {
    expect(parseCell('name=A;campaigns=1,2;pct=50')).toEqual({ name: 'A', campaigns: ['1', '2'], treatment_percentage: 50 });
    expect(parseCell('name=B;adaccounts=act_9;pct=20').adaccounts).toEqual(['9']);
    expect(() => parseCell('campaigns=1')).toThrow('needs a name');
    expect(() => parseCell('name=A;foo=1')).toThrow('unknown key');
  });

  it('enforces Meta cell rules', () => {
    const cell = (pct: number) => ({ name: 'x', treatment_percentage: pct, campaigns: ['1'] });
    expect(() => validateCells('SPLIT_TEST', [cell(50)])).toThrow('at least two cells');
    expect(() => validateCells('SPLIT_TEST', [cell(5), cell(50)])).toThrow('at least 10');
    expect(() => validateCells('SPLIT_TEST', [cell(60), cell(60)])).toThrow('100 or less');
    expect(() => validateCells('SPLIT_TEST', [{ name: 'x', treatment_percentage: 50 }, cell(50)])).toThrow('needs campaigns');
    expect(() => validateCells('SPLIT_TEST', [cell(50), cell(50)])).not.toThrow();
  });

  it('builds the study body', () => {
    const body = buildStudyBody({ name: 'T', type: 'split_test', start: 100, end: 200, cells: [
      { name: 'A', treatment_percentage: 50, campaigns: ['1'] },
      { name: 'B', treatment_percentage: 50, campaigns: ['2'] },
    ] });
    expect(body).toMatchObject({ name: 'T', type: 'SPLIT_TEST', start_time: '100', end_time: '200' });
    expect(JSON.parse(body.cells)).toHaveLength(2);
    expect(() => buildStudyBody({ name: 'T', type: 'NOPE', start: 1, end: 2, cells: [] })).toThrow('--type');
  });

  it('parses times', () => {
    expect(toUnix('1700000000', '--start')).toBe(1700000000);
    expect(toUnix('2026-01-01T00:00:00Z', '--start')).toBe(1767225600);
    expect(() => toUnix('soon', '--start')).toThrow('--start');
  });

  it('create POSTs to the business ad_studies edge', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'S1' }, status: 200 }));
    await run(registerExperimentCommands, client, [
      'experiments', 'create', '--business-id', '77', '--name', 'Bid test',
      '--cell', 'name=A;campaigns=1;pct=50', '--cell', 'name=B;campaigns=2;pct=50', '--start', '1700000000', '--days', '7',
    ]);
    const [endpoint, opts] = request.mock.calls[0];
    expect(endpoint).toBe('77/ad_studies');
    expect(opts?.body?.end_time).toBe(String(1700000000 + 7 * 86400));
    expect(JSON.parse(opts!.body!.cells)[1]).toEqual({ name: 'B', campaigns: ['2'], treatment_percentage: 50 });
  });
});

describe('ab-test', () => {
  const row = (results: number, clicks: number, spend = 100) => deriveMetrics({
    spend: String(spend), impressions: String(clicks * 50), inline_link_clicks: String(clicks),
    actions: [{ action_type: 'purchase', value: String(results) }],
  }, 'purchase');

  it('declares a winner only when significant and with enough results', () => {
    expect(compareArms(row(100, 1000), row(50, 1000)).winner).toBe('A');
    expect(compareArms(row(52, 1000), row(50, 1000)).winner).toBe('none');
    const small = compareArms(row(10, 100), row(2, 100));
    expect(small.winner).toBe('none');
    expect(String(small.verdict)).toContain('Not enough data');
  });

  it('create with --business-id enrolls the copies in a split test', async () => {
    let copy = 0;
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === '100' && !opts?.method) return { data: { id: '100', daily_budget: '10000' }, status: 200 };
      if (endpoint === '100/copies') return { data: { copied_campaign_id: String(201 + copy++) }, status: 200 };
      return { data: { id: 'S1' }, status: 200 };
    });
    await run(registerAbTestingCommands, client, [
      'ab-test', 'create', '--account-id', 'act_1', '--name', 'T', '--campaign-id', '100',
      '--variant-bid-strategy', 'COST_CAP', '--business-id', '77', '--budget-split', '0.6',
    ]);
    const study = request.mock.calls.find(([e]) => e === '77/ad_studies');
    expect(study).toBeDefined();
    const cells = JSON.parse(study![1]!.body!.cells);
    expect(cells.map((c: { campaigns: string[]; treatment_percentage: number }) => [c.campaigns[0], c.treatment_percentage])).toEqual([['201', 60], ['202', 40]]);
  });

  it('analyze compares on the objective result', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint.endsWith('/insights')) {
        const results = endpoint.startsWith('1') ? 100 : 50;
        return { data: { data: [{ spend: '100', impressions: '50000', inline_link_clicks: '1000', actions: [{ action_type: 'omni_purchase', value: String(results) }] }] }, status: 200 };
      }
      return { data: { id: endpoint, objective: 'OUTCOME_SALES' }, status: 200 };
    });
    const { stdout } = await run(registerAbTestingCommands, client, ['ab-test', 'analyze', '1', '2']);
    const out = JSON.parse(stdout);
    expect(out.comparison.result_event).toBe('purchase');
    expect(out.comparison.winner).toBe('A');
  });
});

describe('rules', () => {
  it('rejects PAUSE rules with cost conditions (Meta error 2703)', () => {
    expect(() => buildPresetRule({ preset: 'high-cpa', entity: 'ADSET', timePreset: 'LAST_7D', action: 'PAUSE', maxCpaCents: 2000 }))
      .toThrow('2703');
    expect(() => assertRuleAllowed({ filters: [{ field: 'cost_per_purchase_fb', value: 1, operator: 'GREATER_THAN' }] }, { execution_type: 'PAUSE' }))
      .toThrow('cost conditions');
  });

  it('builds a high-cpa notification rule with a spend floor', () => {
    const { evaluation_spec, execution_spec } = buildPresetRule({
      preset: 'high-cpa', entity: 'adset', timePreset: 'last_7d', action: 'notification', maxCpaCents: 2000, minSpendCents: 5000, campaigns: ['9'],
    });
    expect(execution_spec).toEqual({ execution_type: 'NOTIFICATION' });
    const filters = (evaluation_spec.filters as Array<{ field: string; value: unknown }>);
    expect(filters.find(f => f.field === 'cpa')?.value).toBe(2000);
    expect(filters.find(f => f.field === 'spent')?.value).toBe(5000);
    expect(filters.find(f => f.field === 'time_preset')?.value).toBe('LAST_7D');
    expect(filters.find(f => f.field === 'campaign.id')?.value).toEqual(['9']);
  });

  it('allows pausing on frequency', () => {
    expect(() => buildPresetRule({ preset: 'high-frequency', entity: 'AD', timePreset: 'LAST_7D', action: 'PAUSE', maxFrequency: 4 })).not.toThrow();
  });

  it('preset posts to adrules_library', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: 'R1' }, status: 200 }));
    await run(registerRuleCommands, client, ['rules', 'preset', 'low-ctr', '--account-id', 'act_1', '--min-ctr', '0.5', '--action', 'PAUSE']);
    const [endpoint, opts] = request.mock.calls[0];
    expect(endpoint).toBe('act_1/adrules_library');
    expect(JSON.parse(opts!.body!.schedule_spec)).toEqual({ schedule_type: 'SEMI_HOURLY' });
  });

  it('update keeps unchanged fields, since Meta requires all of them', async () => {
    const current = {
      id: 'R1', name: 'Old', status: 'ENABLED',
      evaluation_spec: { evaluation_type: 'SCHEDULE', filters: [] },
      execution_spec: { execution_type: 'NOTIFICATION' },
      schedule_spec: { schedule_type: 'DAILY' },
    };
    const { client, request } = mockClient(async (_e, opts) => (opts?.method ? { data: { success: true }, status: 200 } : { data: current, status: 200 }));
    await run(registerRuleCommands, client, ['rules', 'update', 'R1', '--name', 'New']);
    const body = request.mock.calls[1][1]!.body!;
    expect(body.name).toBe('New');
    expect(JSON.parse(body.schedule_spec)).toEqual({ schedule_type: 'DAILY' });
    expect(JSON.parse(body.execution_spec)).toEqual({ execution_type: 'NOTIFICATION' });
  });
});
