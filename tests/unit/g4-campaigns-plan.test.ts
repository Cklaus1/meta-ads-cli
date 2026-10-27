import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerCampaignCommands, preflightChecks, specialCategoryTargetingIssues } from '../../src/commands/campaigns.js';
import { buildLaunchBodies } from '../../src/commands/workflows.js';
import { registerPlanCommands, validateSpec, buildPlan, diffFields, type LaunchSpec } from '../../src/commands/plan.js';
import { mockClient, run } from './command-helpers.js';

const ok = async () => ({ data: { id: '1' }, status: 200 });
const bodyFor = (request: { mock: { calls: unknown[][] } }, endpoint: string) =>
  (request.mock.calls.find(([e, o]) => e === endpoint && (o as { method?: string })?.method === 'POST')?.[1] as { body: Record<string, string> } | undefined)?.body;

describe('campaigns create (MEDIA_BUYER_GAPS #10, #11; G24 PCA)', () => {
  it('--cbo no longer sends a non-existent field', async () => {
    const { client, request } = mockClient(ok);
    await run(registerCampaignCommands, client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_SALES', '--daily-budget', '500', '--cbo']);
    const body = bodyFor(request, 'act_1/campaigns')!;
    expect(body.campaign_budget_optimization).toBeUndefined();
    expect(body.daily_budget).toBe('500');
  });

  it('--advantage-plus requires a campaign budget; --pca-unified only for sales', async () => {
    const { client } = mockClient(ok);
    await expect(run(registerCampaignCommands, client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_SALES', '--advantage-plus']))
      .rejects.toThrow('needs a campaign budget');
    await expect(run(registerCampaignCommands, client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_TRAFFIC', '--pca-unified']))
      .rejects.toThrow('OUTCOME_SALES');
    const second = mockClient(ok);
    const out = await run(registerCampaignCommands, second.client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_SALES', '--daily-budget', '500', '--advantage-plus', '--pca-unified']);
    expect(bodyFor(second.request, 'act_1/campaigns')?.is_pca_unified).toBe('true');
    expect(JSON.parse(out.stdout).next_steps[0]).toContain('--advantage-audience 1');
  });

  it('get/list request advantage_state_info', async () => {
    const { client, request } = mockClient(ok);
    await run(registerCampaignCommands, client, ['campaigns', 'get', '1']);
    expect(request.mock.calls[0][1]?.params?.fields).toContain('advantage_state_info');
  });
});

describe('campaigns update (MEDIA_BUYER_GAPS #42, #45)', () => {
  it('blocks a large budget jump while ad sets are learning unless --force', async () => {
    const impl = async (endpoint: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return { data: { success: true }, status: 200 };
      if (endpoint.endsWith('/adsets')) return { data: { data: [{ effective_status: 'ACTIVE', learning_stage_info: { status: 'LEARNING' } }] }, status: 200 };
      return { data: { daily_budget: '10000' }, status: 200 };
    };
    const blocked = mockClient(impl);
    await expect(run(registerCampaignCommands, blocked.client, ['campaigns', 'update', 'c1', '--daily-budget', '20000'])).rejects.toThrow('--force');
    const forced = mockClient(impl);
    const out = await run(registerCampaignCommands, forced.client, ['campaigns', 'update', 'c1', '--daily-budget', '20000', '--force']);
    expect(out.stderr).toContain('learning phase');
    expect(bodyFor(forced.request, 'c1')?.daily_budget).toBe('20000');
  });

  it('sets special ad categories and warns about restricted targeting', async () => {
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (opts?.method === 'POST') return { data: { success: true }, status: 200 };
      return { data: { data: [{ id: 'a1', name: 'A', targeting: { age_min: 25, geo_locations: { countries: ['US'] } } }] }, status: 200 };
    });
    const out = await run(registerCampaignCommands, client, ['campaigns', 'update', 'c1', '--special-ad-categories', 'housing']);
    expect(bodyFor(request, 'c1')?.special_ad_categories).toBe('["HOUSING"]');
    expect(out.stderr).toContain('Age must be 18-65+');
  });
});

describe('specialCategoryTargetingIssues', () => {
  it('flags age, gender, zip and lookalikes for HEC/F categories only', () => {
    const t = { age_min: 21, genders: [1], geo_locations: { zips: [{ key: 'US:94103' }] }, custom_audiences: [{ id: '1', subtype: 'LOOKALIKE' }] };
    expect(specialCategoryTargetingIssues(t, ['EMPLOYMENT'])).toHaveLength(4);
    expect(specialCategoryTargetingIssues(t, [])).toEqual([]);
  });
});

describe('preflightChecks (PRODUCT_GAPS G7)', () => {
  const campaign = { id: 'c1', name: 'C', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '5000', special_ad_categories: [] };
  const adset = {
    id: 'a1', name: 'A', status: 'ACTIVE', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
    promoted_object: { pixel_id: '1', custom_event_type: 'PURCHASE' }, targeting: { geo_locations: { countries: ['US'] } },
  };
  const ad = { id: 'd1', name: 'D', adset_id: 'a1', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: 'cr1' } };

  it('passes a healthy campaign', () => {
    const checks = preflightChecks(campaign, { account_status: 1 }, [adset], [ad]);
    expect(checks.filter(c => c.status === 'fail')).toEqual([]);
  });

  it('catches the usual launch blockers', () => {
    const checks = preflightChecks(
      { ...campaign, stop_time: '2020-01-01T00:00:00Z' },
      { account_status: 3 },
      [{ ...adset, daily_budget: '100', promoted_object: undefined, targeting: {} }],
      [{ ...ad, effective_status: 'DISAPPROVED', creative: undefined }],
    );
    const text = checks.filter(c => c.status === 'fail').map(c => c.detail).join(' | ');
    expect(text).toContain('UNSETTLED');
    expect(text).toContain('in the past');
    expect(text).toContain('both campaign and ad set');
    expect(text).toContain('geo_locations');
    expect(text).toContain('promoted_object');
    expect(text).toContain('no creative');
    expect(text).toContain('Disapproved');
  });

  it('preflight command sets exit code 1 on failures', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint === 'c1') return { data: { ...campaign, account_id: '9' }, status: 200 };
      if (endpoint === 'act_9') return { data: { account_status: 1 }, status: 200 };
      return { data: { data: [] }, status: 200 };
    });
    const out = await run(registerCampaignCommands, client, ['campaigns', 'preflight', 'c1']);
    expect(JSON.parse(out.stdout).will_deliver).toBe(false);
    expect(out.exitCode).toBe(1);
  });
});

