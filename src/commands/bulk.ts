import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function registerBulkCommands(program: Command, getClient: () => MetaClient): void {
  const bulk = program.command('bulk').description('Bulk operations for campaigns, creatives, and optimization');

  bulk
    .command('create-campaigns')
    .description('Create multiple campaigns from a JSON config')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--config <json>', 'JSON array of campaign configs')
    .option('--batch-size <n>', 'Campaigns per batch', '5')
    .option('--delay-ms <ms>', 'Delay between batches', '2000')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const campaigns = JSON.parse(opts.config) as Array<Record<string, unknown>>;
      const batchSize = parseInt(opts.batchSize);
      const delayMs = parseInt(opts.delayMs);

      const results = { created: [] as unknown[], failed: [] as unknown[] };

      for (let i = 0; i < campaigns.length; i += batchSize) {
        if (i > 0) await sleep(delayMs);
        const batch = campaigns.slice(i, i + batchSize);

        const batchPromises = batch.map(async (config) => {
          try {
            const body: Record<string, string> = {
              name: String(config.name || ''),
              objective: String(config.objective || 'OUTCOME_TRAFFIC'),
              status: String(config.status || 'PAUSED'),
              special_ad_categories: JSON.stringify(config.special_ad_categories || []),
            };
            if (config.daily_budget) body.daily_budget = String(config.daily_budget);
            if (config.bid_strategy) body.bid_strategy = String(config.bid_strategy);

            const response = await client.request(`${opts.accountId}/campaigns`, { method: 'POST', body });
            return { success: true, name: config.name, data: response.data };
          } catch (err) {
            return { success: false, name: config.name, error: (err as Error).message };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        for (const r of batchResults) {
          if (r.success) results.created.push(r);
          else results.failed.push(r);
        }

        console.error(`Progress: ${Math.min(i + batchSize, campaigns.length)}/${campaigns.length}`);
      }

      console.log(formatOutput({
        total: campaigns.length,
        created: results.created.length,
        failed: results.failed.length,
        results,
      }, opts.output as OutputFormat));
    }));

  bulk
    .command('update-status')
    .description('Bulk update status for multiple objects')
    .requiredOption('--ids <ids>', 'Comma-separated object IDs')
    .requiredOption('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--delay-ms <ms>', 'Delay between requests', '500')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.ids.split(',').map((id: string) => id.trim());
      const results = { updated: [] as unknown[], failed: [] as unknown[] };

      for (const id of ids) {
        try {
          const response = await client.request(id, { method: 'POST', body: { status: opts.status } });
          results.updated.push({ id, data: response.data });
        } catch (err) {
          results.failed.push({ id, error: (err as Error).message });
        }
        if (parseInt(opts.delayMs) > 0) await sleep(parseInt(opts.delayMs));
      }

      console.log(formatOutput({
        total: ids.length,
        updated: results.updated.length,
        failed: results.failed.length,
        results,
      }, opts.output as OutputFormat));
    }));

  bulk
    .command('analyze')
    .description('Bulk performance analysis for multiple entities')
    .requiredOption('--ids <ids>', 'Comma-separated entity IDs')
    .option('--metrics <fields>', 'Metrics to fetch', 'impressions,clicks,spend,cpc,cpm,ctr,actions')
    .option('--time-range <range>', 'Time range', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.ids.split(',').map((id: string) => id.trim());
      const results: unknown[] = [];

      for (const id of ids) {
        try {
          const [entity, insights] = await Promise.all([
            client.request(id, { params: { fields: 'id,name,status' } }),
            client.request(`${id}/insights`, { params: { fields: opts.metrics } }),
          ]);
          results.push({
            entity: entity.data,
            insights: ((insights.data as Record<string, unknown>).data as unknown[])?.[0] || {},
          });
        } catch (err) {
          results.push({ id, error: (err as Error).message });
        }
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bulk
    .command('upload-creatives')
    .description('Bulk upload image creatives from URLs')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--images <json>', 'JSON array of {url, name} objects')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const images = JSON.parse(opts.images) as Array<{ url: string; name?: string }>;
      const results = { uploaded: [] as unknown[], failed: [] as unknown[] };

      for (const img of images) {
        try {
          const body: Record<string, string> = { url: img.url };
          if (img.name) body.name = img.name;
          const response = await client.request(`${opts.accountId}/adimages`, { method: 'POST', body });
          results.uploaded.push({ url: img.url, data: response.data });
        } catch (err) {
          results.failed.push({ url: img.url, error: (err as Error).message });
        }
        await sleep(500);
      }

      console.log(formatOutput({
        total: images.length,
        uploaded: results.uploaded.length,
        failed: results.failed.length,
        results,
      }, opts.output as OutputFormat));
    }));
}
