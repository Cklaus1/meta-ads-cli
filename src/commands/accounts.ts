import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerAccountCommands(program: Command, getClient: () => MetaClient): void {
  const accounts = program.command('accounts').description('Ad account management');

  accounts
    .command('list')
    .description('List ad accounts accessible by current user')
    .option('--limit <n>', 'Maximum number of accounts', '200')
    .option('--user-id <id>', 'User ID (default: me)', 'me')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format: json, table, csv, text, yaml', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code',
        limit: opts.limit,
      };

      const endpoint = `${opts.userId}/adaccounts`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('get <accountId>')
    .description('Get detailed info for a specific ad account')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      // Ensure act_ prefix
      const id = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
      const params: Record<string, string> = {
        fields: 'id,name,account_id,account_status,amount_spent,balance,currency,age,business_city,business_country_code,timezone_name,spend_cap,funding_source_details',
      };

      const response = await client.request(id, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  accounts
    .command('activity <accountId>')
    .description('Get activity log (audit trail) for an ad account')
    .option('--limit <n>', 'Maximum entries', '25')
    .option('--since <timestamp>', 'Start Unix timestamp')
    .option('--until <timestamp>', 'End Unix timestamp')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (accountId: string, opts) => {
      const client = getClient();
      const id = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
      const params: Record<string, string> = {
        fields: 'actor_id,actor_name,event_type,event_time,extra_data,object_id,object_name,translated_event_type',
        limit: opts.limit,
      };
      if (opts.since) params.since = opts.since;
      if (opts.until) params.until = opts.until;

      const endpoint = `${id}/activities`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