describe('launch-campaign defaults (MEDIA_BUYER_GAPS #14)', () => {
  const base = { name: 'N', dailyBudget: '5000', countries: 'US' };
  it('derives the goal from the objective and requires a pixel for sales', () => {
    expect(() => buildLaunchBodies({ ...base, objective: 'OUTCOME_SALES' })).toThrow(/pixel_id[\s\S]*--pixel-id/);
    const { adsetBody } = buildLaunchBodies({ ...base, objective: 'OUTCOME_SALES', pixelId: '7' });
    expect(adsetBody.optimization_goal).toBe('OFFSITE_CONVERSIONS');
    expect(JSON.parse(adsetBody.promoted_object)).toEqual({ pixel_id: '7', custom_event_type: 'PURCHASE' });
    expect(buildLaunchBodies({ ...base, objective: 'OUTCOME_TRAFFIC' }).adsetBody.optimization_goal).toBe('LANDING_PAGE_VIEWS');
  });
  it('has no silent US default', () => {
    expect(() => buildLaunchBodies({ name: 'N', dailyBudget: '1', objective: 'OUTCOME_AWARENESS' })).toThrow('Targeting is required');
  });
  it('rejects a goal that does not fit the objective', () => {
    expect(() => buildLaunchBodies({ ...base, objective: 'OUTCOME_AWARENESS', optimizationGoal: 'LINK_CLICKS' })).toThrow('not a valid optimization goal');
  });
});

