import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { launchFailureMessage } from './workflows.js';
import { applyAdsetBudgetSharing } from './campaigns.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

function splitList(value: unknown): string[] {
  return String(value ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

/**
 * Build the campaign and ad set bodies for an Advantage+ catalog (dynamic)
 * retargeting campaign: people who triggered includeEvents for products in
 * the set within retentionDays, minus anyone who triggered excludeEvents.
 */
export function buildDynamicRetargetingBodies(o: {
  campaignName: string; objective: string; catalogId: string; productSetId: string; countries: string[];
  includeEvents: string[]; excludeEvents: string[]; retentionDays: number; conversionEvent: string;
}): { campaignBody: Record<string, string>; adsetBody: Record<string, string> } {
  if (o.includeEvents.length === 0) throw new Error('--include-events must list at least one event');
  const retentionSeconds = o.retentionDays * 86400;
  const rule = (event: string) => ({ retention_seconds: retentionSeconds, rule: { event: { eq: event } } });
  const audienceSpec: Record<string, unknown> = {
    product_set_id: o.productSetId,
    inclusions: o.includeEvents.map(rule),
  };
  if (o.excludeEvents.length) audienceSpec.exclusions = o.excludeEvents.map(rule);

  return {
    campaignBody: {
      name: o.campaignName,
      objective: o.objective,
      status: 'PAUSED',
      special_ad_categories: '[]',
      promoted_object: JSON.stringify({ product_catalog_id: o.catalogId }),
    },
    adsetBody: {
      name: `${o.campaignName} - Dynamic Retargeting`,
      optimization_goal: 'OFFSITE_CONVERSIONS',
      billing_event: 'IMPRESSIONS',
      status: 'PAUSED',
      promoted_object: JSON.stringify({ product_set_id: o.productSetId, custom_event_type: o.conversionEvent }),
      targeting: JSON.stringify({ geo_locations: { countries: o.countries }, product_audience_specs: [audienceSpec] }),
    },
  };
}

export function registerRetargetingCommands(program: Command, getClient: () => MetaClient): void {
  const retargeting = program.command('retargeting').alias('retar').description('Advanced retargeting audience and campaign strategies');

  retargeting
    .command('website-behavior')
    .description('Create website behavior-based retargeting audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--pixel-id <id>', 'Meta Pixel ID')
    .requiredOption('--name <name>', 'Audience name')
    .option('--retention-days <days>', 'Days to retain users (1-180)', '30')
    .option('--rule <json>', 'Custom audience rule as JSON')
    .option('--url-contains <url>', 'URL contains filter')
    .option('--exclude-converters', 'Exclude users who have converted')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const rule = opts.rule ? opts.rule : JSON.stringify({
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: opts.pixelId, type: 'pixel' }],
            retention_seconds: parseInt(opts.retentionDays) * 86400,
            filter: opts.urlContains ? {
              operator: 'and',
              filters: [{ field: 'url', operator: 'i_contains', value: opts.urlContains }],
            } : { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'PageView' }] },
          }],
        },
      });

      const body: Record<string, string> = {
        name: opts.name,
        subtype: 'WEBSITE',
        retention_days: opts.retentionDays,
        rule,
        pixel_id: opts.pixelId,
      };

      const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  retargeting
    .command('video-engagement')
    .description('Create video engagement retargeting audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Audience name')
    .option('--video-ids <ids>', 'Comma-separated video IDs')
    .option('--engagement-type <type>', 'Engagement: video_watched, video_completed, thruplayed', 'video_watched')
    .option('--retention-days <days>', 'Retention days', '30')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const body: Record<string, string> = {
        name: opts.name,
        subtype: 'ENGAGEMENT',
        description: `Video engagement audience: ${opts.engagementType}`,
        retention_days: opts.retentionDays,
      };

      if (opts.videoIds) {
        const rule = {
          inclusions: {
            operator: 'or',
            rules: [{
              object_id: opts.videoIds.split(','),
              event_sources: [{ type: 'video' }],
            }],
          },
        };
        body.rule = JSON.stringify(rule);
      }

      const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  retargeting
    .command('app-event')
    .description('Create app event retargeting audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Audience name')
    .requiredOption('--app-id <id>', 'App ID')
    .option('--event-name <event>', 'App event to target')
    .option('--retention-days <days>', 'Retention days', '30')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const rule: Record<string, unknown> = {
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: opts.appId, type: 'app' }],
            retention_seconds: parseInt(opts.retentionDays) * 86400,
          }],
        },
      };
      if (opts.eventName) {
        (rule.inclusions as Record<string, unknown[]>).rules[0] = {
          ...(rule.inclusions as Record<string, unknown[]>).rules[0] as Record<string, unknown>,
          filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: opts.eventName }] },
        };
      }

      const body: Record<string, string> = {
        name: opts.name,
        subtype: 'APP',
        retention_days: opts.retentionDays,
        rule: JSON.stringify(rule),
      };

      const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  retargeting
    .command('product')
    .description('Create product retargeting audience from catalog')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Audience name')
    .requiredOption('--product-set-id <id>', 'Product set ID')
    .option('--event-type <type>', 'Event: ViewContent, AddToCart, Purchase', 'ViewContent')
    .option('--retention-days <days>', 'Retention days', '14')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const body: Record<string, string> = {
        name: opts.name,
        subtype: 'CUSTOM',
        description: `Product retargeting: ${opts.eventType}`,
        product_set_id: opts.productSetId,
        retention_days: opts.retentionDays,
      };

      const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  retargeting
    .command('funnel')
    .description('Create multi-stage retargeting funnel (awareness → consideration → conversion)')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--pixel-id <id>', 'Meta Pixel ID')
    .requiredOption('--funnel-name <name>', 'Funnel name prefix')
    .option('--stages <json>', 'Funnel stages config as JSON array', '[{"name":"Visitors","event":"PageView","retention":30},{"name":"Engaged","event":"ViewContent","retention":14},{"name":"Cart","event":"AddToCart","retention":7}]')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const stages = JSON.parse(opts.stages) as Array<{ name: string; event: string; retention: number }>;
      const results: unknown[] = [];

      for (const stage of stages) {
        const rule = {
          inclusions: {
            operator: 'or',
            rules: [{
              event_sources: [{ id: opts.pixelId, type: 'pixel' }],
              retention_seconds: stage.retention * 86400,
              filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: stage.event }] },
            }],
          },
        };

        const body: Record<string, string> = {
          name: `${opts.funnelName} - ${stage.name}`,
          subtype: 'WEBSITE',
          retention_days: String(stage.retention),
          rule: JSON.stringify(rule),
          pixel_id: opts.pixelId,
        };

        const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
        results.push({ stage: stage.name, ...response.data as Record<string, unknown> });
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  retargeting
    .command('dynamic-campaign')
    .description('Setup a dynamic retargeting campaign with catalog products')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--campaign-name <name>', 'Campaign name')
    .requiredOption('--product-set-id <id>', 'Product set ID')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .option('--daily-budget <cents>', 'Daily budget in cents', '5000')
    .option('--budget-level <level>', 'Where the budget lives: campaign (CBO) or adset', 'campaign')
    .option('--adset-budget-sharing', 'With --budget-level adset, let ad sets share up to 20% of budget')
    .option('--countries <codes>', 'Comma-separated country codes for ad set targeting', 'US')
    .option('--objective <obj>', 'Campaign objective', 'OUTCOME_SALES')
    .option('--catalog-id <id>', 'Product catalog ID (looked up from the product set if omitted)')
    .option('--include-events <events>', 'Pixel events that make someone eligible (comma-separated)', 'ViewContent,AddToCart')
    .option('--exclude-events <events>', 'Pixel events that exclude someone (comma-separated, "" for none)', 'Purchase')
    .option('--retention-days <n>', 'How far back to look for those events (1-180)', '30')
    .option('--conversion-event <event>', 'Event the ad set optimizes for (custom_event_type)', 'PURCHASE')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const retentionDays = Number(opts.retentionDays);
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 180) {
        throw new Error(`--retention-days must be an integer from 1 to 180, got: "${opts.retentionDays}"`);
      }
      if (opts.budgetLevel !== 'campaign' && opts.budgetLevel !== 'adset') {
        throw new Error(`--budget-level must be "campaign" or "adset", got: "${opts.budgetLevel}"`);
      }
      const countries = String(opts.countries).split(',').map((c: string) => c.trim().toUpperCase()).filter(Boolean);
      if (countries.length === 0) throw new Error('--countries must list at least one country code');
      const client = getClient();
      const created: Record<string, string> = {};

      // Catalog ads need the catalog on the campaign; find it from the product set.
      let catalogId: string | undefined = opts.catalogId;
      if (!catalogId) {
        if (client.isDryRun()) {
          catalogId = '<catalog-id-from-product-set>';
        } else {
          const ps = await client.request(opts.productSetId, { params: { fields: 'product_catalog' } });
          catalogId = ((ps.data as Record<string, unknown>).product_catalog as Record<string, string> | undefined)?.id;
          if (!catalogId) throw new Error('Could not find the catalog for this product set. Pass --catalog-id.');
        }
      }

      const budgetBody = buildDynamicRetargetingBodies({
        campaignName: opts.campaignName,
        objective: opts.objective,
        catalogId,
        productSetId: opts.productSetId,
        countries,
        includeEvents: splitList(opts.includeEvents),
        excludeEvents: splitList(opts.excludeEvents),
        retentionDays,
        conversionEvent: String(opts.conversionEvent).toUpperCase(),
      });
      const campBody = budgetBody.campaignBody;
      const adsetBody = budgetBody.adsetBody;
      if (opts.budgetLevel === 'campaign') campBody.daily_budget = opts.dailyBudget;
      else adsetBody.daily_budget = opts.dailyBudget;
      applyAdsetBudgetSharing(campBody, opts.adsetBudgetSharing);

      try {
        const campResponse = await client.request(`${opts.accountId}/campaigns`, { method: 'POST', body: campBody });
        const campaignId = (campResponse.data as Record<string, unknown>).id as string;
        if (campaignId) created.campaign_id = campaignId;

        const adsetResponse = await client.request(`${opts.accountId}/adsets`, {
          method: 'POST',
          body: { ...adsetBody, campaign_id: campaignId },
        });

        console.log(formatOutput({
          campaign: campResponse.data,
          adset: adsetResponse.data,
          budget_level: opts.budgetLevel,
          catalog_id: catalogId,
          note: 'Dynamic retargeting campaign created. Add a catalog (template) creative and activate when ready.',
        }, opts.output as OutputFormat));
      } catch (err) {
        throw new Error(launchFailureMessage(err, created));
      }
    }));

  retargeting
    .command('frequency-optimization')
    .description('Setup frequency capping for retargeting campaigns')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .option('--max-impressions <n>', 'Max impressions per user', '3')
    .option('--interval-days <days>', 'Frequency cap interval in days', '7')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const adsetId = opts.adsetId as string;
      const client = getClient();
      const frequencyControlSpecs = [{
        event: 'IMPRESSIONS',
        interval_days: parseInt(opts.intervalDays),
        max_frequency: parseInt(opts.maxImpressions),
      }];

      const body: Record<string, string> = {
        frequency_control_specs: JSON.stringify(frequencyControlSpecs),
      };

      const response = await client.request(adsetId, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
