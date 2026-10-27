import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { insightsTimeParams } from '../time-range.js';
import { parseJsonInput } from '../json-input.js';
import { deriveMetrics, resultEventFor, actionValue } from '../metrics.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const BREAKDOWN_HELP = 'Breakdowns (comma-separated): age, gender, country, region, comscore_market, publisher_platform, platform_position, device_platform, '
  + 'hourly_stats_aggregated_by_advertiser_time_zone, product_id, user_segment_key, '
  + 'body_asset, title_asset, image_asset, video_asset, description_asset, call_to_action_asset, link_url_asset, ad_format_asset, '
  + 'impression_device (needs Meta enablement)';

/** Meta date_preset values (resolved by Meta in the ad account's timezone). */
export const META_DATE_PRESETS = [
  'today', 'yesterday', 'this_month', 'last_month', 'this_quarter', 'maximum', 'data_maximum',
  'last_3d', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d',
  'last_week_mon_sun', 'last_week_sun_sat', 'last_quarter', 'last_year',
  'this_week_mon_today', 'this_week_sun_today', 'this_year',
];

export const TIME_RANGE_HELP = `Named range, sent to Meta as date_preset and resolved in the ad account's timezone: ${META_DATE_PRESETS.join(', ')}`;

/**
 * Time params for insights: --since/--until (or the older --date-start/--date-end)
 * win; otherwise the named range goes to Meta as date_preset.
 */
export function timeParams(range?: string, since?: string, until?: string): Record<string, string> {
  if (since || until) return insightsTimeParams(undefined, since, until);
  if (range && META_DATE_PRESETS.includes(range)) return { date_preset: range };
  return insightsTimeParams(range);
}

/** Default insights fields: link clicks (not all clicks), revenue and the attribution used. */
export const DEFAULT_INSIGHT_FIELDS = [
  'impressions', 'reach', 'frequency', 'spend', 'cpm',
  'clicks', 'ctr', 'cpc', 'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click', 'outbound_clicks',
  'actions', 'action_values', 'cost_per_action_type', 'purchase_roas',
  'attribution_setting', 'date_start', 'date_stop',
].join(',');

const LEVEL_ID_FIELDS: Record<string, string[]> = {
  account: ['account_id', 'account_name'],
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['adset_id', 'adset_name'],
  ad: ['ad_id', 'ad_name'],
};

/** Add fields without duplicates. */
export function withFields(fields: string, ...extra: string[]): string {
  const list = fields.split(',').map(f => f.trim()).filter(Boolean);
  for (const f of extra) if (!list.includes(f)) list.push(f);
  return list.join(',');
}

/** Validate --time-increment: 1-90 days, monthly or all_days. */
export function parseTimeIncrement(value: string): string {
  if (value === 'monthly' || value === 'all_days') return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    throw new Error(`--time-increment must be 1-90 (days), monthly or all_days, got: "${value}"`);
  }
  return String(n);
}

/** Validate --sort into Meta's one-element sort list, e.g. spend_descending. */
export function parseSort(value: string): string {
  if (!/^[A-Za-z0-9_.:]+_(ascending|descending)$/.test(value)) {
    throw new Error(`--sort must look like <field>_ascending or <field>_descending (e.g. spend_descending), got: "${value}"`);
  }
  return JSON.stringify([value]);
}

/** Validate --filtering JSON (inline, @file or -) into Meta's filter list. */
export function parseFiltering(value: string): string {
  const list = parseJsonInput<unknown>(value, '--filtering');
  const arr = Array.isArray(list) ? list : [list];
  for (const f of arr) {
    const o = f as Record<string, unknown>;
    if (!o || typeof o.field !== 'string' || typeof o.operator !== 'string' || o.value === undefined) {
      throw new Error('--filtering: each filter needs field, operator and value, e.g. [{"field":"campaign.name","operator":"CONTAIN","value":"Prospecting"}]');
    }
  }
  return JSON.stringify(arr);
}