describe('plan / apply (PRODUCT_GAPS G6)', () => {
  const spec: LaunchSpec = {
    account: 'act_1',
    campaign: { name: 'Fall', objective: 'OUTCOME_SALES', daily_budget: 5000 },
    adsets: [{
      name: 'US',
      promoted_object: { pixel_id: '1', custom_event_type: 'PURCHASE' },
      targeting: { geo_locations: { countries: ['US'] } },
      ads: [{ name: 'Hero', creative: { page_id: '2', image_hash: 'h', link: 'https://x.test', message: 'Hi', cta: 'SHOP_NOW' } }],
    }],
  };

  it('validates the spec locally', () => {
    expect(validateSpec(spec)).toEqual([]);
    const bad = validateSpec({ ...spec, adsets: [{ ...spec.adsets![0], daily_budget: 100, targeting: {}, promoted_object: undefined, ads: [{ name: 'X' }] }] });
    expect(bad.join(' | ')).toMatch(/can't have their own budget[\s\S]*geo_locations[\s\S]*promoted_object[\s\S]*creative_id or creative/);
  });

  it('diffs only fields the spec sets and never pauses live objects by default', () => {
    expect(diffFields({ daily_budget: '5000', status: 'PAUSED' }, { daily_budget: '4000', status: 'ACTIVE' }, ['daily_budget', 'status']))
      .toEqual({ daily_budget: { from: '4000', to: '5000' } });
    expect(diffFields({ targeting: '{"b":1,"a":2}' }, { targeting: { a: 2, b: 1 } }, ['targeting'])).toEqual({});
  });

  it('plans creates for new objects and updates/noops for existing ones by name', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint === 'act_1/campaigns') return { data: { data: [{ id: 'c9', name: 'Fall', status: 'ACTIVE', daily_budget: '4000' }] }, status: 200 };
      if (endpoint === 'c9/adsets') return { data: { data: [{ id: 'a9', name: 'US', status: 'ACTIVE', targeting: { geo_locations: { countries: ['US'] } } }] }, status: 200 };
      return { data: { data: [] }, status: 200 };
    });
    const actions = await buildPlan(client, spec);
    expect(actions.map(a => `${a.type}:${a.action}`)).toEqual(['campaign:update', 'adset:noop', 'ad:create']);
    expect(actions[0].changes).toEqual({ daily_budget: { from: '4000', to: '5000' } });
  });

  it('apply creates campaign → ad set → creative → ad, PAUSED, and names orphans on failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const file = path.join(dir, 'spec.json');
    fs.writeFileSync(file, JSON.stringify(spec));

    let n = 0;
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (opts?.method === 'POST') return { data: { id: `new${++n}` }, status: 200 };
      return { data: { data: [] }, status: 200 };
    });
    const out = JSON.parse((await run(registerPlanCommands, client, ['apply', file])).stdout);
    expect(Object.values(out.created)).toEqual(['new1', 'new2', 'new3', 'new4']);
    const ad = bodyFor(request, 'act_1/ads')!;
    expect(ad).toMatchObject({ adset_id: 'new2', status: 'PAUSED', creative: '{"creative_id":"new3"}' });
    expect(bodyFor(request, 'act_1/campaigns')?.status).toBe('PAUSED');
    const story = JSON.parse(bodyFor(request, 'act_1/adcreatives')!.object_story_spec);
    expect(story.link_data).toMatchObject({ image_hash: 'h', link: 'https://x.test', call_to_action: { type: 'SHOP_NOW' } });

    const failing = mockClient(async (endpoint, opts) => {
      if (opts?.method === 'POST' && endpoint === 'act_1/adsets') throw new Error('Invalid targeting');
      if (opts?.method === 'POST') return { data: { id: 'c77' }, status: 200 };
      return { data: { data: [] }, status: 200 };
    });
    await expect(run(registerPlanCommands, failing.client, ['apply', file])).rejects.toThrow(/Invalid targeting[\s\S]*campaign "Fall"=c77/);
  });

  it('plan reports an invalid spec with exit code 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ account: 'act_1', campaign: { name: 'X', objective: 'NOPE' } }));
    const { client } = mockClient(ok);
    const out = await run(registerPlanCommands, client, ['plan', file]);
    expect(JSON.parse(out.stdout).valid).toBe(false);
    expect(out.exitCode).toBe(1);
  });
});
