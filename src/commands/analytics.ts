import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { actionValue, resultEventFor } from '../metrics.js';
import { runInsights, timeParams, TIME_RANGE_HELP, validateBreakdowns } from './insights.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

type Row = Record<string, unknown>;

const DAILY_FIELDS = 'impressions,reach,spend,inline_link_clicks,actions,action_values,objective,optimization_goal,date_start,date_stop';

/** Map the legacy --days flag to a Meta preset (resolved in the account timezone, excluding today). */
export function daysToPreset(days: string): string {
  const presets: Record<string, string> = { '3': 'last_3d', '7': 'last_7d', '14': 'last_14d', '28': 'last_28d', '30': 'last_30d', '90': 'last_90d' };
  const preset = presets[String(days)];
  if (!preset) throw new Error(`--days must be 3, 7, 14, 28, 30 or 90 (use --since/--until for other windows), got: "${days}"`);
  return preset;
}

export interface WindowTotals {
  days: number; spend: number; impressions: number; link_clicks: number; results: number; revenue: number;
  cpm: number | null; link_ctr: number | null; cpc: number | null; cost_per_result: number | null; roas: number | null;
  hook_rate: number | null;
}

/**
 * Sum a window of daily rows, then compute ratios from the sums (averaging
 * daily ratios over-weights low-volume days).
 */
export function aggregate(rows: Row[], event: string): WindowTotals {
  let spend = 0, impressions = 0, clicks = 0, results = 0, revenue = 0, threeSec = 0;
  for (const r of rows) {
    spend += Number(r.spend) || 0;
    impressions += Number(r.impressions) || 0;
    clicks += Number(r.inline_link_clicks) || 0;
    results += event === 'reach' ? Number(r.reach) || 0 : actionValue(r.actions, event);
    revenue += actionValue(r.action_values, event === 'reach' ? 'purchase' : event);
    threeSec += actionValue(r.actions, 'video_view');
  }
  const ratio = (a: number, b: number, k = 1) => (b > 0 ? Number(((a / b) * k).toFixed(4)) : null);
  return {
    days: rows.length, spend: Number(spend.toFixed(2)), impressions, link_clicks: clicks, results, revenue: Number(revenue.toFixed(2)),
    cpm: ratio(spend, impressions, 1000),
    link_ctr: ratio(clicks, impressions, 100),
    cpc: ratio(spend, clicks),
    cost_per_result: results > 0 ? ratio(spend, results) : null,
    roas: revenue > 0 ? ratio(revenue, spend) : null,
    hook_rate: threeSec > 0 ? ratio(threeSec, impressions, 100) : null,
  };
}

function changePct(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return Number((((after - before) / before) * 100).toFixed(1));
}

/** Compare two windows metric by metric; null where either side lacks volume. */
export function compareWindows(before: WindowTotals, after: WindowTotals, minImpressions: number) {
  const enough = before.impressions >= minImpressions && after.impressions >= minImpressions;
  const out: Record<string, { before: number | null; after: number | null; change_pct: number | null; direction: string }> = {};
  const lowerIsBetter = new Set(['cpm', 'cpc', 'cost_per_result']);
  for (const k of ['spend', 'cpm', 'link_ctr', 'cpc', 'cost_per_result', 'roas', 'hook_rate'] as const) {
    const change = enough ? changePct(before[k], after[k]) : null;
    let direction = change === null ? 'insufficient_data' : Math.abs(change) < 10 ? 'stable' : change > 0 ? 'up' : 'down';
    if (change !== null && k !== 'spend' && direction !== 'stable') {
      const good = lowerIsBetter.has(k) ? change < 0 : change > 0;
      direction += good ? ' (better)' : ' (worse)';
    }
    out[k] = { before: before[k], after: after[k], change_pct: change, direction };
  }
  return out;
}

function rowsOf(data: unknown): Row[] {
  const d = (data as Row)?.data;
  return Array.isArray(d) ? d as Row[] : [];
}

function eventOf(rows: Row[], resultEvent?: string): string {
  const first = rows.find(r => r.objective || r.optimization_goal) || {};
  return resultEvent || resultEventFor({ objective: first.objective as string, optimizationGoal: first.optimization_goal as string });
}

export interface FatigueOpts { ctrDrop: number; cprRise: number; maxFrequency: number; minImpressions: number; minResults: number }

/**
 * Fatigue for one ad: launch week vs the latest week on link CTR, cost per
 * result and hook rate, plus lifetime (cumulative) frequency. Needs volume
 * in both windows before it calls anything.
 */
