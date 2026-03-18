import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAdSetCommands(program: Command, getClient: () => MetaClient): void {
  const adsets = program.command('adsets').description('Ad set management');

  adsets
    .command('list')
    .description('List ad sets for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--limit <n>', 'Maximum number of ad sets', '10')
    .option('--status <status>', 'Filter by effective status')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,campaign_id,status,daily_budget,lifetime_budget,targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative',
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }

      let endpoint: string;
      if (opts.campaignId) {
        endpoint = `${opts.campaignId}/adsets`;
      } else {
        endpoint = `${opts.accountId}/adsets`;
      }

      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('get <adsetId>')
    .description('Get detailed info for a specific ad set')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,campaign_id,status,daily_budget,lifetime_budget,targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type',
      };

      const response = await client.request(adsetId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('create')
    .description('Create a new ad set')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--name <name>', 'Ad set name')
    .requiredOption('--optimization-goal <goal>', 'Optimization goal (LINK_CLICKS, REACH, CONVERSIONS, etc.)')
    .requiredOption('--billing-event <event>', 'Billing event (IMPRESSIONS, LINK_CLICKS, etc.)')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--daily-budget <cents>', 'Daily budget in cents')
    .option('--lifetime-budget <cents>', 'Lifetime budget in cents')
    .option('--bid-amount <cents>', 'Bid amount in cents')
    .option('--bid-strategy <strategy>', 'Bid strategy')
    .option('--targeting <json>', 'Targeting spec as JSON string')
    .option('--start-time <time>', 'Start time (ISO 8601)')
    .option('--end-time <time>', 'End time (ISO 8601)')
    .option('--promoted-object <json>', 'Promoted object as JSON string')
    .option('--dynamic-creative', 'Enable dynamic creative')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        campaign_id: opts.campaignId,
        name: opts.name,
        optimization_goal: opts.optimizationGoal,
        billing_event: opts.billingEvent,
        status: opts.status,
      };

      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.targeting) body.targeting = opts.targeting;
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.promotedObject) body.promoted_object = opts.promotedObject;
      if (opts.dynamicCreative) body.is_dynamic_creative = 'true';

      const response = await client.request(`${opts.accountId}/adsets`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('update <adsetId>')
    .description('Update an existing ad set')
    .option('--name <name>', 'New ad set name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--daily-budget <cents>', 'New daily budget in cents')
    .option('--lifetime-budget <cents>', 'New lifetime budget in cents')
    .option('--bid-amount <cents>', 'New bid amount in cents')
    .option('--bid-strategy <strategy>', 'New bid strategy')
    .option('--targeting <json>', 'New targeting spec as JSON string')
    .option('--optimization-goal <goal>', 'New optimization goal')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.targeting) body.targeting = opts.targeting;
      if (opts.optimizationGoal) body.optimization_goal = opts.optimizationGoal;

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(adsetId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('delete <adsetId>')
    .description('Delete (archive) an ad set')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const response = await client.request(adsetId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
