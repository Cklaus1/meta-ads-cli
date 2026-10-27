import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Meta requires is_adset_budget_sharing_enabled when a campaign has no
 * campaign-level budget (the ad sets carry the budget). Sets it to the given
 * value, defaulting to false, and leaves campaigns with a budget untouched.
 */
export function applyAdsetBudgetSharing(body: Record<string, string>, sharing?: boolean | string): Record<string, string> {
  const hasCampaignBudget = Boolean(body.daily_budget) || Boolean(body.lifetime_budget);
  if (!hasCampaignBudget && body.is_adset_budget_sharing_enabled === undefined) {
    body.is_adset_budget_sharing_enabled = String(sharing === true || sharing === 'true');
  }
  return body;
}

/** Advantage+ Shopping/App campaign types Meta no longer lets the API create or copy. */
export const BLOCKED_SMART_PROMOTION_TYPES = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION']);

/** Throw if a campaign's data shows it is an Advantage+ Shopping/App campaign, which Meta blocks copying via API. */
export function assertCopyableCampaign(campaign: Record<string, unknown>, campaignId: string): void {
  const type = campaign.smart_promotion_type;
  if (typeof type === 'string' && BLOCKED_SMART_PROMOTION_TYPES.has(type)) {
    throw new Error(
      `Campaign ${campaignId} is an Advantage+ ${type === 'SMART_APP_PROMOTION' ? 'App' : 'Shopping'} campaign (${type}). `
      + 'Meta no longer allows creating, copying or editing these via the API. Recreate it as a standard campaign instead.',
    );
  }
}

export function registerCampaignCommands(program: Command, getClient: () => MetaClient): void {
  const campaigns = program.command('campaigns').alias('camp').description('Campaign management');

  campaigns
    .command('list')
    .description('List campaigns for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum number of campaigns', '10')
    .option('--status <status>', 'Filter by effective status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('--page-delay <ms>', 'Delay between pages in ms')
    .option('-o, --output <format>', 'Output format: json, table, csv, text, yaml', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,objective,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,spend_cap,buying_type,bid_strategy,start_time,stop_time,created_time,updated_time,special_ad_categories,pacing_type,issues_info,smart_promotion_type',
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }
      if (opts.after) {
        params.after = opts.after;
      }

      const endpoint = `${opts.accountId}/campaigns`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined,
            opts.pageDelay ? parseInt(opts.pageDelay) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('get <campaignId>')
    .description('Get detailed info for a specific campaign')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,objective,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,spend_cap,buying_type,bid_strategy,start_time,stop_time,created_time,updated_time,special_ad_categories,special_ad_category_country,pacing_type,promoted_object,issues_info,adlabels,is_budget_schedule_enabled,is_adset_budget_sharing_enabled,source_campaign_id,smart_promotion_type',
      };

      const response = await client.request(campaignId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('create')
    .description('Create a new campaign')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <objective>', 'Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION)')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--daily-budget <cents>', 'Daily budget in cents')
    .option('--lifetime-budget <cents>', 'Lifetime budget in cents')
    .option('--bid-strategy <strategy>', 'Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP)')
    .option('--bid-cap <cents>', 'Bid cap in cents')
    .option('--spend-cap <cents>', 'Campaign spend cap in cents')
    .option('--buying-type <type>', 'Buying type (e.g., AUCTION)')
    .option('--special-ad-categories <categories>', 'Comma-separated special ad categories')
    .option('--special-ad-category-country <countries>', 'Comma-separated country codes for special ad categories')
    .option('--promoted-object <json>', 'Promoted object as JSON (e.g., {"pixel_id":"123","custom_event_type":"PURCHASE"})')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--cbo', 'Enable campaign budget optimization')
    .option('--adset-level-budgets', 'Use ad set level budgets instead of campaign level')
    .option('--adset-budget-sharing', 'With ad set budgets, let ad sets share up to 20% of budget (is_adset_budget_sharing_enabled)')
    .option('--start-time <time>', 'Campaign start time (ISO 8601)')
    .option('--stop-time <time>', 'Campaign stop time (ISO 8601)')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        objective: opts.objective,
        status: opts.status,
        special_ad_categories: opts.specialAdCategories
          ? JSON.stringify(opts.specialAdCategories.split(','))
          : '[]',
      };

      if (!opts.adsetLevelBudgets) {
        if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
        if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
        if (opts.cbo) body.campaign_budget_optimization = 'true';
      }
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.bidCap) body.bid_cap = opts.bidCap;
      if (opts.spendCap) body.spend_cap = opts.spendCap;
      if (opts.buyingType) body.buying_type = opts.buyingType;
      if (opts.specialAdCategoryCountry) body.special_ad_category_country = JSON.stringify(opts.specialAdCategoryCountry.split(','));
      if (opts.promotedObject) body.promoted_object = opts.promotedObject;
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.stopTime) body.stop_time = opts.stopTime;
      if (opts.adlabels) body.adlabels = opts.adlabels;
      applyAdsetBudgetSharing(body, opts.adsetBudgetSharing);

      const response = await client.request(`${opts.accountId}/campaigns`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('update <campaignId>')
    .description('Update an existing campaign')
    .option('--name <name>', 'New campaign name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--daily-budget <cents>', 'New daily budget in cents')
    .option('--lifetime-budget <cents>', 'New lifetime budget in cents')
    .option('--bid-strategy <strategy>', 'New bid strategy')
    .option('--bid-cap <cents>', 'New bid cap in cents')
    .option('--spend-cap <cents>', 'New spend cap in cents')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--start-time <time>', 'Campaign start time (ISO 8601)')
    .option('--stop-time <time>', 'Campaign stop time (ISO 8601)')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.bidCap) body.bid_cap = opts.bidCap;
      if (opts.spendCap) body.spend_cap = opts.spendCap;
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.stopTime) body.stop_time = opts.stopTime;
      if (opts.adlabels) body.adlabels = opts.adlabels;

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(campaignId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('delete <campaignId>')
    .description('Delete (archive) a campaign')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const response = await client.request(campaignId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
