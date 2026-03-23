import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { resolveTimeRange } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerInsightCommands(program: Command, getClient: () => MetaClient): void {
  const insights = program.command('insights').description('Performance analytics and reporting');

  insights
    .command('get <objectId>')
    .description('Get performance insights for any object (account, campaign, adset, ad)')
    .option('--time-range <range>', 'Time range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_30d')
    .option('--date-start <date>', 'Custom date range start (YYYY-MM-DD)')
    .option('--date-end <date>', 'Custom date range end (YYYY-MM-DD)')
    .option('--breakdown <breakdown>', 'Breakdown: age, gender, country, device, platform, publisher_platform, impression_device')
    .option('--level <level>', 'Level of aggregation: account, campaign, adset, ad', 'ad')
    .option('--fields <fields>', 'Comma-separated metric fields')
    .option('--limit <n>', 'Maximum number of results', '25')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();

      const defaultFields = 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,purchase_roas,website_purchase_roas,date_start,date_stop';
      const params: Record<string, string> = {
        fields: opts.fields || defaultFields,
        limit: opts.limit,
        level: opts.level,
      };

      // Handle time range
      if (opts.dateStart && opts.dateEnd) {
        params.time_range = JSON.stringify({
          since: opts.dateStart,
          until: opts.dateEnd,
        });
      } else {
        const resolved = resolveTimeRange(opts.timeRange);
        if (resolved) params.time_range = resolved;
      }

      if (opts.breakdown) {
        params.breakdowns = opts.breakdown;
      }
      if (opts.after) {
        params.after = opts.after;
      }

      const endpoint = `${objectId}/insights`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  insights
    .command('account')
    .description('Get insights for the default ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('--breakdown <breakdown>', 'Breakdown dimension')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,purchase_roas,date_start,date_stop',
        level: 'account',
      };

      const resolved = resolveTimeRange(opts.timeRange);
      if (resolved) params.time_range = resolved;

      if (opts.breakdown) {
        params.breakdowns = opts.breakdown;
      }

      const response = await client.request(`${opts.accountId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  insights
    .command('video <adId>')
    .description('Get video performance metrics for an ad')
    .option('--time-range <range>', 'Time range', 'maximum')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions,video_thruplay_watched_actions,impressions,reach,spend',
      };

      const resolved = resolveTimeRange(opts.timeRange);
      if (resolved) params.time_range = resolved;

      const response = await client.request(`${adId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
