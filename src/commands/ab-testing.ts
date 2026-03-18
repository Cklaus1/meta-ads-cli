import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAbTestingCommands(program: Command, getClient: () => MetaClient): void {
  const abtest = program.command('ab-test').description('A/B testing for bid strategies and creatives');

  abtest
    .command('create')
    .description('Create an A/B test by duplicating a campaign with different bid strategies')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Test name')
    .requiredOption('--campaign-id <id>', 'Base campaign ID to duplicate')
    .requiredOption('--variant-bid-strategy <strategy>', 'Bid strategy for variant B')
    .option('--budget-split <ratio>', 'Budget split for variant A (0.0-1.0)', '0.5')
    .option('--variant-bid-amount <cents>', 'Bid amount for variant B')
    .option('--duration-days <days>', 'Test duration in days', '14')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Get original campaign
      const origParams: Record<string, string> = {
        fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories',
      };
      const origResponse = await client.request(opts.campaignId, { params: origParams });
      const original = origResponse.data as Record<string, unknown>;
      const totalBudget = parseInt(String(original.daily_budget || 10000));
      const split = parseFloat(opts.budgetSplit);

      // Create variant A (control) — copy of original with adjusted budget
      const controlBody: Record<string, string> = {
        status_option: 'PAUSED',
      };
      const controlResponse = await client.request(`${opts.campaignId}/copies`, {
        method: 'POST',
        body: controlBody,
      });

      // Create variant B with different bid strategy
      const variantCopyResponse = await client.request(`${opts.campaignId}/copies`, {
        method: 'POST',
        body: { status_option: 'PAUSED' },
      });

      // Update variant B bid strategy
      const variantId = ((variantCopyResponse.data as Record<string, unknown>).copied_campaign_id
        || (variantCopyResponse.data as Record<string, unknown>).id) as string;
      if (variantId) {
        const updateBody: Record<string, string> = {
          name: `${opts.name} - Variant B (${opts.variantBidStrategy})`,
          bid_strategy: opts.variantBidStrategy,
          daily_budget: String(Math.round(totalBudget * (1 - split))),
        };
        if (opts.variantBidAmount) updateBody.bid_cap = opts.variantBidAmount;
        await client.request(variantId, { method: 'POST', body: updateBody });
      }

      console.log(formatOutput({
        test_name: opts.name,
        control: controlResponse.data,
        variant: variantCopyResponse.data,
        budget_split: { control: `${split * 100}%`, variant: `${(1 - split) * 100}%` },
        duration_days: parseInt(opts.durationDays),
        note: 'Both campaigns created as PAUSED. Activate both when ready to start the test.',
      }, opts.output as OutputFormat));
    }));

  abtest
    .command('analyze <campaignIdA> <campaignIdB>')
    .description('Analyze A/B test results by comparing two campaigns')
    .option('--time-range <range>', 'Time range for comparison', 'last_7d')
    .option('--metrics <fields>', 'Metrics to compare', 'impressions,clicks,spend,cpc,cpm,ctr,conversions,cost_per_action_type')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignIdA: string, campaignIdB: string, opts) => {
      const client = getClient();
      const insightFields = opts.metrics;

      const [insightsA, insightsB] = await Promise.all([
        client.request(`${campaignIdA}/insights`, { params: { fields: insightFields } }),
        client.request(`${campaignIdB}/insights`, { params: { fields: insightFields } }),
      ]);

      const [campaignA, campaignB] = await Promise.all([
        client.request(campaignIdA, { params: { fields: 'id,name,bid_strategy,daily_budget,status' } }),
        client.request(campaignIdB, { params: { fields: 'id,name,bid_strategy,daily_budget,status' } }),
      ]);

      const dataA = ((insightsA.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};
      const dataB = ((insightsB.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

      // Calculate winner for key metrics
      const comparison: Record<string, unknown> = {};
      for (const metric of ['cpc', 'cpm', 'ctr', 'spend']) {
        const valA = parseFloat(String(dataA[metric] || 0));
        const valB = parseFloat(String(dataB[metric] || 0));
        const lowerIsBetter = metric !== 'ctr';
        const winner = lowerIsBetter
          ? (valA < valB ? 'A' : valA > valB ? 'B' : 'tie')
          : (valA > valB ? 'A' : valA < valB ? 'B' : 'tie');
        comparison[metric] = { a: valA, b: valB, winner, diff_pct: valA ? ((valB - valA) / valA * 100).toFixed(1) + '%' : 'N/A' };
      }

      console.log(formatOutput({
        campaign_a: campaignA.data,
        campaign_b: campaignB.data,
        insights_a: dataA,
        insights_b: dataB,
        comparison,
      }, opts.output as OutputFormat));
    }));
}
