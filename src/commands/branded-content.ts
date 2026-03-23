import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerBrandedContentCommands(program: Command, getClient: () => MetaClient): void {
  const bc = program.command('branded-content').alias('bc').description('Branded content: creator partnerships and influencer ads');

  bc
    .command('eligible-sponsors <instagramId>')
    .description('List brands that can sponsor this creator\'s content')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${instagramId}/branded_content_ad_permissions`, {
        params: { fields: 'id,username,name' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  bc
    .command('approve-creator')
    .description('Approve a creator to tag your brand in branded content')
    .requiredOption('--page-id <id>', 'Your brand\'s Page ID')
    .requiredOption('--creator-id <id>', 'Creator\'s Instagram user ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request(`${opts.pageId}/branded_content_ad_permissions`, {
        method: 'POST',
        body: { creator_id: opts.creatorId },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  bc
    .command('revoke-creator')
    .description('Revoke a creator\'s branded content permission')
    .requiredOption('--page-id <id>', 'Your brand\'s Page ID')
    .requiredOption('--creator-id <id>', 'Creator\'s Instagram user ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request(`${opts.pageId}/branded_content_ad_permissions`, {
        method: 'DELETE',
        params: { creator_id: opts.creatorId },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  bc
    .command('boost-post')
    .description('Boost a creator\'s branded content post as an ad')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--post-id <id>', 'Creator\'s post ID (branded content)')
    .requiredOption('--adset-id <id>', 'Ad set ID for the boosted ad')
    .option('--name <name>', 'Ad name', 'Branded Content Ad')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Create creative from the branded content post
      const creativeBody: Record<string, string> = {
        name: `${opts.name} - Creative`,
        object_story_id: opts.postId,
      };
      const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body: creativeBody,
      });
      const creativeId = (creativeResponse.data as Record<string, unknown>).id as string;

      // Create ad
      const adBody: Record<string, string> = {
        name: opts.name,
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: opts.status,
      };
      const adResponse = await client.request(`${opts.accountId}/ads`, { method: 'POST', body: adBody });

      console.log(formatOutput({ creative: creativeResponse.data, ad: adResponse.data }, opts.output as OutputFormat));
    }));

  bc
    .command('search-creators')
    .description('Search for creators available for branded content partnerships')
    .requiredOption('--query <term>', 'Search term (creator name or niche)')
    .option('--platform <platform>', 'Platform: instagram, facebook', 'instagram')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request('search', {
        params: {
          type: 'adTargetingCategory',
          class: 'interests',
          q: opts.query,
        },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