/** Add result/cost-per-result/revenue/ROAS columns, using each row's objective and optimization goal. */
export function addDerivedColumns(rows: Array<Record<string, unknown>>, resultEvent?: string): Array<Record<string, unknown>> {
  return rows.map(row => {
    const event = resultEvent || resultEventFor({
      objective: row.objective as string | undefined,
      optimizationGoal: row.optimization_goal as string | undefined,
    });
    const m = deriveMetrics(row, event);
    const purchases = actionValue(row.actions, 'purchase');
    return {
      ...row,
      result_event: m.result_event,
      results: m.results,
      cost_per_result: round(m.cost_per_result),
      revenue: round(m.revenue),
      roas: round(m.roas),
      aov: purchases > 0 && m.revenue > 0 ? round(m.revenue / purchases) : null,
    };
  });
}

function round(v: number | null, dp = 4): number | null {
  return v === null ? null : Number(v.toFixed(dp));
}

/** The window immediately before [since, until], of the same length. */
export function previousPeriod(since: string, until: string): { since: string; until: string } {
  const day = 86_400_000;
  const s = Date.parse(`${since}T00:00:00Z`);
  const u = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(u) || u < s) throw new Error(`Can't compute the previous period of ${since}..${until}`);
  const len = Math.round((u - s) / day) + 1;
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { since: fmt(s - len * day), until: fmt(s - day) };
}

const COMPARE_METRICS = ['spend', 'impressions', 'reach', 'frequency', 'cpm', 'ctr', 'cpc', 'inline_link_clicks', 'inline_link_click_ctr',
  'results', 'cost_per_result', 'revenue', 'roas'];

/**
 * Join current and previous-period rows on the level ID (plus breakdown
 * values) and add <metric>_prev and <metric>_change_pct columns.
 */
export function joinPreviousPeriod(
  current: Array<Record<string, unknown>>,
  previous: Array<Record<string, unknown>>,
  keyFields: string[],
): Array<Record<string, unknown>> {
  const key = (r: Record<string, unknown>) => keyFields.map(k => String(r[k] ?? '')).join('|');
  const prevByKey = new Map(previous.map(r => [key(r), r]));
  return current.map(row => {
    const prev = prevByKey.get(key(row));
    const out: Record<string, unknown> = { ...row };
    for (const m of COMPARE_METRICS) {
      if (row[m] === undefined) continue;
      const cur = Number(row[m]);
      const before = prev ? Number(prev[m]) : NaN;
      out[`${m}_prev`] = prev && Number.isFinite(before) ? before : null;
      out[`${m}_change_pct`] = prev && Number.isFinite(before) && before !== 0 && Number.isFinite(cur)
        ? Number((((cur - before) / before) * 100).toFixed(1))
        : null;
    }
    return out;
  });
}

interface InsightQueryOpts {
  timeRange?: string; since?: string; until?: string; dateStart?: string; dateEnd?: string;
  breakdown?: string; attributionWindows?: string; level?: string; fields?: string; limit?: string;
  timeIncrement?: string; actionBreakdowns?: string; filtering?: string; sort?: string;
  withDerived?: boolean; comparePrevious?: boolean; resultEvent?: string;
}

/** Build insights query params from the shared insights options. */
export function buildInsightParams(objectId: string, opts: InsightQueryOpts): Record<string, string> {
  // Account objects default to campaign rows; other objects report at their own level.
  const level = opts.level || (objectId.startsWith('act_') ? 'campaign' : undefined);
  let fields = opts.fields || DEFAULT_INSIGHT_FIELDS;
  if (level && LEVEL_ID_FIELDS[level]) fields = withFields(fields, ...LEVEL_ID_FIELDS[level]);
  if (opts.withDerived || opts.comparePrevious) {
    fields = withFields(fields, 'spend', 'impressions', 'reach', 'actions', 'action_values');
    if (level !== 'account') fields = withFields(fields, 'objective', 'optimization_goal');
  }
  const params: Record<string, string> = {
    fields,
    ...timeParams(opts.timeRange, opts.since ?? opts.dateStart, opts.until ?? opts.dateEnd),
  };
  if (level) params.level = level;
  if (opts.limit) params.limit = opts.limit;
  if (opts.breakdown) params.breakdowns = validateBreakdowns(opts.breakdown);
  if (opts.attributionWindows) params.action_attribution_windows = parseAttributionWindows(opts.attributionWindows);
  if (opts.timeIncrement) params.time_increment = parseTimeIncrement(opts.timeIncrement);
  if (opts.actionBreakdowns) {
    params.action_breakdowns = JSON.stringify(opts.actionBreakdowns.split(',').map(b => b.trim()).filter(Boolean));
    if (!params.fields.split(',').includes('actions')) params.fields = withFields(params.fields, 'actions');
  }
  if (opts.filtering) params.filtering = parseFiltering(opts.filtering);
  if (opts.sort) params.sort = parseSort(opts.sort);
  if (opts.comparePrevious && params.time_increment && params.time_increment !== 'all_days') {
    throw new Error('--compare-previous works on whole periods; drop --time-increment');
  }
  return params;
}

