import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { planBudgetSplit } from './ab-testing.js';
import { applyAdsetBudgetSharing, assertCopyableCampaign } from './campaigns.js';
import { handleErrors } from '../errors.js';
import { DEFAULT_GOAL_BY_OBJECTIVE, validateBidConfig, BID_STRATEGIES } from './bidding.js';
import { parseJsonInput } from '../json-input.js';
import { deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, hasEnoughVolume } from '../metrics.js';
import { insightsTimeParams } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export interface LaunchOptions {
  name: string;
  objective: string;
  dailyBudget: string;
  budgetLevel?: string;
  optimizationGoal?: string;
  billingEvent?: string;
  targeting?: string;
  countries?: string;
  adsetBudgetSharing?: boolean;
  pixelId?: string;
  customEventType?: string;
  pageId?: string;
  applicationId?: string;
  objectStoreUrl?: string;
  promotedObject?: string;
}

/**
 * Build the campaign and ad set bodies for launch-campaign. The budget goes on
 * exactly one level: Meta rejects ad set budgets under a campaign budget. The
 * optimization goal defaults from the objective (a Sales campaign optimizes for
 * conversions, not clicks), and targeting must be given explicitly.
 */
export function buildLaunchBodies(opts: LaunchOptions): { campaignBody: Record<string, string>; adsetBody: Record<string, string> } {
  const level = opts.budgetLevel || 'campaign';
  if (level !== 'campaign' && level !== 'adset') {
    throw new Error(`--budget-level must be "campaign" or "adset", got: "${opts.budgetLevel}"`);
  }
  const goal = opts.optimizationGoal || DEFAULT_GOAL_BY_OBJECTIVE[opts.objective];
  if (!goal) {
    throw new Error(`Unknown objective "${opts.objective}". Use one of: ${Object.keys(DEFAULT_GOAL_BY_OBJECTIVE).join(', ')}`);
  }
  const promotedObject = buildPromotedObject(opts);
  const billingEvent = opts.billingEvent || 'IMPRESSIONS';
  const { errors } = validateBidConfig({ objective: opts.objective, optimizationGoal: goal, billingEvent, promotedObject });
  if (errors.length) {
    throw new Error(`${errors.join(' ')}${goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE' ? ' Pass --pixel-id (and --custom-event-type).' : ''}${goal === 'LEAD_GENERATION' ? ' Pass --page-id.' : ''}${goal === 'APP_INSTALLS' ? ' Pass --application-id and --object-store-url.' : ''}`);
  }
  if (!opts.targeting && !opts.countries) {
    throw new Error('Targeting is required: pass --countries (e.g. US,CA) or --targeting.');
  }

  const campaignBody: Record<string, string> = {
    name: opts.name,
    objective: opts.objective,
    status: 'PAUSED',
    special_ad_categories: '[]',
  };
  const adsetBody: Record<string, string> = {
    name: `${opts.name} - Ad Set`,
    optimization_goal: goal,
    billing_event: billingEvent,
    status: 'PAUSED',
    targeting: opts.targeting
      ? JSON.stringify(parseJsonInput(opts.targeting, '--targeting'))
      : JSON.stringify({ geo_locations: { countries: parseCountries(opts.countries) } }),
  };
  if (promotedObject) adsetBody.promoted_object = JSON.stringify(promotedObject);
  if (level === 'campaign') campaignBody.daily_budget = opts.dailyBudget;
  else adsetBody.daily_budget = opts.dailyBudget;
  applyAdsetBudgetSharing(campaignBody, opts.adsetBudgetSharing);
  return { campaignBody, adsetBody };
}

function buildPromotedObject(opts: LaunchOptions): Record<string, unknown> | undefined {
  if (opts.promotedObject) return parseJsonInput<Record<string, unknown>>(opts.promotedObject, '--promoted-object');
  const po: Record<string, unknown> = {};
  if (opts.pixelId) {
    po.pixel_id = opts.pixelId;
    po.custom_event_type = (opts.customEventType || 'PURCHASE').toUpperCase();
  }
  if (opts.pageId) po.page_id = opts.pageId;
  if (opts.applicationId) po.application_id = opts.applicationId;
  if (opts.objectStoreUrl) po.object_store_url = opts.objectStoreUrl;
  return Object.keys(po).length ? po : undefined;
}

