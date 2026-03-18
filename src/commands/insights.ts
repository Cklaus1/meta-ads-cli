import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

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

      const defaultFields = 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,date_start,date_stop';
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
        const rangeMap: Record<string, { since: string; until: string }> = {};
        const now = new Date();
        const fmt = (d: Date) => d.toISOString().slice(0, 10);

        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);

        const ranges: Record<string, () => { since: string; until: string }> = {
          today: () => ({ since: fmt(now), until: fmt(now) }),
          yesterday: () => ({ since: fmt(yesterday), until: fmt(yesterday) }),
          last_7d: () => {
            const d = new Date(now);
            d.setDate(d.getDate() - 7);
            return { since: fmt(d), until: fmt(now) };
          },
          last_30d: () => {
            const d = new Date(now);
            d.setDate(d.getDate() - 30);
            return { since: fmt(d), until: fmt(now) };
          },
          last_90d: () => {
            const d = new Date(now);
            d.setDate(d.getDate() - 90);
            return { since: fmt(d), until: fmt(now) };
          },
          this_month: () => {
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            return { since: fmt(start), until: fmt(now) };
          },
          last_month: () => {
            const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const end = new Date(now.getFullYear(), now.getMonth(), 0);
            return { since: fmt(start), until: fmt(end) };
          },
        };

        if (opts.timeRange !== 'maximum' && ranges[opts.timeRange]) {
          params.time_range = JSON.stringify(ranges[opts.timeRange]());
        }
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
      // Delegate to the get command internally
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,date_start,date_stop',
        level: 'account',
      };
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

      const response = await client.request(`${adId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