function rowsOf(data: unknown): Array<Record<string, unknown>> {
  const d = (data as Record<string, unknown>)?.data;
  return Array.isArray(d) ? d as Array<Record<string, unknown>> : [];
}

/**
 * Run an insights query with the shared options, then apply --with-derived
 * and --compare-previous. Returns the response data with rows replaced.
 */
export async function runInsights(
  client: MetaClient,
  objectId: string,
  opts: InsightQueryOpts & { all?: boolean; pageLimit?: string; after?: string },
): Promise<unknown> {
  const params = buildInsightParams(objectId, opts);
  if (opts.after) params.after = opts.after;
  const endpoint = `${objectId}/insights`;
  const fetchRows = (p: Record<string, string>) => (opts.all
    ? client.requestAllPages(endpoint, { params: p }, opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
    : client.request(endpoint, { params: p }));
  const response = await fetchRows(params);
  const data = response.data as Record<string, unknown>;
  let rows = rowsOf(data);
  if (rows.length === 0 || data.dryRun) return response.data;

  const derived = opts.withDerived || opts.comparePrevious;
  if (derived) rows = addDerivedColumns(rows, opts.resultEvent);

  if (opts.comparePrevious) {
    const first = rows[0];
    const since = String(first.date_start || '');
    const until = String(first.date_stop || '');
    const prev = previousPeriod(since, until);
    const prevParams: Record<string, string> = { ...params, time_range: JSON.stringify(prev) };
    delete prevParams.date_preset;
    delete prevParams.after;
    const prevResponse = await fetchRows(prevParams);
    const prevRows = addDerivedColumns(rowsOf(prevResponse.data), opts.resultEvent);
    const level = params.level || 'account';
    const keyFields = [...(LEVEL_ID_FIELDS[level] ? [LEVEL_ID_FIELDS[level][0]] : []),
      ...(params.breakdowns ? params.breakdowns.split(',') : [])];
    rows = joinPreviousPeriod(rows, prevRows, keyFields);
    return { ...data, data: rows, previous_period: prev };
  }
  return { ...data, data: rows };
}

/** Add the shared insights query options to a command. */
function addQueryOptions(cmd: Command, defaults: { timeRange: string; level?: string }): Command {
  return cmd
    .option('--time-range <range>', TIME_RANGE_HELP, defaults.timeRange)
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--date-start <date>', 'Alias of --since')
    .option('--date-end <date>', 'Alias of --until')
    .option('--breakdown <breakdown>', BREAKDOWN_HELP)
    .option('--attribution-windows <windows>', `Comma-separated attribution windows (${ATTRIBUTION_WINDOWS.join(', ')})`)
    .option('--time-increment <n>', 'Split rows by period: 1-90 days, monthly or all_days (e.g. 1 = daily, 7 = weekly)')
    .option('--action-breakdowns <list>', 'Comma-separated action breakdowns, e.g. action_type,action_device')
    .option('--filtering <json>', 'Filter list JSON (inline, @file or -), e.g. [{"field":"campaign.name","operator":"CONTAIN","value":"Prospecting"}]')
    .option('--sort <field_direction>', 'Sort, e.g. spend_descending or actions:link_click_ascending')
    .option('--with-derived', 'Add result_event, results, cost_per_result, revenue, roas and aov columns (result from each row\'s objective/optimization goal)')
    .option('--result-event <event>', 'Count this event as the result instead (purchase, lead, add_to_cart, complete_registration, app_install, landing_page_view, link_click, ...)')
    .option('--compare-previous', 'Add <metric>_prev and <metric>_change_pct columns for the previous period of the same length');
}

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

/** Start an async insights job; returns its report_run_id (undefined in dry-run). */
export async function startAsyncReport(client: MetaClient, objectId: string, body: Record<string, string>): Promise<string | undefined> {
  const started = await client.request(`${objectId}/insights`, { method: 'POST', body });
  const id = (started.data as { report_run_id?: string }).report_run_id;
  if (!id && !(started.data as { dryRun?: boolean }).dryRun) {
    throw new Error(`Meta did not return a report_run_id: ${JSON.stringify(started.data)}`);
  }
  return id;
}

export interface MmmRow {
  date: string; campaign_id: string; campaign_name: string; country: string; publisher_platform: string;
  spend: number; impressions: number; reach: number; link_clicks: number; results: number; revenue: number;
  currency: string; timezone: string;
}

/** Convert daily insights rows into long-format MMM rows. */
export function toMmmRows(rows: Array<Record<string, unknown>>, event: string, currency: string, timezone: string): MmmRow[] {
  return rows.map(r => {
    const m = deriveMetrics(r, event);
    return {
      date: String(r.date_start ?? ''),
      campaign_id: String(r.campaign_id ?? ''),
      campaign_name: String(r.campaign_name ?? ''),
      country: String(r.country ?? ''),
      publisher_platform: String(r.publisher_platform ?? ''),
      spend: m.spend,
      impressions: m.impressions,
      reach: m.reach,
      link_clicks: m.clicks,
      results: m.results,
      revenue: m.revenue,
      currency,
      timezone,
    };
  });
}

/** Group ad sets by attribution window; more than one group means account totals mix windows. */
export function attributionGroups(adsets: Array<Record<string, unknown>>): Array<{ attribution: string; adsets: number; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const a of adsets) {
    const spec = a.attribution_spec as Array<{ event_type?: string; window_days?: number }> | undefined;
    const label = Array.isArray(spec) && spec.length
      ? spec.map(w => `${w.window_days}d_${String(w.event_type || '').toLowerCase().replace('click_through', 'click').replace('view_through', 'view').replace('engaged_video_view', 'ev')}`).sort().join('+')
      : 'default (7d_click+1d_view)';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(String(a.name ?? a.id));
  }
  return [...groups.entries()].map(([attribution, names]) => ({ attribution, adsets: names.length, names }));
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

  addQueryOptions(insights
    .command('get <objectId>')
    .description('Get performance insights for any object (account, campaign, adset, ad)'), { timeRange: 'last_30d' })
    .option('--level <level>', 'Level of aggregation: account, campaign, adset, ad (default: campaign for accounts, else the object\'s own level)')
    .option('--fields <fields>', 'Comma-separated metric fields (default includes link clicks, revenue and attribution_setting)')
    .option('--limit <n>', 'Maximum number of results', '25')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();
      const data = await runInsights(client, objectId, opts);
      console.log(formatOutput(data, opts.output as OutputFormat));
    }));

  addQueryOptions(insights
    .command('account')
    .description('Get insights for the default ad account'), { timeRange: 'last_30d' })
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--level <level>', 'Level of aggregation: account, campaign, adset, ad', 'account')
    .option('--fields <fields>', 'Comma-separated metric fields')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const data = await runInsights(client, opts.accountId, opts);
      console.log(formatOutput(data, opts.output as OutputFormat));
    }));

  insights
    .command('video <adId>')
    .description('Get video performance metrics for an ad')
    .option('--time-range <range>', TIME_RANGE_HELP, 'maximum')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_avg_time_watched_actions,video_thruplay_watched_actions,actions,impressions,reach,spend',
        ...timeParams(opts.timeRange, opts.since, opts.until),
      };

      const response = await client.request(`${adId}/insights`, { params });
      // Hook rate = 3-second video views / impressions; hold rate = ThruPlays / 3-second views.
      const rows = rowsOf(response.data).map(row => {
        const impressions = Number(row.impressions) || 0;
        const threeSec = actionValue(row.actions, 'video_view');
        const thruplays = actionValue(row.video_thruplay_watched_actions, 'video_view');
        return {
          ...row,
          hook_rate_pct: impressions > 0 ? Number(((threeSec / impressions) * 100).toFixed(2)) : null,
          hold_rate_pct: threeSec > 0 ? Number(((thruplays / threeSec) * 100).toFixed(2)) : null,
        };
      });
      console.log(formatOutput(rows.length ? { ...(response.data as object), data: rows } : response.data, opts.output as OutputFormat));
    }));

  insights
    .command('async <objectId>')
    .description('Run an asynchronous insights report (for large breakdowns or long ranges) and wait for the result')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_30d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--date-start <date>', 'Alias of --since')
    .option('--date-end <date>', 'Alias of --until')
    .option('--breakdown <breakdown>', BREAKDOWN_HELP)
    .option('--attribution-windows <windows>', `Comma-separated attribution windows (${ATTRIBUTION_WINDOWS.join(', ')})`)
    .option('--time-increment <n>', 'Split rows by period: 1-90 days, monthly or all_days')
    .option('--action-breakdowns <list>', 'Comma-separated action breakdowns')
    .option('--filtering <json>', 'Filter list JSON (inline, @file or -)')
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

      const body = buildInsightParams(objectId, opts);

      const reportRunId = await startAsyncReport(client, objectId, body);
      if (!reportRunId) return; // dry-run: the request was printed
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

  insights
    .command('export-mmm')
    .description('Export a long-format daily dataset for media mix modelling: date × campaign × country (or × platform), via an async report')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_90d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--by <dimension>', 'Second dimension: country or publisher_platform (Meta doesn\'t combine them in one breakdown)', 'country')
    .option('--result-event <event>', 'Event to count as results/revenue', 'purchase')
    .option('--poll-interval <seconds>', 'Seconds between status checks', '5')
    .option('--timeout <seconds>', 'Give up waiting after this many seconds', '1800')
    .option('-o, --output <format>', 'Output format', 'csv')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      if (opts.by !== 'country' && opts.by !== 'publisher_platform') {
        throw new Error(`--by must be country or publisher_platform, got: "${opts.by}"`);
      }
      const client = getClient();
      const account = await client.request(opts.accountId, { params: { fields: 'currency,timezone_name' } });
      const acct = account.data as Record<string, string>;

      const body: Record<string, string> = {
        level: 'campaign',
        fields: 'campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,actions,action_values,date_start,date_stop',
        breakdowns: opts.by,
        time_increment: '1',
        ...timeParams(opts.timeRange, opts.since, opts.until),
      };
      const reportRunId = await startAsyncReport(client, opts.accountId, body);
      if (!reportRunId) return;
      await waitForReport(client, reportRunId, {
        pollMs: Number(opts.pollInterval) * 1000,
        timeoutMs: Number(opts.timeout) * 1000,
        onProgress: (pct, status) => console.error(`Report ${reportRunId}: ${status} (${pct}%)`),
      });
      // No page cap: MMM needs the full history.
      const result = await client.requestAllPages(`${reportRunId}/insights`, { params: { limit: '500' } }, 100_000);
      const rows = toMmmRows(rowsOf(result.data), opts.resultEvent, acct.currency || '', acct.timezone_name || '');
      console.log(formatOutput(rows, opts.output as OutputFormat));
    }));

  insights
    .command('attribution-audit')
    .description('List ad sets by attribution window and warn when account totals mix windows')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--include-paused', 'Include paused ad sets')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const params: Record<string, string> = { fields: 'id,name,attribution_spec,optimization_goal', limit: '200' };
      if (!opts.includePaused) params.effective_status = JSON.stringify(['ACTIVE']);
      const response = await client.requestAllPages(`${opts.accountId}/adsets`, { params });
      const groups = attributionGroups(rowsOf(response.data));
      console.log(formatOutput({
        account_id: opts.accountId,
        groups,
        mixed: groups.length > 1,
        note: groups.length > 1
          ? 'Ad sets use different attribution windows, so account-level results and CPA add up different definitions. Compare like with like (insights --attribution-windows) or align attribution_spec.'
          : 'All ad sets use the same attribution window.',
      }, opts.output as OutputFormat));
    }));
}
