import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { resolveTimeRange } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const BREAKDOWN_HELP = 'Breakdowns (comma-separated): age, gender, country, region, comscore_market, publisher_platform, platform_position, device_platform, impression_device (needs Meta enablement)';

/** Breakdown names Meta rejects, with what to use instead. */
const RENAMED_BREAKDOWNS: Record<string, string> = {
  dma: 'dma was replaced by comscore_market',
  device: 'use device_platform (or impression_device, which needs Meta enablement)',
  platform: 'use publisher_platform',
};

export function validateBreakdowns(value: string): string {
  const list = value.split(',').map(b => b.trim()).filter(Boolean);
  for (const b of list) {
    if (RENAMED_BREAKDOWNS[b]) throw new Error(`Invalid breakdown "${b}": ${RENAMED_BREAKDOWNS[b]}.`);
  }
  return list.join(',');
}

const ATTRIBUTION_WINDOWS = ['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev'];

/** Validate --attribution-windows into Meta's action_attribution_windows JSON. */
export function parseAttributionWindows(value: string): string {
  const list = value.split(',').map(w => w.trim()).filter(Boolean);
  for (const w of list) {
    if (w === '7d_view' || w === '28d_view') {
      throw new Error(`Attribution window ${w} is no longer supported: Meta returns no data for view windows over 1 day (since 2026-01-12). Use 1d_view.`);
    }
    if (!ATTRIBUTION_WINDOWS.includes(w)) {
      throw new Error(`Unknown attribution window "${w}". Use: ${ATTRIBUTION_WINDOWS.join(', ')}`);
    }
  }
  if (list.length === 0) throw new Error('--attribution-windows needs at least one window');
  return JSON.stringify(list);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll an async insights report until it finishes. Returns the final status object. */
export async function waitForReport(
  client: MetaClient,
  reportRunId: string,
  opts: { pollMs: number; timeoutMs: number; onProgress?: (pct: number, status: string) => void },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const res = await client.request(reportRunId, {
      params: { fields: 'id,async_status,async_percent_completion,error_code,error_subcode,error_message,error_user_title,error_user_msg' },
    });
    const job = res.data as Record<string, unknown>;
    const status = String(job.async_status || '');
    if (status === 'Job Completed') return job;
    if (status === 'Job Failed' || status === 'Job Skipped') {
      const detail = [job.error_user_title, job.error_user_msg || job.error_message].filter(Boolean).join(': ');
      throw new Error(`Async insights report ${reportRunId} ${status.toLowerCase().replace('job ', '')}${detail ? `: ${detail}` : ''}`
        + (job.error_code ? ` (code ${job.error_code}${job.error_subcode ? `/${job.error_subcode}` : ''})` : ''));
    }
    opts.onProgress?.(Number(job.async_percent_completion) || 0, status);
    if (Date.now() >= deadline) {
      throw new Error(`Async insights report ${reportRunId} still running after ${Math.round(opts.timeoutMs / 1000)}s. `
        + `Check later with: meta-ads insights async-result ${reportRunId}`);
    }
    await sleep(opts.pollMs);
  }
}

