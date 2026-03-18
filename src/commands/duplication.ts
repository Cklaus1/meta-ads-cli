import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerDuplicationCommands(program: Command, getClient: () => MetaClient): void {
  const dup = program.command('duplicate').alias('dup').description('Campaign, ad set, and ad duplication');

  dup
    .command('campaign <campaignId>')
    .description('Duplicate a campaign')
    .option('--name-suffix <suffix>', 'Suffix for duplicated name', ' - Copy')
    .option('--status <status>', 'Status for duplicated campaign', 'PAUSED')
    .option('--deep-copy', 'Include ad sets and ads in duplication')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();

      // Get original campaign
      const origParams: Record<string, string> = {
        fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,buying_type',
      };
      const origResponse = await client.request(campaignId, { params: origParams });
      const original = origResponse.data as Record<string, unknown>;

      // Create duplicate
      const accountId = original.id ? String(original.id).split('_')[0] : '';
      const body: Record<string, string> = {
        name: `${original.name}${opts.nameSuffix}`,
        objective: String(original.objective || ''),
        status: opts.status,
        special_ad_categories: JSON.stringify(original.special_ad_categories || []),
      };
      if (original.daily_budget) body.daily_budget = String(original.daily_budget);
      if (original.lifetime_budget) body.lifetime_budget = String(original.lifetime_budget);
      if (original.bid_strategy) body.bid_strategy = String(original.bid_strategy);

      // Copy campaign via the API's built-in copies endpoint
      const copyBody: Record<string, string> = {
        status_option: opts.status,
      };
      if (opts.deepCopy) {
        copyBody.deep_copy = 'true';
      }

      const response = await client.request(`${campaignId}/copies`, {
        method: 'POST',
        body: copyBody,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  dup
    .command('adset <adsetId>')
    .description('Duplicate an ad set')
    .option('--campaign-id <id>', 'Target campaign ID (default: same campaign)')
    .option('--name-suffix <suffix>', 'Suffix for duplicated name', ' - Copy')
    .option('--status <status>', 'Status for duplicated ad set', 'PAUSED')
    .option('--deep-copy', 'Include ads in duplication')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const copyBody: Record<string, string> = {
        status_option: opts.status,
      };
      if (opts.campaignId) {
        copyBody.campaign_id = opts.campaignId;
      }
      if (opts.deepCopy) {
        copyBody.deep_copy = 'true';
      }

      const response = await client.request(`${adsetId}/copies`, {
        method: 'POST',
        body: copyBody,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  dup
    .command('ad <adId>')
    .description('Duplicate an ad')
    .option('--adset-id <id>', 'Target ad set ID (default: same ad set)')
    .option('--name-suffix <suffix>', 'Suffix for duplicated name', ' - Copy')
    .option('--status <status>', 'Status for duplicated ad', 'PAUSED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const copyBody: Record<string, string> = {
        status_option: opts.status,
      };
      if (opts.adsetId) {
        copyBody.adset_id = opts.adsetId;
      }

      const response = await client.request(`${adId}/copies`, {
        method: 'POST',
        body: copyBody,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  dup
    .command('creative <creativeId>')
    .description('Duplicate a creative with optional modifications')
    .option('--name-suffix <suffix>', 'Suffix for duplicated name', ' - Copy')
    .option('--new-headline <text>', 'Override headline')
    .option('--new-description <text>', 'Override description')
    .option('--new-cta <type>', 'Override call-to-action type')
    .option('--new-link-url <url>', 'Override destination URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      const client = getClient();

      // Get original creative
      const origParams: Record<string, string> = {
        fields: 'id,name,object_story_spec,asset_feed_spec,image_hash,call_to_action_type',
      };
      const origResponse = await client.request(creativeId, { params: origParams });
      const original = origResponse.data as Record<string, unknown>;

      // Build new creative based on original
      const body: Record<string, string> = {};
      body.name = `${original.name || 'Creative'}${opts.nameSuffix}`;

      if (original.object_story_spec) {
        const spec = original.object_story_spec as Record<string, unknown>;
        if (opts.newHeadline || opts.newDescription || opts.newCta || opts.newLinkUrl) {
          const linkData = (spec.link_data || {}) as Record<string, unknown>;
          if (opts.newHeadline) linkData.name = opts.newHeadline;
          if (opts.newDescription) linkData.description = opts.newDescription;
          if (opts.newLinkUrl) linkData.link = opts.newLinkUrl;
          if (opts.newCta) linkData.call_to_action = { type: opts.newCta };
          spec.link_data = linkData;
        }
        body.object_story_spec = JSON.stringify(spec);
      }

      // Get account ID from the creative
      const accountId = process.env.META_ADS_CLI_ACCOUNT_ID;
      if (!accountId) {
        throw new Error('Account ID required for creative duplication. Set META_ADS_CLI_ACCOUNT_ID');
      }

      const response = await client.request(`${accountId}/adcreatives`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
