import { describe, it, expect } from 'vitest';
import { registerWorkflowCommands, buildLaunchBodies, launchFailureMessage } from '../../src/commands/workflows.js';
import { registerRetargetingCommands } from '../../src/commands/retargeting.js';
import { mockClient, run } from './command-helpers.js';

const launchOpts = { name: 'N', objective: 'OUTCOME_TRAFFIC', dailyBudget: '5000', optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS', countries: 'US' };

describe('buildLaunchBodies', () => {
  it('puts the budget only on the campaign by default', () => {
    const { campaignBody, adsetBody } = buildLaunchBodies(launchOpts);
    expect(campaignBody.daily_budget).toBe('5000');
    expect(adsetBody.daily_budget).toBeUndefined();
  });
  it('puts the budget only on the ad set with --budget-level adset', () => {
    const { campaignBody, adsetBody } = buildLaunchBodies({ ...launchOpts, budgetLevel: 'adset' });
    expect(campaignBody.daily_budget).toBeUndefined();
    expect(adsetBody.daily_budget).toBe('5000');
  });
  it('defaults targeting to geo countries', () => {
    const { adsetBody } = buildLaunchBodies({ ...launchOpts, countries: 'us, gb' });
    expect(JSON.parse(adsetBody.targeting)).toEqual({ geo_locations: { countries: ['US', 'GB'] } });
  });
  it('rejects an unknown budget level', () => {
    expect(() => buildLaunchBodies({ ...launchOpts, budgetLevel: 'both' })).toThrow('--budget-level');
  });
});

describe('launchFailureMessage', () => {
  it('names already-created objects', () => {
    expect(launchFailureMessage(new Error('boom'), { campaign_id: '9' })).toContain('campaign_id=9');
  });
});

describe('workflow launch-campaign', () => {
  it('reports the orphaned campaign ID when the ad set fails', async () => {
    const { client } = mockClient(async (endpoint) => {
      if (endpoint === 'act_1/campaigns') return { data: { id: '777' }, status: 200 };
      throw new Error('Invalid parameter');
    });
    await expect(run(registerWorkflowCommands, client, [
      'workflow', 'launch-campaign', '--account-id', 'act_1', '--name', 'N', '--objective', 'OUTCOME_TRAFFIC',
      '--daily-budget', '5000', '--creative-id', '5', '--countries', 'US',
    ])).rejects.toThrow(/Invalid parameter[\s\S]*campaign_id=777/);
  });
});

describe('retargeting dynamic-campaign', () => {
  it('sends no ad set budget under a campaign budget', async () => {
    const { client, request } = mockClient(async (endpoint) => ({ data: { id: endpoint.endsWith('campaigns') ? '1' : '2' }, status: 200 }));
    await run(registerRetargetingCommands, client, [
      'retargeting', 'dynamic-campaign', '--account-id', 'act_1', '--campaign-name', 'C', '--product-set-id', '3', '--page-id', '4', '--catalog-id', '9',
    ]);
    const adset = request.mock.calls.find(([e]) => e === 'act_1/adsets')?.[1]?.body;
    const camp = request.mock.calls.find(([e]) => e === 'act_1/campaigns')?.[1]?.body;
    expect(camp?.daily_budget).toBe('5000');
    expect(adset?.daily_budget).toBeUndefined();
    expect(adset?.campaign_id).toBe('1');
  });

  it('targets product viewers, excludes buyers, and sets the catalog', async () => {
    const { client, request } = mockClient(async (endpoint) => (
      endpoint === '3' ? { data: { product_catalog: { id: '77' } }, status: 200 }
        : { data: { id: endpoint.endsWith('campaigns') ? '1' : '2' }, status: 200 }
    ));
    await run(registerRetargetingCommands, client, [
      'retargeting', 'dynamic-campaign', '--account-id', 'act_1', '--campaign-name', 'C', '--product-set-id', '3', '--page-id', '4',
      '--retention-days', '14',
    ]);
    const camp = request.mock.calls.find(([e]) => e === 'act_1/campaigns')?.[1]?.body;
    const adset = request.mock.calls.find(([e]) => e === 'act_1/adsets')?.[1]?.body;
    expect(JSON.parse(camp.promoted_object)).toEqual({ product_catalog_id: '77' });
    expect(JSON.parse(adset.promoted_object)).toEqual({ product_set_id: '3', custom_event_type: 'PURCHASE' });
    const spec = JSON.parse(adset.targeting).product_audience_specs[0];
    expect(spec.inclusions.map((r: any) => r.rule.event.eq)).toEqual(['ViewContent', 'AddToCart']);
    expect(spec.exclusions[0]).toEqual({ retention_seconds: 14 * 86400, rule: { event: { eq: 'Purchase' } } });
  });
});
