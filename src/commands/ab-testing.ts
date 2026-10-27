import { Command } from 'commander';
import { MetaClient, isPlaceholderId } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { assertCopyableCampaign } from './campaigns.js';
import { handleErrors } from '../errors.js';
import { insightsTimeParams } from '../time-range.js';
import { compareProportions, deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, type DerivedMetrics } from '../metrics.js';
import { buildStudyBody, toUnix } from './experiments.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Work out how to split a campaign-level budget between the control and the
 * variant. Uses the same budget field as the original (daily or lifetime) and
 * refuses campaigns without a campaign budget, rather than inventing one.
 */
export function planBudgetSplit(original: Record<string, unknown>, split: number): { field: 'daily_budget' | 'lifetime_budget'; control: number; variant: number } {
  const field = Number(original.daily_budget) > 0 ? 'daily_budget'
    : Number(original.lifetime_budget) > 0 ? 'lifetime_budget'
      : null;
  if (!field) {
    throw new Error(
      'The base campaign has no campaign-level budget (it uses ad set budgets), so the budget can\'t be split. '
      + 'Use a campaign with a daily or lifetime campaign budget.',
    );
  }
  const total = Number(original[field]);
  const control = Math.round(total * split);
  return { field, control, variant: total - control };
}

/**
 * Compare two arms on their objective's result. The rate is results per link
 * click when there are clicks (conversion rate), otherwise per impression.
 * A winner is only declared when the difference is statistically significant
 * and both arms have enough results; cost per result and ROAS are reported but
 * not tested.
 */
export function compareArms(a: DerivedMetrics, b: DerivedMetrics, opts: { alpha?: number; minResults?: number } = {}): Record<string, unknown> {
  const alpha = opts.alpha ?? 0.05;
  const minResults = opts.minResults ?? 30;
  const useClicks = a.clicks > 0 && b.clicks > 0 && a.result_event !== 'link_click' && a.result_event !== 'reach';
  const denomA = useClicks ? a.clicks : a.impressions;
  const denomB = useClicks ? b.clicks : b.impressions;
  const rateA = denomA > 0 ? a.results / denomA : 0;
  const rateB = denomB > 0 ? b.results / denomB : 0;
  const { z, pValue } = compareProportions(a.results, denomA, b.results, denomB);
  const enough = a.results >= minResults && b.results >= minResults;
  let winner: string;
  let verdict: string;
  if (!enough) {
    winner = 'none';
    verdict = `Not enough data: each arm needs at least ${minResults} ${a.result_event} results (A has ${a.results}, B has ${b.results}).`;
  } else if (pValue >= alpha) {
    winner = 'none';
    verdict = `No significant difference in ${a.result_event} rate (p=${pValue.toFixed(3)} ≥ ${alpha}).`;
  } else {
    winner = rateA > rateB ? 'A' : 'B';
    verdict = `${winner} has a significantly higher ${a.result_event} rate (p=${pValue.toFixed(3)}).`;
  }
  const round = (v: number | null, d = 4) => (v === null ? null : Number(v.toFixed(d)));
  return {
    result_event: a.result_event,
    rate_basis: useClicks ? 'results per link click' : 'results per impression',
    a: { results: a.results, rate: round(rateA), cost_per_result: round(a.cost_per_result, 2), roas: round(a.roas, 2), spend: a.spend },
    b: { results: b.results, rate: round(rateB), cost_per_result: round(b.cost_per_result, 2), roas: round(b.roas, 2), spend: b.spend },
    z: round(z, 3),
    p_value: round(pValue),
    alpha,
    winner,
    verdict,
    caveat: 'Two separately running campaigns compete in the same auction and reach overlapping people, so this comparison is indicative only. Use `meta-ads experiments create --type SPLIT_TEST` for a clean test.',
  };
}

/** ID of the copy from a /copies response (copied_campaign_id, or id under --plan/--validate). */
export function copiedId(data: unknown): string | undefined {
  const d = data as Record<string, unknown>;
  return (d?.copied_campaign_id || d?.id) as string | undefined;
}

/**
 * Body for copying a campaign with its ad sets and ads. Without deep_copy
 * Meta copies only the campaign shell, so a test arm would have nothing to
 * deliver.
 */
