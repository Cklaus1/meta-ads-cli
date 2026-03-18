import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerInstagramCommands(program: Command, getClient: () => MetaClient): void {
  const instagram = program.command('instagram').alias('ig').description('Instagram Shopping and business profile management');

  instagram
    .command('sync-catalog')
    .description('Sync a product catalog to Instagram Business account')
    .requiredOption('--instagram-id <id>', 'Instagram Business account ID')
    .requiredOption('--catalog-id <id>', 'Product catalog ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      // Verify Instagram account
      const igParams: Record<string, string> = {
        fields: 'id,username,name,followers_count,is_business_account',
      };
      const igResponse = await client.request(opts.instagramId, { params: igParams });

      // Get catalog info
      const catParams: Record<string, string> = {
        fields: 'id,name,product_count,vertical',
      };
      const catResponse = await client.request(opts.catalogId, { params: catParams });

      // Setup catalog connection
      const response = await client.request(`${opts.instagramId}/product_catalogs`, {
        method: 'POST',
        body: { catalog_id: opts.catalogId },
      });

      console.log(formatOutput({
        instagram_account: igResponse.data,
        catalog: catResponse.data,
        sync_result: response.data,
      }, opts.output as OutputFormat));
    }));

  instagram
    .command('create-shopping-ad')
    .description('Create an Instagram Shopping ad')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--product-set-id <id>', 'Product set ID')
    .requiredOption('--instagram-id <id>', 'Instagram account ID')
    .option('--name <name>', 'Ad name')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const creativeBody: Record<string, string> = {
        name: opts.name ? `${opts.name} - Creative` : 'Shopping Creative',
        object_story_spec: JSON.stringify({
          instagram_actor_id: opts.instagramId,
          template_data: {
            product_set_id: opts.productSetId,
            call_to_action: { type: 'SHOP_NOW' },
          },
        }),
      };

      const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, { method: 'POST', body: creativeBody });
      const creativeId = (creativeResponse.data as Record<string, unknown>).id as string;

      const adBody: Record<string, string> = {
        name: opts.name || 'Instagram Shopping Ad',
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: opts.status,
      };

      const adResponse = await client.request(`${opts.accountId}/ads`, { method: 'POST', body: adBody });

      console.log(formatOutput({
        creative: creativeResponse.data,
        ad: adResponse.data,
      }, opts.output as OutputFormat));
    }));

  instagram
    .command('profile <instagramId>')
    .description('Get/manage Instagram Business profile')
    .option('--update-bio <text>', 'Update biography')
    .option('--update-website <url>', 'Update website URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();

      if (opts.updateBio || opts.updateWebsite) {
        const body: Record<string, string> = {};
        if (opts.updateBio) body.biography = opts.updateBio;
        if (opts.updateWebsite) body.website = opts.updateWebsite;
        const response = await client.request(instagramId, { method: 'POST', body });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        const params: Record<string, string> = {
          fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,is_business_account',
        };
        const response = await client.request(instagramId, { params });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  instagram
    .command('shopping-insights <instagramId>')
    .description('Get Instagram Shopping performance insights')
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,reach,profile_views,website_clicks',
        period: 'day',
        metric: 'impressions,reach,profile_views,website_clicks',
      };

      const response = await client.request(`${instagramId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
