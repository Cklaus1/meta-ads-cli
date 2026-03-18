import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAudienceCommands(program: Command, getClient: () => MetaClient): void {
  const audiences = program.command('audiences').description('Custom and lookalike audience management');

  audiences
    .command('list')
    .description('List custom audiences for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated',
        limit: opts.limit,
      };

      const endpoint = `${opts.accountId}/customaudiences`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('get <audienceId>')
    .description('Get details for a custom audience')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated,lookalike_spec,rule',
      };

      const response = await client.request(audienceId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('create-custom')
    .description('Create a custom audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Audience name')
    .option('--description <desc>', 'Audience description')
    .option('--subtype <type>', 'Audience subtype (CUSTOM, WEBSITE, APP, OFFLINE_CONVERSION)')
    .option('--rule <json>', 'Audience rule as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.description) body.description = opts.description;
      if (opts.subtype) body.subtype = opts.subtype;
      if (opts.rule) body.rule = opts.rule;

      const response = await client.request(`${opts.accountId}/customaudiences`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('create-lookalike')
    .description('Create a lookalike audience from a source audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--source-audience-id <id>', 'Source audience ID')
    .option('--name <name>', 'Audience name')
    .option('--countries <countries>', 'Comma-separated target country codes (e.g., US,GB)')
    .option('--ratio <ratio>', 'Lookalike ratio (0.01-0.20)', '0.01')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const countries = opts.countries ? opts.countries.split(',') : ['US'];
      const lookalikeSpec = {
        type: 'similarity',
        country: countries[0],
        ratio: parseFloat(opts.ratio),
        origin: [{ id: opts.sourceAudienceId, type: 'custom_audience' }],
      };

      const body: Record<string, string> = {
        name: opts.name || `Lookalike - ${opts.sourceAudienceId}`,
        subtype: 'LOOKALIKE',
        origin_audience_id: opts.sourceAudienceId,
        lookalike_spec: JSON.stringify(lookalikeSpec),
      };

      const response = await client.request(`${opts.accountId}/customaudiences`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('update <audienceId>')
    .description('Update an existing custom audience')
    .option('--name <name>', 'New audience name')
    .option('--description <desc>', 'New description')
    .option('--rule <json>', 'New audience rule as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};
      if (opts.name) body.name = opts.name;
      if (opts.description) body.description = opts.description;
      if (opts.rule) body.rule = opts.rule;
      if (Object.keys(body).length === 0) throw new Error('No update parameters provided');

      const response = await client.request(audienceId, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('overlap')
    .description('Analyze overlap between multiple audiences')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--audience-ids <ids>', 'Comma-separated audience IDs (2-5)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const ids = opts.audienceIds.split(',').map((id: string) => id.trim());

      // Fetch each audience's approximate count
      const results: unknown[] = [];
      for (const id of ids) {
        const params: Record<string, string> = {
          fields: 'id,name,approximate_count',
        };
        const response = await client.request(id, { params });
        results.push(response.data);
      }

      // Use delivery_estimate to check combined reach
      const combinedTargeting = {
        custom_audiences: ids.map(id => ({ id })),
      };
      const estimateParams: Record<string, string> = {
        targeting_spec: JSON.stringify(combinedTargeting),
        optimization_goal: 'REACH',
      };
      const estimate = await client.request(`${opts.accountId}/delivery_estimate`, { params: estimateParams });

      console.log(formatOutput({
        audiences: results,
        combined_estimate: estimate.data,
        note: 'Combined estimate shows the merged audience reach. Compare with individual counts to gauge overlap.',
      }, opts.output as OutputFormat));
    }));

  audiences
    .command('delete <audienceId>')
    .description('Delete a custom audience')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const response = await client.request(audienceId, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // Pixel management
  const pixels = program.command('pixels').description('Pixel and conversion tracking');

  pixels
    .command('list')
    .description('List pixels for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,code,creation_time,data_use_setting,last_fired_time,is_created_by_app',
      };

      const response = await client.request(`${opts.accountId}/adspixels`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pixels
    .command('create')
    .description('Create a new tracking pixel')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Pixel name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = { name: opts.name };

      const response = await client.request(`${opts.accountId}/adspixels`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pixels
    .command('events <pixelId>')
    .description('Get pixel events')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pixelId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'data',
      };

      const response = await client.request(`${pixelId}/stats`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