export const DEEP_COPY_BODY: Record<string, string> = { status_option: 'PAUSED', deep_copy: 'true' };

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
    .option('--business-id <id>', 'Business ID: also create a Meta split test (Ad Studies) over the two copies so they don\'t compete in the same auction (env META_ADS_CLI_BUSINESS_ID)', process.env.META_ADS_CLI_BUSINESS_ID || '')
    .option('--start <time>', 'Split test start: "now", Unix timestamp or ISO date', 'now')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Get original campaign
      const origParams: Record<string, string> = {
        fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,smart_promotion_type',
      };
      const split = Number(opts.budgetSplit);
      if (!Number.isFinite(split) || split <= 0 || split >= 1) {
        throw new Error(`--budget-split must be between 0 and 1 (exclusive), got: "${opts.budgetSplit}"`);
      }

      const origResponse = await client.request(opts.campaignId, { params: origParams });
      const original = origResponse.data as Record<string, unknown>;
      assertCopyableCampaign(original, opts.campaignId);
      // In dry-run the GET returns a placeholder, so there is no real budget to split.
      const plan = original.dryRun
        ? { field: 'daily_budget' as const, control: 0, variant: 0 }
        : planBudgetSplit(original, split);

      // Create variant A (control) — copy of original
      const controlResponse = await client.request(`${opts.campaignId}/copies`, {
        method: 'POST',
        body: { ...DEEP_COPY_BODY },
      });
      const controlId = copiedId(controlResponse.data);

      // Create variant B with different bid strategy
      const variantCopyResponse = await client.request(`${opts.campaignId}/copies`, {
        method: 'POST',
        body: { ...DEEP_COPY_BODY },
      });
      const variantId = copiedId(variantCopyResponse.data);

      // Split the original budget across both copies, using the same budget field.
      if (controlId) {
        await client.request(controlId, {
          method: 'POST',
          body: { name: `${opts.name} - Control`, [plan.field]: String(plan.control) },
        });
      }
      if (variantId) {
        const updateBody: Record<string, string> = {
          name: `${opts.name} - Variant B (${opts.variantBidStrategy})`,
          bid_strategy: opts.variantBidStrategy,
          [plan.field]: String(plan.variant),
        };
        if (opts.variantBidAmount) updateBody.bid_cap = opts.variantBidAmount;
        await client.request(variantId, { method: 'POST', body: updateBody });
      }

      // A real split test divides the audience between the copies; without
      // it they compete in the same auction and the comparison is unreliable.
      let study: unknown = null;
      // Under --validate the copies weren't created, so a study over them would be rejected.
      const placeholderArms = isPlaceholderId(controlId) || isPlaceholderId(variantId);
      if (opts.businessId && controlId && variantId && placeholderArms && client.isValidateMode()) {
        study = { skipped: true, reason: 'The copies were only validated, not created, so no split test was set up.' };
      } else if (opts.businessId && controlId && variantId) {
        const start = toUnix(opts.start, '--start');
        const days = Number(opts.durationDays);
        const controlPct = Math.round(split * 100);
        const studyBody = buildStudyBody({
          name: opts.name,
          type: 'SPLIT_TEST',
          start,
          end: start + Math.round((Number.isFinite(days) && days > 0 ? days : 14) * 86400),
          cells: [
            { name: `${opts.name} - Control`, treatment_percentage: controlPct, campaigns: [controlId] },
            { name: `${opts.name} - Variant B`, treatment_percentage: 100 - controlPct, campaigns: [variantId] },
          ],
        });
        study = (await client.request(`${opts.businessId}/ad_studies`, { method: 'POST', body: studyBody })).data;
      }

      console.log(formatOutput({
        test_name: opts.name,
        split_test: study,
        control: controlResponse.data,
        variant: variantCopyResponse.data,
        budget_split: {
          field: plan.field,
          control: `${plan.control}¢ (${Math.round(split * 100)}%)`,
          variant: `${plan.variant}¢ (${Math.round((1 - split) * 100)}%)`,
        },
        duration_days: parseInt(opts.durationDays),
        note: study
          ? 'Both campaigns created as PAUSED and enrolled in a Meta split test. Activate both when ready, and pause the original campaign so it does not keep spending alongside them.'
          : 'Both campaigns created as PAUSED. Without --business-id they are NOT a real split test: they compete in the same auction and reach overlapping people. Pass --business-id (or use `meta-ads experiments create`) for a proper test. Pause the original campaign so it does not keep spending alongside them.',
      }, opts.output as OutputFormat));
    }));

  abtest
    .command('analyze <campaignIdA> <campaignIdB>')
    .description('Compare two campaigns on their objective\'s result (conversion rate with a significance test, cost per result, ROAS). For split tests created with experiments, prefer `meta-ads experiments results`')
    .option('--time-range <range>', 'Named range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_7d')
    .option('--since <date>', 'Start date YYYY-MM-DD (with --until)')
    .option('--until <date>', 'End date YYYY-MM-DD (with --since)')
    .option('--result-event <event>', 'Override the result event (purchase, lead, link_click, ...); default comes from the campaign objective')
    .option('--alpha <p>', 'Significance threshold', '0.05')
    .option('--min-results <n>', 'Minimum results per arm before declaring a winner', '30')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignIdA: string, campaignIdB: string, opts) => {
      const client = getClient();
      const insightParams: Record<string, string> = {
        fields: PERFORMANCE_FIELDS,
        ...insightsTimeParams(opts.timeRange, opts.since, opts.until),
      };

      const [insightsA, insightsB, campaignA, campaignB] = await Promise.all([
        client.request(`${campaignIdA}/insights`, { params: insightParams }),
        client.request(`${campaignIdB}/insights`, { params: insightParams }),
        client.request(campaignIdA, { params: { fields: 'id,name,objective,bid_strategy,daily_budget,status' } }),
        client.request(campaignIdB, { params: { fields: 'id,name,objective,bid_strategy,daily_budget,status' } }),
      ]);

      const rowOf = (r: { data: unknown }) => (((r.data as { data?: Array<Record<string, unknown>> }).data) || [])[0] || {};
      const objective = String((campaignA.data as Record<string, unknown>).objective || '');
      const objectiveB = String((campaignB.data as Record<string, unknown>).objective || '');
      const event = opts.resultEvent || resultEventFor({ objective });
      const warnings: string[] = [];
      if (objective && objectiveB && objective !== objectiveB) {
        warnings.push(`The campaigns have different objectives (${objective} vs ${objectiveB}); comparing on ${event}.`);
      }

      const comparison = compareArms(
        deriveMetrics(rowOf(insightsA), event),
        deriveMetrics(rowOf(insightsB), event),
        { alpha: Number(opts.alpha), minResults: Number(opts.minResults) },
      );

      console.log(formatOutput({
        campaign_a: campaignA.data,
        campaign_b: campaignB.data,
        comparison,
        ...(warnings.length ? { warnings } : {}),
      }, opts.output as OutputFormat));
    }));
}
