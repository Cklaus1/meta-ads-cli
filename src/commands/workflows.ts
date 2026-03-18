import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerWorkflowCommands(program: Command, getClient: () => MetaClient): void {
  const wf = program.command('workflow').alias('wf').description('Cross-service workflows combining multiple API calls');

  wf
    .command('campaign-health <campaignId>')
    .description('Full health check: campaign details + insights + ad set status + creative fatigue')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();

      const [campaign, insights, adsets, ads] = await Promise.all([
        client.request(campaignId, {
          params: { fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,budget_remaining,start_time,stop_time' },
        }),
        client.request(`${campaignId}/insights`, {
          params: { fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type' },
        }),
        client.request(`${campaignId}/adsets`, {
          params: { fields: 'id,name,status,daily_budget,optimization_goal,bid_strategy', limit: '50' },
        }),
        client.request(`${campaignId}/ads`, {
          params: { fields: 'id,name,status,effective_status', limit: '50' },
        }),
      ]);

      const insightData = ((insights.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};
      const adsetData = (adsets.data as Record<string, unknown>).data as unknown[] || [];
      const adData = (ads.data as Record<string, unknown>).data as unknown[] || [];

      // Health indicators
      const health: string[] = [];
      const frequency = parseFloat(String(insightData.frequency || 0));
      const ctr = parseFloat(String(insightData.ctr || 0));
      const spend = parseFloat(String(insightData.spend || 0));

      if (frequency > 3) health.push('WARNING: High frequency — audience saturation risk');
      if (ctr < 0.5) health.push('WARNING: Low CTR — creative may need refresh');
      if (spend === 0) health.push('WARNING: Zero spend — check delivery status');
      const pausedAds = adData.filter((a: unknown) => (a as Record<string, unknown>).status === 'PAUSED').length;
      if (pausedAds > adData.length / 2) health.push(`INFO: ${pausedAds}/${adData.length} ads are paused`);
      if (health.length === 0) health.push('OK: No issues detected');

      console.log(formatOutput({
        campaign: campaign.data,
        insights: insightData,
        ad_sets: { total: adsetData.length, data: adsetData },
        ads: { total: adData.length, active: adData.length - pausedAds, paused: pausedAds },
        health_check: health,
      }, opts.output as OutputFormat));
    }));

  wf
    .command('full-audit')
    .description('Full account audit: all campaigns with insights, budget analysis, recommendations')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Get account info
      const account = await client.request(opts.accountId, {
        params: { fields: 'id,name,account_status,balance,currency,spend_cap,amount_spent' },
      });

      // Get all campaigns with insights
      const campaignInsights = await client.request(`${opts.accountId}/insights`, {
        params: {
          fields: 'campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions',
          level: 'campaign',
          limit: '100',
        },
      });

      const campaignData = (campaignInsights.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      // Analyze
      let totalSpend = 0;
      const recommendations: unknown[] = [];

      for (const c of campaignData) {
        const spend = parseFloat(String(c.spend || 0));
        const ctr = parseFloat(String(c.ctr || 0));
        const cpc = parseFloat(String(c.cpc || 0));
        const frequency = parseFloat(String(c.frequency || 0));
        totalSpend += spend;

        const recs: string[] = [];
        if (ctr < 0.5) recs.push('Low CTR — refresh creative');
        if (frequency > 4) recs.push('Audience saturation — expand targeting');
        if (cpc > 3 && spend > 100) recs.push('High CPC with significant spend — optimize bidding');

        if (recs.length > 0) {
          recommendations.push({
            campaign: c.campaign_name,
            campaign_id: c.campaign_id,
            spend,
            issues: recs,
          });
        }
      }

      console.log(formatOutput({
        account: account.data,
        summary: {
          total_campaigns: campaignData.length,
          total_spend: totalSpend.toFixed(2),
          campaigns_with_issues: recommendations.length,
        },
        campaign_performance: campaignData,
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
    .option('--optimization-goal <goal>', 'Optimization goal', 'LINK_CLICKS')
    .option('--billing-event <event>', 'Billing event', 'IMPRESSIONS')
    .option('--targeting <json>', 'Targeting spec as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Create campaign
      const campResponse = await client.request(`${opts.accountId}/campaigns`, {
        method: 'POST',
        body: {
          name: opts.name,
          objective: opts.objective,
          status: 'PAUSED',
          daily_budget: opts.dailyBudget,
          special_ad_categories: '[]',
        },
      });
      const campaignId = (campResponse.data as Record<string, unknown>).id as string;

      // Create ad set
      const adsetBody: Record<string, string> = {
        campaign_id: campaignId,
        name: `${opts.name} - Ad Set`,
        optimization_goal: opts.optimizationGoal,
        billing_event: opts.billingEvent,
        status: 'PAUSED',
        daily_budget: opts.dailyBudget,
      };
      if (opts.targeting) adsetBody.targeting = opts.targeting;

      const adsetResponse = await client.request(`${opts.accountId}/adsets`, {
        method: 'POST',
        body: adsetBody,
      });
      const adsetId = (adsetResponse.data as Record<string, unknown>).id as string;

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
        note: 'All created as PAUSED. Review and activate when ready.',
      }, opts.output as OutputFormat));
    }));

  wf
    .command('duplicate-and-test <campaignId>')
    .description('Duplicate a campaign and set up A/B test with variant bid strategy')
    .requiredOption('--variant-strategy <strategy>', 'Bid strategy for variant')
    .option('--name-prefix <prefix>', 'Name prefix for test', 'AB Test')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();

      // Duplicate campaign twice
      const [controlCopy, variantCopy] = await Promise.all([
        client.request(`${campaignId}/copies`, { method: 'POST', body: { status_option: 'PAUSED' } }),
        client.request(`${campaignId}/copies`, { method: 'POST', body: { status_option: 'PAUSED' } }),
      ]);

      const controlId = (controlCopy.data as Record<string, unknown>).copied_campaign_id as string;
      const variantId = (variantCopy.data as Record<string, unknown>).copied_campaign_id as string;

      // Rename and update variant
      if (controlId) {
        await client.request(controlId, { method: 'POST', body: { name: `${opts.namePrefix} - Control` } });
      }
      if (variantId) {
        await client.request(variantId, {
          method: 'POST',
          body: { name: `${opts.namePrefix} - Variant (${opts.variantStrategy})`, bid_strategy: opts.variantStrategy },
        });
      }

      console.log(formatOutput({
        original_campaign: campaignId,
        control: { id: controlId, ...controlCopy.data as Record<string, unknown> },
        variant: { id: variantId, bid_strategy: opts.variantStrategy, ...variantCopy.data as Record<string, unknown> },
        note: 'Both campaigns created as PAUSED. Activate both simultaneously to start test.',
      }, opts.output as OutputFormat));
    }));
}
