import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerPageCommands(program: Command, getClient: () => MetaClient): void {
  const pages = program.command('pages').description('Facebook Page management');

  pages
    .command('list')
    .description('List pages for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,category,fan_count,link,picture',
      };

      const response = await client.request('me/accounts', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('search <term>')
    .description('Search pages by name')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (term: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'page',
        q: term,
        fields: 'id,name,category,fan_count,link',
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
