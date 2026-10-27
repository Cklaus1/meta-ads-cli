import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  registerAdSetCommands, applyBidHelpers, roasFloor, frequencyCapSpecs, assertFrequencyCapAllowed,
  applyTargetingHelpers, applyDsaDefaults, significantEdits, insightsExpansion, attachPerformance,
} from '../../src/commands/adsets.js';
import { registerAdCommands, reviewReasons } from '../../src/commands/ads.js';
import { registerBulkCommands, parseCsv, toCsv, diffRow, parseSetPairs } from '../../src/commands/bulk.js';
import { registerTargetingCommands, targetingEntries } from '../../src/commands/targeting.js';
import { mockClient, run } from './command-helpers.js';

type Call = [string, { method?: string; params?: Record<string, string>; body?: Record<string, string> }];
const posts = (request: { mock: { calls: unknown[][] } }) =>
  (request.mock.calls as Call[]).filter(([, o]) => o?.method === 'POST');

describe('bid helpers (MB-12)', () => {
  it('sets a ROAS floor scaled 10000x', () => {
    const body: Record<string, string> = {};
    applyBidHelpers(body, { roasGoal: '2.5', optimizationGoal: 'VALUE' });
    expect(body).toEqual({ bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS', bid_constraints: '{"roas_average_floor":25000}' });
    expect(roasFloor('1.5')).toBe(15000);
    expect(() => roasFloor('abc')).toThrow('--roas-goal');
  });

  it('requires VALUE optimisation and no bid amount for ROAS goals', () => {
    expect(() => applyBidHelpers({}, { roasGoal: '2', optimizationGoal: 'OFFSITE_CONVERSIONS' })).toThrow('VALUE');
    expect(() => applyBidHelpers({}, { roasGoal: '2', bidAmount: '100' })).toThrow('--bid-amount');
  });

  it('maps cost cap and bid cap, rejects TARGET_COST and conflicts', () => {
    const cost: Record<string, string> = {};
    applyBidHelpers(cost, { costCap: '1500' });
    expect(cost).toEqual({ bid_strategy: 'COST_CAP', bid_amount: '1500' });
    const cap: Record<string, string> = {};
    applyBidHelpers(cap, { bidCap: '300' });
    expect(cap).toEqual({ bid_strategy: 'LOWEST_COST_WITH_BID_CAP', bid_amount: '300' });
    expect(() => applyBidHelpers({}, { bidStrategy: 'TARGET_COST' })).toThrow('deprecated');
    expect(() => applyBidHelpers({}, { costCap: '1', bidCap: '2' })).toThrow('only one');
    expect(() => applyBidHelpers({}, { costCap: '1', bidStrategy: 'COST_CAP' })).toThrow('--bid-strategy');
  });
});

describe('frequency caps (MB-23)', () => {
  it('parses n/days and only allows REACH/THRUPLAY', () => {
    expect(JSON.parse(frequencyCapSpecs('2/7'))).toEqual([{ event: 'IMPRESSIONS', max_frequency: 2, interval_days: 7 }]);
    expect(() => frequencyCapSpecs('2')).toThrow('<impressions>/<days>');
    expect(() => assertFrequencyCapAllowed('OFFSITE_CONVERSIONS')).toThrow('REACH or THRUPLAY');
    expect(() => assertFrequencyCapAllowed('REACH')).not.toThrow();
  });

  it('create rejects a frequency cap on a conversion ad set before any request', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    await expect(run(registerAdSetCommands, client, ['adsets', 'create', '--account-id', 'act_1', '--campaign-id', '2', '--name', 'A',
      '--optimization-goal', 'OFFSITE_CONVERSIONS', '--billing-event', 'IMPRESSIONS', '--frequency-cap', '2/7'])).rejects.toThrow('REACH or THRUPLAY');
    expect(request).not.toHaveBeenCalled();
  });

  it('update checks the current optimisation goal', async () => {
    const { client, request } = mockClient(async () => ({ data: { optimization_goal: 'OFFSITE_CONVERSIONS' }, status: 200 }));
    await expect(run(registerAdSetCommands, client, ['adsets', 'update', '9', '--frequency-cap', '2/7'])).rejects.toThrow('REACH or THRUPLAY');
    expect(posts(request)).toHaveLength(0);
  });
});

describe('targeting helpers (MB-40, MB-44, G24)', () => {
  it('merges geo, age, gender, audiences, exclusions and brand safety', () => {
    const t: Record<string, unknown> = { geo_locations: { regions: [{ key: '1' }] } };
    applyTargetingHelpers(t, {
      countries: 'us,ca', ageMin: '25', ageMax: '54', genders: 'female',
      customAudiences: '1', excludedCustomAudiences: '2,3', publisherBlockLists: '77',
      excludedPublisherCategories: 'mature_audiences', creativeAudiencePairing: '1',
    });
    expect(t).toEqual({
      geo_locations: { regions: [{ key: '1' }], countries: ['US', 'CA'] },
      age_min: 25, age_max: 54, genders: [2],
      custom_audiences: [{ id: '1' }], excluded_custom_audiences: [{ id: '2' }, { id: '3' }],
      excluded_publisher_list_ids: ['77'], excluded_publisher_categories: ['mature_audiences'],
      targeting_automation: { creative_audience_pairing: 1 },
    });
    expect(() => applyTargetingHelpers({}, { ageMin: '10' })).toThrow('13 to 65');
    expect(() => applyTargetingHelpers({}, { ageMin: '40', ageMax: '30' })).toThrow('greater');
  });

  it('update merges helper flags into the current targeting', async () => {
    const { client, request } = mockClient(async (_e, o) => (
      o?.params?.fields === 'targeting'
        ? { data: { targeting: { geo_locations: { countries: ['US'] }, age_min: 18 } }, status: 200 }
        : { data: { learning_stage_info: { status: 'SUCCESS' } }, status: 200 }
    ));
    await run(registerAdSetCommands, client, ['adsets', 'update', '9', '--excluded-custom-audiences', '5']);
    const targeting = JSON.parse(posts(request)[0][1].body!.targeting);
    expect(targeting).toEqual({ geo_locations: { countries: ['US'] }, age_min: 18, excluded_custom_audiences: [{ id: '5' }] });
  });
});

describe('DSA defaults (MB-43)', () => {
  afterEach(() => {
    delete process.env.META_ADS_CLI_DSA_BENEFICIARY;
    delete process.env.META_ADS_CLI_DSA_PAYOR;
  });

  it('fills EU ad sets from env and warns when still missing', () => {
    const eu = { geo_locations: { countries: ['DE'] } };
    expect(applyDsaDefaults({}, eu)).toContain('DSA');
    process.env.META_ADS_CLI_DSA_BENEFICIARY = 'Brand';
    process.env.META_ADS_CLI_DSA_PAYOR = 'Agency';
    const body: Record<string, string> = {};
    expect(applyDsaDefaults(body, eu)).toBeUndefined();
    expect(body).toEqual({ dsa_beneficiary: 'Brand', dsa_payor: 'Agency' });
    const us: Record<string, string> = {};
    expect(applyDsaDefaults(us, { geo_locations: { countries: ['US'] } })).toBeUndefined();
    expect(us).toEqual({});
  });
});

describe('learning-phase guard (MB-45)', () => {
  it('detects significant edits', () => {
    expect(significantEdits({ daily_budget: '1100' }, { daily_budget: '1000' })).toEqual([]);
    expect(significantEdits({ daily_budget: '1500' }, { daily_budget: '1000' })).toEqual(['daily budget change of 50%']);
    expect(significantEdits({ name: 'x', bid_amount: '5' }, {})).toEqual(['bid amount']);
  });

  it('blocks significant edits in LEARNING unless --force', async () => {
    const learning = async () => ({ data: { learning_stage_info: { status: 'LEARNING' }, daily_budget: '1000', optimization_goal: 'VALUE' }, status: 200 });
    const blocked = mockClient(learning);
    await expect(run(registerAdSetCommands, blocked.client, ['adsets', 'update', '9', '--daily-budget', '2000'])).rejects.toThrow('learning phase');
    expect(posts(blocked.request)).toHaveLength(0);

    const forced = mockClient(learning);
    await run(registerAdSetCommands, forced.client, ['adsets', 'update', '9', '--daily-budget', '2000', '--force']);
    expect(posts(forced.request)).toHaveLength(1);

    const small = mockClient(learning);
    await run(registerAdSetCommands, small.client, ['adsets', 'update', '9', '--daily-budget', '1100']);
    expect(posts(small.request)).toHaveLength(1);
  });
});

describe('--with-insights (MB-46)', () => {
  it('builds a field expansion and derives performance per row', () => {
    expect(insightsExpansion('last_7d')).toMatch(/^insights\.date_preset\(last_7d\)\{spend,.*action_values/);
    expect(() => insightsExpansion('bogus')).toThrow('Unknown time range');
    const rows: Array<Record<string, unknown>> = [
      { id: 'a', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { custom_event_type: 'PURCHASE' },
        insights: { data: [{ spend: '100', actions: [{ action_type: 'omni_purchase', value: '2' }, { action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '300' }] }] } },
      { id: 'b', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { custom_event_type: 'PURCHASE' },
        insights: { data: [{ spend: '100', actions: [{ action_type: 'omni_purchase', value: '5' }] }] } },
      { id: 'c', optimization_goal: 'LINK_CLICKS' },
    ];
    attachPerformance(rows, 'cost_per_result');
    expect(rows.map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(rows[1].performance).toMatchObject({ results: 2, cost_per_result: 50, revenue: 300, roas: 3 });
    expect(rows[0].insights).toBeUndefined();
  });

  it('ads list asks for the ad set goal and insights', async () => {
    const { client, request } = mockClient(async () => ({ data: { data: [{ id: '1', adset: { optimization_goal: 'LINK_CLICKS' }, insights: { data: [{ spend: '10', actions: [{ action_type: 'link_click', value: '5' }] }] } }] }, status: 200 }));
    const { stdout } = await run(registerAdCommands, client, ['ads', 'list', '--account-id', 'act_1', '--with-insights', 'last_7d']);
    expect((request.mock.calls[0] as Call)[1].params!.fields).toContain('adset{optimization_goal,promoted_object},insights.date_preset(last_7d)');
    expect(JSON.parse(stdout).data[0].performance).toMatchObject({ results: 5, cost_per_result: 2 });
  });
});

describe('disapproved ads and re-review (G12, MB-33, MB-34)', () => {
  const ad = {
    id: '1', name: 'Ad', effective_status: 'DISAPPROVED', adset_id: '2', campaign_id: '3',
    ad_review_feedback: { global: { 'Circumventing systems': 'Ad uses misleading text' } },
    issues_info: [{ error_summary: 'Ad not delivering' }],
  };

  it('summarises review feedback', () => {
    expect(reviewReasons(ad)).toEqual(['Circumventing systems — Ad uses misleading text', 'Ad not delivering']);
  });

  it('lists disapproved and limited ads with reasons', async () => {
    const { client, requestAllPages } = mockClient(async () => ({ data: { data: [ad, { ...ad, id: '4', effective_status: 'WITH_ISSUES' }] }, status: 200 }));
    const { stdout } = await run(registerAdCommands, client, ['ads', 'disapproved', '--account-id', 'act_1']);
    expect(JSON.parse(requestAllPages.mock.calls[0][1].params.effective_status)).toEqual(['DISAPPROVED', 'WITH_ISSUES']);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ total: 2, disapproved: 1, with_issues: 1 });
    expect(out.data[0].reasons[0]).toContain('misleading');
  });

  it('request-review only re-saves with --resubmit and only for rejected ads', async () => {
    const shown = mockClient(async () => ({ data: ad, status: 200 }));
    await run(registerAdCommands, shown.client, ['ads', 'request-review', '1']);
    expect(posts(shown.request)).toHaveLength(0);

    const resubmit = mockClient(async () => ({ data: ad, status: 200 }));
    await run(registerAdCommands, resubmit.client, ['ads', 'request-review', '1', '--resubmit']);
    expect(posts(resubmit.request)[0][1].body).toEqual({ name: 'Ad' });

    const active = mockClient(async () => ({ data: { ...ad, effective_status: 'ACTIVE' }, status: 200 }));
    const { stdout } = await run(registerAdCommands, active.client, ['ads', 'request-review', '1', '--resubmit']);
    expect(posts(active.request)).toHaveLength(0);
    expect(JSON.parse(stdout).note).toContain('nothing to review');
  });
});

describe('bulk sheet round trip (G17)', () => {
  it('CSV writes and parses quoted cells and strips the formula guard', () => {
    const csv = toCsv(['id', 'name'], [{ id: '1', name: 'A, "B"' }, { id: '2', name: '=SUM(1)' }]);
    expect(csv).toBe('id,name\n1,"A, ""B"""\n2,\'=SUM(1)\n');
    expect(parseCsv(csv)).toEqual([{ id: '1', name: 'A, "B"' }, { id: '2', name: '=SUM(1)' }]);
    expect(parseCsv('id,name\r\n1,x\r\n')).toEqual([{ id: '1', name: 'x' }]);
  });

  it('diffs editable columns only and skips blanks', () => {
    expect(diffRow({ id: '1', name: 'New', status: '', objective: 'X', daily_budget: '1000' },
      { name: 'Old', status: 'PAUSED', daily_budget: '1000' }, ['name', 'status', 'daily_budget']))
      .toEqual({ name: { from: 'Old', to: 'New' } });
  });

  it('exports a sheet', async () => {
    const { client, requestAllPages } = mockClient(async () => ({ data: { data: [{ id: '1', name: 'C', status: 'ACTIVE', daily_budget: '500' }] }, status: 200 }));
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => { out.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      await run(registerBulkCommands, client, ['bulk', 'export', '--level', 'campaign', '--account-id', 'act_1']);
    } finally {
      process.stdout.write = write;
    }
    expect(requestAllPages.mock.calls[0][0]).toBe('act_1/campaigns');
    expect(out.join('').split('\n')[1]).toBe('1,C,ACTIVE,,,500,,,');
  });

  it('import previews by default, applies with --apply, and resumes from a state file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g5-bulk-'));
    const sheet = path.join(dir, 'sheet.csv');
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(sheet, 'id,name,daily_budget\n1,New name,\n2,Same,2000\n');
    const current: Record<string, Record<string, string>> = { 1: { name: 'Old' }, 2: { name: 'Same', daily_budget: '1000' } };
    const impl = async (endpoint: string) => ({ data: current[endpoint] ?? { success: true }, status: 200 });

    const preview = mockClient(impl);
    const { stdout } = await run(registerBulkCommands, preview.client, ['bulk', 'import', '--level', 'campaign', '--file', sheet]);
    expect(JSON.parse(stdout)).toMatchObject({ changed: 2, applied: 0 });
    expect(posts(preview.request)).toHaveLength(0);

    const apply = mockClient(impl);
    await run(registerBulkCommands, apply.client, ['bulk', 'import', '--level', 'campaign', '--file', sheet, '--apply', '--delay-ms', '0', '--state-file', state]);
    expect(posts(apply.request).map(([e, o]) => [e, o.body])).toEqual([['1', { name: 'New name' }], ['2', { daily_budget: '2000' }]]);
    expect(JSON.parse(fs.readFileSync(state, 'utf8')).done).toEqual(['1', '2']);

    const again = mockClient(impl);
    await run(registerBulkCommands, again.client, ['bulk', 'import', '--level', 'campaign', '--file', sheet, '--apply', '--delay-ms', '0', '--state-file', state]);
    expect(again.request).not.toHaveBeenCalled();
  });

  it('bulk update sets any fields and skips finished IDs', async () => {
    expect(parseSetPairs(['daily_budget=5000', 'name=Q4 = big'])).toEqual({ daily_budget: '5000', name: 'Q4 = big' });
    expect(() => parseSetPairs(['nope'])).toThrow('field=value');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g5-upd-'));
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ done: ['1'] }));
    const { client, request } = mockClient(async () => ({ data: { success: true }, status: 200 }));
    const { stdout } = await run(registerBulkCommands, client, ['bulk', 'update', '--ids', '1,2', '--set', 'daily_budget=5000', '--delay-ms', '0', '--state-file', state]);
    expect(posts(request).map(([e, o]) => [e, o.body])).toEqual([['2', { daily_budget: '5000' }]]);
    expect(JSON.parse(stdout)).toMatchObject({ updated: 1, skipped: 1 });
  });

  it('create-campaigns needs an objective for every config', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    await expect(run(registerBulkCommands, client, ['bulk', 'create-campaigns', '--account-id', 'act_1', '--config', '[{"name":"a"}]']))
      .rejects.toThrow('objective');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('targeting validate (G7)', () => {
  it('collects interests from flexible_spec and exclusions', () => {
    expect(targetingEntries({
      interests: [{ id: 1 }],
      flexible_spec: [{ behaviors: [{ id: '2' }] }],
      exclusions: { interests: [{ id: '3' }] },
    })).toEqual([{ type: 'interests', id: '1' }, { type: 'behaviors', id: '2' }, { type: 'interests', id: '3' }]);
  });

  it('flags invalid entries and a missing location', async () => {
    const { client } = mockClient(async (endpoint) => (
      endpoint.endsWith('targetingvalidation')
        ? { data: { data: [{ id: '1', name: 'Old interest', type: 'interests', valid: false }] }, status: 200 }
        : { data: { data: [{ estimate_mau_lower_bound: 1000 }] }, status: 200 }
    ));
    const { stdout, exitCode } = await run(registerTargetingCommands, client, ['targeting', 'validate', '--account-id', 'act_1',
      '--targeting', '{"interests":[{"id":"1"}]}']);
    const out = JSON.parse(stdout);
    expect(out.valid).toBe(false);
    expect(out.problems).toEqual(['interests Old interest is not valid', 'targeting has no geo_locations; Meta requires a location']);
    expect(out.delivery_estimate).toEqual({ estimate_mau_lower_bound: 1000 });
    expect(exitCode).toBe(1);
  });
});