function parseCountries(codes: string | undefined): string[] {
  const list = (codes || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  if (list.length === 0) throw new Error('--countries must list at least one country code');
  return list;
}

/** Error text for a multi-step create that failed partway, naming what already exists. */
export function launchFailureMessage(err: unknown, created: Record<string, string>): string {
  const message = (err as Error).message || String(err);
  const ids = Object.entries(created).map(([k, v]) => `${k}=${v}`).join(', ');
  return ids
    ? `${message}\nAlready created (PAUSED) before the failure: ${ids}. Delete or reuse these before retrying.`
    : message;
}

export function registerWorkflowCommands(program: Command, getClient: () => MetaClient): void {
  const wf = program.command('workflow').alias('wf').description('Cross-service workflows combining multiple API calls');

  wf
    .command('campaign-health <campaignId>')
    .description('Health check: cost per result vs the account, learning state, delivery issues, frequency, ad review')
    .option('--time-range <range>', 'Evaluation window', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();

      const [campaign, insights, adsets, ads] = await Promise.all([
        client.request(campaignId, {
          params: { fields: 'id,name,account_id,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,budget_remaining,start_time,stop_time,promoted_object,issues_info' },
        }),
        client.request(`${campaignId}/insights`, {
          params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams(opts.timeRange) },
        }),
        client.requestAllPages(`${campaignId}/adsets`, {
          params: { fields: 'id,name,status,effective_status,daily_budget,optimization_goal,bid_strategy,learning_stage_info,issues_info', limit: '100' },
        }),
        client.requestAllPages(`${campaignId}/ads`, {
          params: { fields: 'id,name,status,effective_status', limit: '200' },
        }),
      ]);

      const c = campaign.data as Record<string, unknown>;
      const insightData = ((insights.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};
      const adsetData = ((adsets.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [];
      const adData = ((ads.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [];
      const event = resultEventFor({
        objective: c.objective as string | undefined,
        customEventType: (c.promoted_object as Record<string, string> | undefined)?.custom_event_type,
      });
      const m = deriveMetrics(insightData, event);

      // Compare with the account's own cost per result, not fixed dollar thresholds.
      let accountCpr: number | null = null;
      if (c.account_id) {
        const acct = await client.request(`act_${c.account_id}/insights`, {
          params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams('last_30d') },
        });
        accountCpr = deriveMetrics(((acct.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {}, event).cost_per_result;
      }

      const health: string[] = [];
      for (const issue of (c.issues_info as Array<Record<string, unknown>>) || []) {
        health.push(`ERROR: ${issue.error_summary || issue.error_message}`);
      }
      if (m.spend === 0 && c.effective_status === 'ACTIVE') health.push('WARNING: Zero spend while ACTIVE; run: meta-ads campaigns preflight ' + campaignId);
      if (m.cost_per_result !== null && accountCpr && hasEnoughVolume(m, { minResults: 10 })) {
        const ratio = m.cost_per_result / accountCpr;
        if (ratio > 1.5) health.push(`WARNING: Cost per ${event} ${m.cost_per_result.toFixed(2)} is ${ratio.toFixed(1)}× the account's 30-day average (${accountCpr.toFixed(2)}).`);
      } else if (m.results < 10) {
        health.push(`INFO: Only ${m.results} ${event} results in ${opts.timeRange}; too few to judge efficiency.`);
      }
      if ((m.frequency ?? 0) > 3) health.push(`WARNING: Frequency ${m.frequency?.toFixed(1)} in ${opts.timeRange}; watch for creative fatigue.`);
      const limited = adsetData.filter(a => (a.learning_stage_info as Record<string, unknown> | undefined)?.status === 'FAIL');
      if (limited.length) health.push(`WARNING: ${limited.length} ad set(s) learning limited: ${limited.map(a => a.name).join(', ')}`);
      const disapproved = adData.filter(a => a.effective_status === 'DISAPPROVED');
      if (disapproved.length) health.push(`ERROR: ${disapproved.length} ad(s) disapproved.`);
      const pausedAds = adData.filter(a => a.status === 'PAUSED').length;
      if (pausedAds > adData.length / 2) health.push(`INFO: ${pausedAds}/${adData.length} ads are paused`);
      if (health.length === 0) health.push('OK: No issues detected');

      console.log(formatOutput({
        campaign: c,
        metrics: m,
        account_30d_cost_per_result: accountCpr,
        ad_sets: { total: adsetData.length, data: adsetData },
        ads: { total: adData.length, active: adData.length - pausedAds, paused: pausedAds, disapproved: disapproved.length },
        health_check: health,
      }, opts.output as OutputFormat));
    }));

  wf
    .command('full-audit')
    .description('Account audit: campaigns by cost per result / ROAS against the account average, learning and delivery issues')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', 'Evaluation window', 'last_30d')
    .option('--min-results <n>', 'Minimum results before judging a campaign', '10')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const [account, campaignInsights, campaigns] = await Promise.all([
        client.request(opts.accountId, {
          params: { fields: 'id,name,account_status,disable_reason,balance,currency,spend_cap,amount_spent' },
        }),
        client.requestAllPages(`${opts.accountId}/insights`, {
          params: { fields: `campaign_id,campaign_name,${PERFORMANCE_FIELDS}`, level: 'campaign', limit: '200', ...insightsTimeParams(opts.timeRange) },
        }),
        client.requestAllPages(`${opts.accountId}/campaigns`, {
          params: { fields: 'id,objective,promoted_object,effective_status,issues_info', limit: '200' },
        }),
      ]);

      const meta = new Map((((campaigns.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || []).map(c => [String(c.id), c]));
      const campaignData = ((campaignInsights.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [];
      const minResults = Number(opts.minResults);

      const scored = campaignData.map(r => {
        const cm = meta.get(String(r.campaign_id)) || {};
        const event = resultEventFor({
          objective: cm.objective as string | undefined,
          customEventType: (cm.promoted_object as Record<string, string> | undefined)?.custom_event_type,
        });
        return { row: r, meta: cm, m: deriveMetrics(r, event) };
      });

      // Account average cost per result, per result event (objectives differ).
      const byEvent = new Map<string, { spend: number; results: number }>();
      for (const s of scored) {
        const agg = byEvent.get(s.m.result_event) || { spend: 0, results: 0 };
        agg.spend += s.m.spend;
        agg.results += s.m.results;
        byEvent.set(s.m.result_event, agg);
      }

      let totalSpend = 0;
      const recommendations: unknown[] = [];
      for (const s of scored) {
        totalSpend += s.m.spend;
        const recs: string[] = [];
        const agg = byEvent.get(s.m.result_event)!;
        const avg = agg.results ? agg.spend / agg.results : null;
        if (s.m.results < minResults) {
          if (s.m.spend > 0 && s.m.results === 0 && avg && s.m.spend > avg * 3) {
            recs.push(`Spent ${s.m.spend.toFixed(2)} (over 3× the average cost per ${s.m.result_event}) with no results.`);
          }
        } else if (avg && s.m.cost_per_result !== null && s.m.cost_per_result > avg * 1.5) {
          recs.push(`Cost per ${s.m.result_event} ${s.m.cost_per_result.toFixed(2)} is ${(s.m.cost_per_result / avg).toFixed(1)}× the account average (${avg.toFixed(2)}).`);
        }
        if ((s.m.frequency ?? 0) > 4) recs.push(`Frequency ${s.m.frequency?.toFixed(1)}: audience saturation; expand targeting or refresh creative.`);
        for (const issue of (s.meta.issues_info as Array<Record<string, unknown>>) || []) {
          recs.push(`Delivery issue: ${issue.error_summary || issue.error_message}`);
        }

        if (recs.length > 0) {
          recommendations.push({
            campaign: s.row.campaign_name,
            campaign_id: s.row.campaign_id,
            result_event: s.m.result_event,
            spend: s.m.spend,
            results: s.m.results,
            cost_per_result: s.m.cost_per_result,
            roas: s.m.roas,
            issues: recs,
          });
        }
      }

      console.log(formatOutput({
        account: account.data,
        window: opts.timeRange,
        summary: {
          total_campaigns: campaignData.length,
          total_spend: totalSpend.toFixed(2),
          campaigns_with_issues: recommendations.length,
          average_cost_per_result: Object.fromEntries([...byEvent].map(([e, a]) => [e, a.results ? Number((a.spend / a.results).toFixed(2)) : null])),
        },
        campaign_performance: scored.map(s => ({ campaign_id: s.row.campaign_id, campaign_name: s.row.campaign_name, ...s.m })),
        recommendations,
      }, opts.output as OutputFormat));
    }));

  wf
    .command('launch-campaign')
    .description('End-to-end campaign launch: create campaign + adset + ad in one step')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <obj>', 'Campaign objective')
    .requiredOption('--daily-budget <cents>', 'Daily budget in cents')
    .requiredOption('--creative-id <id>', 'Creative ID to use')
    .option('--budget-level <level>', 'Where the budget lives: campaign (Advantage+ campaign budget) or adset', 'campaign')
    .option('--optimization-goal <goal>', 'Optimization goal (default from objective: SALES→OFFSITE_CONVERSIONS, LEADS→LEAD_GENERATION, TRAFFIC→LANDING_PAGE_VIEWS, AWARENESS→REACH, ENGAGEMENT→POST_ENGAGEMENT, APP_PROMOTION→APP_INSTALLS)')
    .option('--billing-event <event>', 'Billing event', 'IMPRESSIONS')
    .option('--pixel-id <id>', 'Pixel for conversion goals (promoted_object.pixel_id)')
    .option('--custom-event-type <event>', 'Conversion event for --pixel-id (PURCHASE, LEAD, COMPLETE_REGISTRATION, ...)', 'PURCHASE')
    .option('--page-id <id>', 'Page for lead-form goals (promoted_object.page_id)')
    .option('--application-id <id>', 'App ID for app install goals')
    .option('--object-store-url <url>', 'App store URL for app install goals')
    .option('--promoted-object <json>', 'Full promoted object as JSON, @file or - (overrides the flags above)')
    .option('--targeting <json>', 'Targeting spec as JSON, @file or -')
    .option('--countries <codes>', 'Comma-separated country codes, used when --targeting is not given')
    .option('--adset-budget-sharing', 'With --budget-level adset, let ad sets share up to 20% of budget')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const { campaignBody, adsetBody } = buildLaunchBodies(opts);
      const created: Record<string, string> = {};

      try {
        // Create campaign
        const campResponse = await client.request(`${opts.accountId}/campaigns`, { method: 'POST', body: campaignBody });
        const campaignId = (campResponse.data as Record<string, unknown>).id as string;
        if (campaignId) created.campaign_id = campaignId;

        // Create ad set
        const adsetResponse = await client.request(`${opts.accountId}/adsets`, {
          method: 'POST',
          body: { ...adsetBody, campaign_id: campaignId },
        });
        const adsetId = (adsetResponse.data as Record<string, unknown>).id as string;
        if (adsetId) created.adset_id = adsetId;

        // Create ad
        const adResponse = await client.request(`${opts.accountId}/ads`, {
          method: 'POST',
          body: {
            name: `${opts.name} - Ad`,
            adset_id: adsetId,
            creative: JSON.stringify({ creative_id: opts.creativeId }),
            status: 'PAUSED',
          },
        });

        console.log(formatOutput({
          campaign: campResponse.data,
          adset: adsetResponse.data,
          ad: adResponse.data,
          budget_level: opts.budgetLevel,
          note: 'All created as PAUSED. Review and activate when ready.',
        }, opts.output as OutputFormat));
      } catch (err) {
        throw new Error(launchFailureMessage(err, created));
      }
    }));

  wf
    .command('duplicate-and-test <campaignId>')
    .description('Duplicate a campaign and set up A/B test with variant bid strategy')
    .requiredOption('--variant-strategy <strategy>', 'Bid strategy for variant')
    .option('--name-prefix <prefix>', 'Name prefix for test', 'AB Test')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      if (!BID_STRATEGIES.includes(opts.variantStrategy)) {
        throw new Error(`--variant-strategy must be one of ${BID_STRATEGIES.join(', ')} (TARGET_COST is deprecated).`);
      }
      const client = getClient();

      // Split the campaign budget 50/50 so the test doesn't double spend.
      const original = await client.request(campaignId, { params: { fields: 'daily_budget,lifetime_budget,smart_promotion_type' } });
      const originalData = original.data as Record<string, unknown>;
      assertCopyableCampaign(originalData, campaignId);
      const hasCampaignBudget = Number(originalData.daily_budget) > 0 || Number(originalData.lifetime_budget) > 0;
      const split = hasCampaignBudget ? planBudgetSplit(originalData, 0.5) : undefined;

      // Duplicate campaign twice
      const [controlCopy, variantCopy] = await Promise.all([
        client.request(`${campaignId}/copies`, { method: 'POST', body: { status_option: 'PAUSED' } }),
        client.request(`${campaignId}/copies`, { method: 'POST', body: { status_option: 'PAUSED' } }),
      ]);

      const controlId = (controlCopy.data as Record<string, unknown>).copied_campaign_id as string;
      const variantId = (variantCopy.data as Record<string, unknown>).copied_campaign_id as string;

      // Rename and update variant
      if (controlId) {
        await client.request(controlId, {
          method: 'POST',
          body: { name: `${opts.namePrefix} - Control`, ...(split ? { [split.field]: String(split.control) } : {}) },
        });
      }
      if (variantId) {
        await client.request(variantId, {
          method: 'POST',
          body: {
            name: `${opts.namePrefix} - Variant (${opts.variantStrategy})`,
            bid_strategy: opts.variantStrategy,
            ...(split ? { [split.field]: String(split.variant) } : {}),
          },
        });
      }

      console.log(formatOutput({
        original_campaign: campaignId,
        control: { id: controlId, ...controlCopy.data as Record<string, unknown> },
        variant: { id: variantId, bid_strategy: opts.variantStrategy, ...variantCopy.data as Record<string, unknown> },
        budget_split: split ?? null,
        note: split
          ? 'Both campaigns created as PAUSED with the campaign budget split 50/50. Activate both simultaneously to start test.'
          : 'Both campaigns created as PAUSED. The original uses ad set budgets, which were copied in full to both; lower them before activating to avoid doubling spend.',
        caveat: 'The two copies compete in the same auctions and can reach the same people, so this is a comparison, not a controlled test. '
          + 'For a clean result, use a Meta split test (ad studies), which separates audiences.',
      }, opts.output as OutputFormat));
    }));
}