export function registerInsightCommands(program: Command, getClient: () => MetaClient): void {
  const insights = program.command('insights').description('Performance analytics and reporting');

  insights
    .command('get <objectId>')
    .description('Get performance insights for any object (account, campaign, adset, ad)')
    .option('--time-range <range>', 'Time range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_30d')
    .option('--date-start <date>', 'Custom date range start (YYYY-MM-DD)')
    .option('--date-end <date>', 'Custom date range end (YYYY-MM-DD)')
    .option('--breakdown <breakdown>', BREAKDOWN_HELP)
    .option('--attribution-windows <windows>', `Comma-separated attribution windows (${ATTRIBUTION_WINDOWS.join(', ')})`)
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
        params.breakdowns = validateBreakdowns(opts.breakdown);
      }
      if (opts.attributionWindows) {
        params.action_attribution_windows = parseAttributionWindows(opts.attributionWindows);
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
    .option('--breakdown <breakdown>', BREAKDOWN_HELP)
    .option('--attribution-windows <windows>', `Comma-separated attribution windows (${ATTRIBUTION_WINDOWS.join(', ')})`)
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
        params.breakdowns = validateBreakdowns(opts.breakdown);
      }
      if (opts.attributionWindows) {
        params.action_attribution_windows = parseAttributionWindows(opts.attributionWindows);
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

  insights
    .command('async <objectId>')
    .description('Run an asynchronous insights report (for large breakdowns or long ranges) and wait for the result')
    .option('--time-range <range>', 'Time range: today, yesterday, last_7d, last_30d, last_90d, this_month, last_month, maximum', 'last_30d')
    .option('--date-start <date>', 'Custom date range start (YYYY-MM-DD)')
    .option('--date-end <date>', 'Custom date range end (YYYY-MM-DD)')
    .option('--breakdown <breakdown>', BREAKDOWN_HELP)
    .option('--attribution-windows <windows>', `Comma-separated attribution windows (${ATTRIBUTION_WINDOWS.join(', ')})`)
    .option('--level <level>', 'Level of aggregation: account, campaign, adset, ad', 'ad')
    .option('--fields <fields>', 'Comma-separated metric fields')
    .option('--poll-interval <seconds>', 'Seconds between status checks', '5')
    .option('--timeout <seconds>', 'Give up waiting after this many seconds (the report keeps running)', '600')
    .option('--no-wait', 'Start the report and print its report_run_id without waiting')
    .option('--all', 'Fetch all result pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();
      const pollSec = Number(opts.pollInterval);
      const timeoutSec = Number(opts.timeout);
      if (!Number.isFinite(pollSec) || pollSec < 0) throw new Error('--poll-interval must be a non-negative number of seconds');
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('--timeout must be a positive number of seconds');

      const body: Record<string, string> = {
        fields: opts.fields || 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,purchase_roas,date_start,date_stop',
        level: opts.level,
      };
      if (opts.dateStart && opts.dateEnd) {
        body.time_range = JSON.stringify({ since: opts.dateStart, until: opts.dateEnd });
      } else {
        const resolved = resolveTimeRange(opts.timeRange);
        if (resolved) body.time_range = resolved;
        else body.date_preset = 'maximum';
      }
      if (opts.breakdown) body.breakdowns = validateBreakdowns(opts.breakdown);
      if (opts.attributionWindows) body.action_attribution_windows = parseAttributionWindows(opts.attributionWindows);

      const started = await client.request(`${objectId}/insights`, { method: 'POST', body });
      const reportRunId = (started.data as { report_run_id?: string }).report_run_id;
      if (!reportRunId) {
        // Dry-run, or Meta returned no job.
        console.log(formatOutput(started.data, opts.output as OutputFormat));
        return;
      }
      if (!opts.wait) {
        console.log(formatOutput({ report_run_id: reportRunId, next: `meta-ads insights async-result ${reportRunId}` }, opts.output as OutputFormat));
        return;
      }

      await waitForReport(client, reportRunId, {
        pollMs: pollSec * 1000,
        timeoutMs: timeoutSec * 1000,
        onProgress: (pct, status) => console.error(`Report ${reportRunId}: ${status} (${pct}%)`),
      });
      const endpoint = `${reportRunId}/insights`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, {}, opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint);
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  insights
    .command('async-result <reportRunId>')
    .description('Check an async insights report and print its results once complete')
    .option('--all', 'Fetch all result pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (reportRunId: string, opts) => {
      const client = getClient();
      // A zero timeout checks once: done → results, failed → error, else status.
      try {
        await waitForReport(client, reportRunId, { pollMs: 0, timeoutMs: 0 });
      } catch (err) {
        if ((err as Error).message.includes('still running')) {
          const status = await client.request(reportRunId, { params: { fields: 'id,async_status,async_percent_completion' } });
          console.log(formatOutput(status.data, opts.output as OutputFormat));
          return;
        }
        throw err;
      }
      const endpoint = `${reportRunId}/insights`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, {}, opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint);
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
