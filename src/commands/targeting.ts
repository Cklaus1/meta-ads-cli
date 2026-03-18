import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerTargetingCommands(program: Command, getClient: () => MetaClient): void {
  const targeting = program.command('targeting').description('Audience targeting and research');

  targeting
    .command('search-interests <query>')
    .description('Search interest targeting options')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adinterest',
        q: query,
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('suggest-interests')
    .description('Get interest suggestions based on existing interests')
    .requiredOption('--interests <ids>', 'Comma-separated interest IDs')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adinterestsuggestion',
        interest_list: JSON.stringify(opts.interests.split(',')),
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-behaviors')
    .description('Get available behavior targeting options')
    .option('--limit <n>', 'Maximum results', '50')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adTargetingCategory',
        class: 'behaviors',
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-demographics')
    .description('Get demographic targeting options')
    .option('--class <class>', 'Demographic class (demographics, life_events, industries, income, family_statuses)', 'demographics')
    .option('--limit <n>', 'Maximum results', '50')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adTargetingCategory',
        class: opts.class,
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-geo <query>')
    .description('Search geographic locations')
    .option('--type <type>', 'Location type: country, region, city, zip, geo_market, electoral_district')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adgeolocation',
        q: query,
        limit: opts.limit,
      };
      if (opts.type) {
        params.location_types = JSON.stringify([opts.type]);
      }

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('estimate-audience')
    .description('Estimate audience size for a targeting spec')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--targeting <json>', 'Targeting spec as JSON string')
    .option('--optimization-goal <goal>', 'Optimization goal', 'REACH')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        targeting_spec: opts.targeting,
        optimization_goal: opts.optimizationGoal,
      };

      const response = await client.request(`${opts.accountId}/delivery_estimate`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