export function assessFatigue(daily: Row[], lifetime: Row | undefined, event: string, o: FatigueOpts) {
  const delivered = daily.filter(r => (Number(r.impressions) || 0) > 0)
    .sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));
  const signals: string[] = [];
  const lifetimeFrequency = lifetime && Number(lifetime.reach) > 0
    ? Number((Number(lifetime.impressions) / Number(lifetime.reach)).toFixed(2))
    : null;
  if (delivered.length < 14) {
    return { status: 'insufficient_data', signals: [`Need 14 days of delivery to compare launch vs latest week, have ${delivered.length}`], lifetime_frequency: lifetimeFrequency };
  }
  const launch = aggregate(delivered.slice(0, 7), event);
  const latest = aggregate(delivered.slice(-7), event);
  if (launch.impressions < o.minImpressions || latest.impressions < o.minImpressions) {
    return { status: 'insufficient_data', signals: [`Each week needs ${o.minImpressions}+ impressions`], launch, latest, lifetime_frequency: lifetimeFrequency };
  }
  const ctrChange = changePct(launch.link_ctr, latest.link_ctr);
  if (ctrChange !== null && ctrChange <= -o.ctrDrop) signals.push(`Link CTR down ${Math.abs(ctrChange)}% vs launch week`);
  if (launch.results >= o.minResults && latest.results >= o.minResults) {
    const cprChange = changePct(launch.cost_per_result, latest.cost_per_result);
    if (cprChange !== null && cprChange >= o.cprRise) signals.push(`Cost per ${event} up ${cprChange}% vs launch week`);
  }
  const hookChange = changePct(launch.hook_rate, latest.hook_rate);
  if (hookChange !== null && hookChange <= -o.ctrDrop) signals.push(`Hook rate (3s views / impressions) down ${Math.abs(hookChange)}%`);
  const performanceDecline = signals.length > 0;
  if (lifetimeFrequency !== null && lifetimeFrequency > o.maxFrequency) {
    signals.push(`Lifetime frequency ${lifetimeFrequency} > ${o.maxFrequency}`);
  }
  // Frequency alone isn't fatigue; it supports a performance decline.
  const status = performanceDecline ? (lifetimeFrequency !== null && lifetimeFrequency > o.maxFrequency ? 'fatigued' : 'declining') : 'healthy';
  return { status, signals, launch, latest, lifetime_frequency: lifetimeFrequency };
}

