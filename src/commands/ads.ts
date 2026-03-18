import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAdCommands(program: Command, getClient: () => MetaClient): void {
  const ads = program.command('ads').description('Ad management');

  ads
    .command('list')
    .description('List ads for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--adset-id <id>', 'Filter by ad set ID')
    .option('--limit <n>', 'Maximum number of ads', '10')
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
        fields: 'id,name,adset_id,campaign_id,status,creative,bid_amount,created_time,updated_time',
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }

      let endpoint: string;
      if (opts.adsetId) {
        endpoint = `${opts.adsetId}/ads`;
      } else if (opts.campaignId) {
        endpoint = `${opts.campaignId}/ads`;
      } else {
        endpoint = `${opts.accountId}/ads`;
      }

      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('get <adId>')
    .description('Get detailed info for a specific ad')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,adset_id,campaign_id,status,creative,bid_amount,tracking_specs,created_time,updated_time,effective_status',
      };

      const response = await client.request(adId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('create')
    .description('Create a new ad')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Ad name')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--creative-id <id>', 'Creative ID')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--bid-amount <cents>', 'Bid amount in cents')
    .option('--tracking-specs <json>', 'Tracking specs as JSON string')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: opts.creativeId }),
        status: opts.status,
      };

      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.trackingSpecs) body.tracking_specs = opts.trackingSpecs;

      const response = await client.request(`${opts.accountId}/ads`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('update <adId>')
    .description('Update an existing ad')
    .option('--name <name>', 'New ad name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED)')
    .option('--bid-amount <cents>', 'New bid amount')
    .option('--creative-id <id>', 'New creative ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.creativeId) body.creative = JSON.stringify({ creative_id: opts.creativeId });

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(adId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('delete <adId>')
    .description('Delete an ad')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const response = await client.request(adId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
