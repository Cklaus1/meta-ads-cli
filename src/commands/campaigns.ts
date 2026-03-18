import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
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
        fields: 'id,name,objective,status,daily_budget,lifetime_budget,buying_type,start_time,stop_time,created_time,updated_time,bid_strategy',
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
        fields: 'id,name,objective,status,daily_budget,lifetime_budget,buying_type,start_time,stop_time,created_time,updated_time,bid_strategy,special_ad_categories,budget_remaining,configured_status',
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
    .option('--cbo', 'Enable campaign budget optimization')
    .option('--adset-level-budgets', 'Use ad set level budgets instead of campaign level')
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