export function registerAnalyticsCommands(program: Command, getClient: () => MetaClient): void {
  const analytics = program.command('analytics').description('Performance trends, creative fatigue and asset analysis');

  analytics
    .command('trends <objectId>')
    .description('Latest 7 days vs the previous 7 days (sums, not daily averages), with daily rows; excludes today')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_28d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--days <n>', 'Legacy: 3, 7, 14, 28, 30 or 90 (maps to last_<n>d)')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective)')
    .option('--min-impressions <n>', 'Minimum impressions per window to call a trend', '1000')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();
      const range = opts.days ? daysToPreset(opts.days) : opts.timeRange;
      const params: Record<string, string> = { fields: DAILY_FIELDS, time_increment: '1', ...timeParams(range, opts.since, opts.until) };
      const response = await client.requestAllPages(`${objectId}/insights`, { params });
      const daily = rowsOf(response.data).sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));
      if (daily.length < 2) {
        console.log(formatOutput(response.data, opts.output as OutputFormat));
        return;
      }
      const event = eventOf(daily, opts.resultEvent);
      const window = Math.min(7, Math.floor(daily.length / 2));
      const before = aggregate(daily.slice(-2 * window, -window), event);
      const after = aggregate(daily.slice(-window), event);
      console.log(formatOutput({
        object_id: objectId,
        result_event: event,
        window_days: window,
        trend_analysis: compareWindows(before, after, Number(opts.minImpressions)),
        previous_window: before,
        latest_window: after,
        period: { start: daily[0].date_start, end: daily[daily.length - 1].date_stop },
        daily_data: daily,
      }, opts.output as OutputFormat));
    }));

  analytics
    .command('creative-fatigue [adId]')
    .description('Detect creative fatigue: launch week vs latest week on link CTR, cost per result and hook rate, with lifetime frequency')
    .option('--account-id <id>', 'Scan every ad with delivery in this account instead of one ad')
    .option('--time-range <range>', 'Window for the daily series (Meta date_preset, excludes today)', 'last_90d')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective)')
    .option('--ctr-drop <pct>', 'Flag a link CTR / hook rate drop of at least this percent', '20')
    .option('--cpr-rise <pct>', 'Flag a cost-per-result rise of at least this percent', '25')
    .option('--max-frequency <n>', 'Lifetime frequency that, with a decline, marks the ad fatigued', '4')
    .option('--min-impressions <n>', 'Minimum impressions in each week', '1000')
    .option('--min-results <n>', 'Minimum results in each week to compare cost per result', '5')
    .option('--days <n>', 'Legacy alias for --time-range (3, 7, 14, 28, 30 or 90)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string | undefined, opts) => {
      if (!adId && !opts.accountId) throw new Error('Pass an ad ID or --account-id');
      const client = getClient();
      const fatigueOpts: FatigueOpts = {
        ctrDrop: Number(opts.ctrDrop), cprRise: Number(opts.cprRise), maxFrequency: Number(opts.maxFrequency),
        minImpressions: Number(opts.minImpressions), minResults: Number(opts.minResults),
      };
      const range = opts.days ? daysToPreset(opts.days) : opts.timeRange;
      const objectId = adId || opts.accountId;
      const level = adId ? undefined : 'ad';
      const dailyParams: Record<string, string> = {
        fields: `ad_id,ad_name,${DAILY_FIELDS}`, time_increment: '1', ...timeParams(range), limit: '500',
        ...(level ? { level } : {}),
      };
      const lifetimeParams: Record<string, string> = {
        fields: 'ad_id,impressions,reach', date_preset: 'maximum', limit: '500', ...(level ? { level } : {}),
      };
      const [dailyRes, lifetimeRes] = await Promise.all([
        client.requestAllPages(`${objectId}/insights`, { params: dailyParams }),
        client.requestAllPages(`${objectId}/insights`, { params: lifetimeParams }),
      ]);
      const byAd = new Map<string, Row[]>();
      for (const r of rowsOf(dailyRes.data)) {
        const id = String(r.ad_id ?? adId);
        if (!byAd.has(id)) byAd.set(id, []);
        byAd.get(id)!.push(r);
      }
      const lifetimeByAd = new Map(rowsOf(lifetimeRes.data).map(r => [String(r.ad_id ?? adId), r]));
      const results = [...byAd.entries()].map(([id, rows]) => {
        const event = eventOf(rows, opts.resultEvent);
        return { ad_id: id, ad_name: rows[0].ad_name, result_event: event, ...assessFatigue(rows, lifetimeByAd.get(id), event, fatigueOpts) };
      });
      const output = adId
        ? { ...(results[0] || { ad_id: adId, status: 'insufficient_data', signals: ['No delivery in the window'] }), method: 'launch-week vs latest-week, volume-gated' }
        : {
          account_id: opts.accountId,
          ads_checked: results.length,
          fatigued: results.filter(r => r.status === 'fatigued').length,
          declining: results.filter(r => r.status === 'declining').length,
          ads: results.sort((a, b) => (a.status === 'fatigued' ? -1 : 0) - (b.status === 'fatigued' ? -1 : 0)),
        };
      console.log(formatOutput(output, opts.output as OutputFormat));
    }));

  analytics
    .command('asset-performance <objectId>')
    .description('Per-asset results for Dynamic Creative / flexible ads (body, title, image, video, ...)')
    .requiredOption('--asset <type>', 'body_asset, title_asset, description_asset, image_asset, video_asset, call_to_action_asset, link_url_asset or ad_format_asset')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_30d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--result-event <event>', 'Event that counts as a result (asset breakdowns can\'t return the objective)', 'purchase')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const assets = ['body_asset', 'title_asset', 'description_asset', 'image_asset', 'video_asset', 'call_to_action_asset', 'link_url_asset', 'ad_format_asset'];
      if (!assets.includes(opts.asset)) throw new Error(`--asset must be one of: ${assets.join(', ')}`);
      const client = getClient();
      // Asset breakdowns only support impressions, clicks, spend, reach, actions and action_values.
      const data = await runInsights(client, objectId, {
        fields: 'impressions,clicks,spend,reach,actions,action_values',
        breakdown: opts.asset,
        timeRange: opts.timeRange,
        since: opts.since,
        until: opts.until,
        withDerived: true,
        resultEvent: opts.resultEvent,
        all: true,
      });
      const rows = rowsOf(data).sort((a, b) => (Number(b.results) || 0) - (Number(a.results) || 0));
      console.log(formatOutput(rows.length ? rows : data, opts.output as OutputFormat));
    }));

  analytics
    .command('competitive-intel')
    .description('List competitors\' active ads from the Ads Library (no spend or auction data)')
    .requiredOption('--page-ids <ids>', 'Comma-separated competitor page IDs')
    .option('--country <code>', 'Country code', 'US')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const pageIds = opts.pageIds.split(',');
      const results: unknown[] = [];

      for (const pageId of pageIds) {
        const params: Record<string, string> = {
          search_page_ids: JSON.stringify([pageId.trim()]),
          ad_reached_countries: JSON.stringify([opts.country]),
          ad_type: 'ALL',
          ad_active_status: 'ACTIVE',
          fields: 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,page_name,publisher_platforms,spend',
          limit: '25',
        };

        const response = await client.request('ads_archive', { params });
        const ads = (response.data as Record<string, unknown>).data as unknown[] || [];
        results.push({
          page_id: pageId.trim(),
          active_ads_count: ads.length,
          ads: ads.slice(0, 10), // Top 10
        });
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  analytics
    .command('report')
    .description('Performance report with results, cost per result and ROAS (same as insights get <account> --with-derived)')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_30d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--level <level>', 'Report level: account, campaign, adset, ad', 'campaign')
    .option('--breakdowns <dims>', 'Breakdown dimensions (age, gender, country, ...)')
    .option('--compare-previous', 'Add previous-period columns and % change')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const data = await runInsights(client, opts.accountId, {
        level: opts.level,
        timeRange: opts.timeRange,
        since: opts.since,
        until: opts.until,
        breakdown: opts.breakdowns ? validateBreakdowns(opts.breakdowns) : undefined,
        withDerived: true,
        comparePrevious: opts.comparePrevious,
        limit: '500',
        all: true,
      });
      console.log(formatOutput(data, opts.output as OutputFormat));
    }));

  analytics
    .command('optimization-insights')
    .description('Day-of-week pattern (spend, results, cost per result) and week-over-week trend from daily data')
    .option('--resource-type <type>', 'Level: campaign, adset, ad', 'campaign')
    .option('--resource-id <id>', 'Specific resource ID')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_28d')
    .option('--days <n>', 'Legacy: 3, 7, 14, 28, 30 or 90')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const entityId = opts.resourceId || opts.accountId;
      if (!entityId) throw new Error('Either --resource-id or --account-id required');
      const range = opts.days ? daysToPreset(opts.days) : opts.timeRange;

      // Account-level daily totals (or the resource's own), not one row per entity per day.
      const params: Record<string, string> = { fields: DAILY_FIELDS, time_increment: '1', ...timeParams(range) };
      const response = await client.requestAllPages(`${entityId}/insights`, { params });
      const daily = rowsOf(response.data).sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));
      const event = eventOf(daily, opts.resultEvent);

      const insights: Record<string, unknown> = { total_data_points: daily.length, result_event: event, patterns: [] as string[] };
      if (daily.length >= 14) {
        const byDow = new Map<number, Row[]>();
        for (const d of daily) {
          // Dates are calendar days in the account timezone; read them as UTC to avoid shifting.
          const dow = new Date(`${String(d.date_start)}T00:00:00Z`).getUTCDay();
          if (!byDow.has(dow)) byDow.set(dow, []);
          byDow.get(dow)!.push(d);
        }
        insights.day_of_week = [...byDow.entries()].sort((a, b) => a[0] - b[0]).map(([dow, rows]) => {
          const t = aggregate(rows, event);
          return {
            day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
            days: rows.length,
            avg_spend: Number((t.spend / rows.length).toFixed(2)),
            avg_results: Number((t.results / rows.length).toFixed(2)),
            cost_per_result: t.cost_per_result,
          };
        });
        const trend = compareWindows(aggregate(daily.slice(-14, -7), event), aggregate(daily.slice(-7), event), 1000);
        insights.week_over_week = trend;
        const cpr = trend.cost_per_result;
        if (cpr.direction.startsWith('down')) (insights.patterns as string[]).push(`Cost per ${event} improved ${Math.abs(cpr.change_pct ?? 0)}% week over week`);
        if (cpr.direction.startsWith('up')) (insights.patterns as string[]).push(`Cost per ${event} worsened ${cpr.change_pct}% week over week`);
        if (trend.link_ctr.direction.startsWith('down')) (insights.patterns as string[]).push('Link CTR is declining — check creative fatigue');
      } else {
        (insights.patterns as string[]).push('Need at least 14 days of data');
      }

      console.log(formatOutput(insights, opts.output as OutputFormat));
    }));
}
