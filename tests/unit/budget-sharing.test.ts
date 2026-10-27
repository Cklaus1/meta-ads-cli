import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyAdsetBudgetSharing, registerCampaignCommands } from '../../src/commands/campaigns.js';
import { registerBulkCommands } from '../../src/commands/bulk.js';
import { registerBackupCommands } from '../../src/commands/backup.js';
import { registerRetargetingCommands } from '../../src/commands/retargeting.js';
import { buildLaunchBodies } from '../../src/commands/workflows.js';
import { mockClient, run } from './command-helpers.js';

const ok = async () => ({ data: { id: '1' }, status: 200 });
const bodyFor = (request: { mock: { calls: unknown[][] } }, endpoint: string) =>
  (request.mock.calls.find(([e]) => e === endpoint)?.[1] as { body: Record<string, string> } | undefined)?.body;

describe('is_adset_budget_sharing_enabled (META_API_UPDATES #2)', () => {
  it('is set to false only when the campaign has no budget', () => {
    expect(applyAdsetBudgetSharing({ name: 'x' }).is_adset_budget_sharing_enabled).toBe('false');
    expect(applyAdsetBudgetSharing({ name: 'x' }, true).is_adset_budget_sharing_enabled).toBe('true');
    expect(applyAdsetBudgetSharing({ daily_budget: '100' }).is_adset_budget_sharing_enabled).toBeUndefined();
    expect(applyAdsetBudgetSharing({ lifetime_budget: '100' }).is_adset_budget_sharing_enabled).toBeUndefined();
  });

  it('campaigns create sends it for ad set budgets and honours --adset-budget-sharing', async () => {
    const { client, request } = mockClient(ok);
    await run(registerCampaignCommands, client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_SALES', '--adset-level-budgets', '--adset-budget-sharing']);
    expect(bodyFor(request, 'act_1/campaigns')?.is_adset_budget_sharing_enabled).toBe('true');

    const second = mockClient(ok);
    await run(registerCampaignCommands, second.client, ['campaigns', 'create', '--account-id', 'act_1', '--name', 'C', '--objective', 'OUTCOME_SALES', '--daily-budget', '500']);
    expect(bodyFor(second.request, 'act_1/campaigns')?.is_adset_budget_sharing_enabled).toBeUndefined();
  });

  it('launch-campaign sets it only for --budget-level adset', () => {
    const base = { name: 'L', objective: 'OUTCOME_TRAFFIC', dailyBudget: '500', optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS' };
    expect(buildLaunchBodies({ ...base, budgetLevel: 'adset' }).campaignBody.is_adset_budget_sharing_enabled).toBe('false');
    expect(buildLaunchBodies({ ...base, budgetLevel: 'campaign' }).campaignBody.is_adset_budget_sharing_enabled).toBeUndefined();
  });

  it('retargeting dynamic-campaign sets it for ad set budgets', async () => {
    const { client, request } = mockClient(ok);
    await run(registerRetargetingCommands, client, [
      'retargeting', 'dynamic-campaign', '--account-id', 'act_1', '--campaign-name', 'C', '--product-set-id', '3',
      '--page-id', '4', '--catalog-id', '9', '--budget-level', 'adset',
    ]);
    expect(bodyFor(request, 'act_1/campaigns')?.is_adset_budget_sharing_enabled).toBe('false');
  });

  it('bulk create-campaigns respects the config value, else defaults to false', async () => {
    const { client, request } = mockClient(ok);
    const config = JSON.stringify([
      { name: 'A' },
      { name: 'B', is_adset_budget_sharing_enabled: true },
      { name: 'C', daily_budget: 500 },
    ]);
    await run(registerBulkCommands, client, ['bulk', 'create-campaigns', '--account-id', 'act_1', '--config', config, '--delay-ms', '0']);
    const bodies = request.mock.calls.map(c => (c[1] as { body: Record<string, string> }).body);
    expect(bodies.find(b => b.name === 'A')?.is_adset_budget_sharing_enabled).toBe('false');
    expect(bodies.find(b => b.name === 'B')?.is_adset_budget_sharing_enabled).toBe('true');
    expect(bodies.find(b => b.name === 'C')?.is_adset_budget_sharing_enabled).toBeUndefined();
  });
});

describe('backup restore and Advantage+ campaigns (#2, #3)', () => {
  function snapshot(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-asc-')), 'snap.json');
    fs.writeFileSync(file, JSON.stringify({
      snapshot_version: 1, exported_at: '', api_version: 'v25.0', account_id: 'act_1',
      campaigns: [
        { id: 'c1', name: 'ABO', is_adset_budget_sharing_enabled: true },
        { id: 'c2', name: 'Plain' },
        { id: 'c3', name: 'ASC', smart_promotion_type: 'AUTOMATED_SHOPPING_ADS', daily_budget: '1000' },
        { id: 'c4', name: 'CBO', daily_budget: '1000', smart_promotion_type: 'GUIDED_CREATION' },
      ],
      adsets: [{ id: 's3', name: 'S3', campaign_id: 'c3' }],
      ads: [],
      creatives: [],
    }));
    return file;
  }

  it('restores the sharing flag, never sends smart_promotion_type, and skips ASC campaigns', async () => {
    let seq = 0;
    const { client, request } = mockClient(async () => ({ data: { id: `n${++seq}` }, status: 200 }));
    const { stdout } = await run(registerBackupCommands, client, ['backup', 'restore', '--file', snapshot(), '--yes']);
    const out = JSON.parse(stdout);
    const campaignBodies = request.mock.calls
      .filter(([e]) => e === 'act_1/campaigns')
      .map(c => (c[1] as { body: Record<string, string> }).body);

    expect(campaignBodies.map(b => b.name)).toEqual(['ABO', 'Plain', 'CBO']);
    expect(campaignBodies.every(b => b.smart_promotion_type === undefined)).toBe(true);
    expect(campaignBodies.find(b => b.name === 'ABO')?.is_adset_budget_sharing_enabled).toBe('true');
    expect(campaignBodies.find(b => b.name === 'Plain')?.is_adset_budget_sharing_enabled).toBe('false');
    expect(campaignBodies.find(b => b.name === 'CBO')?.is_adset_budget_sharing_enabled).toBeUndefined();

    expect(out.skipped_campaigns).toEqual([{ id: 'c3', name: 'ASC', smart_promotion_type: 'AUTOMATED_SHOPPING_ADS' }]);
    expect(out.warnings.some((w: string) => w.includes('Advantage+ Shopping') && w.includes('no longer allows'))).toBe(true);
    expect(out.warnings.some((w: string) => w.includes('Ad set s3 skipped'))).toBe(true);
    expect(request.mock.calls.some(([e]) => e === 'act_1/adsets')).toBe(false);
  });
});
