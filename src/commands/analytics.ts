import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAnalyticsCommands(program: Command, getClient: () => MetaClient): void {
  const analytics = program.command('analytics').description('Advanced performance analytics and trend analysis');

  analytics
    .command('trends <objectId>')
    .description('Analyze performance trends over time for a campaign/adset/ad')
    .option('--days <n>', 'Number of days to analyze', '30')
    .option('--metrics <fields>', 'Metrics to track', 'impressions,clicks,spend,cpc,cpm,ctr,actions')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - parseInt(opts.days));

      const params: Record<string, string> = {
        fields: opts.metrics,
        time_range: JSON.stringify({
          since: start.toISOString().slice(0, 10),
          until: now.toISOString().slice(0, 10),
        }),
        time_increment: '1', // Daily breakdown
      };

      const response = await client.request(`${objectId}/insights`, { params });
      const data = (response.data as Record<string, unknown>).data as unknown[] || [];

      // Calculate trend direction
      if (data.length >= 2) {
        const first = data[0] as Record<string, unknown>;
        const last = data[data.length - 1] as Record<string, unknown>;
        const trendAnalysis: Record<string, unknown> = {};

        for (const metric of ['spend', 'cpc', 'cpm', 'ctr']) {
          const valFirst = parseFloat(String(first[metric] || 0));
          const valLast = parseFloat(String(last[metric] || 0));
          if (valFirst > 0) {
            const change = ((valLast - valFirst) / valFirst) * 100;
            trendAnalysis[metric] = {
              start: valFirst,
              end: valLast,
              change_pct: change.toFixed(1) + '%',
              direction: change > 5 ? 'increasing' : change < -5 ? 'decreasing' : 'stable',
            };
          }
        }

        console.log(formatOutput({
          daily_data: data,
          trend_analysis: trendAnalysis,
          period: { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) },
        }, opts.output as OutputFormat));
      } else {
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  analytics
    .command('creative-fatigue <adId>')
    .description('Detect creative fatigue by analyzing CTR/frequency degradation')
    .option('--days <n>', 'Days to analyze', '14')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - parseInt(opts.days));

      const params: Record<string, string> = {
        fields: 'impressions,clicks,ctr,frequency,reach,spend,date_start,date_stop',
        time_range: JSON.stringify({
          since: start.toISOString().slice(0, 10),
          until: now.toISOString().slice(0, 10),
        }),
        time_increment: '1',
      };

      const response = await client.request(`${adId}/insights`, { params });
      const dailyData = (response.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      let fatigueDetected = false;
      let fatigueSignals: string[] = [];

      if (dailyData.length >= 3) {
        const firstHalf = dailyData.slice(0, Math.floor(dailyData.length / 2));
        const secondHalf = dailyData.slice(Math.floor(dailyData.length / 2));

        const avgCtrFirst = firstHalf.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / firstHalf.length;
        const avgCtrSecond = secondHalf.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / secondHalf.length;
        const avgFreqLast = parseFloat(String(dailyData[dailyData.length - 1].frequency || 0));

        if (avgCtrSecond < avgCtrFirst * 0.8) {
          fatigueDetected = true;
          fatigueSignals.push(`CTR declined ${((1 - avgCtrSecond / avgCtrFirst) * 100).toFixed(0)}% in second half`);
        }
        if (avgFreqLast > 3) {
          fatigueDetected = true;
          fatigueSignals.push(`High frequency: ${avgFreqLast.toFixed(1)} (>3.0 threshold)`);
        }
      }

      console.log(formatOutput({
        ad_id: adId,
        fatigue_detected: fatigueDetected,
        fatigue_signals: fatigueSignals,
        recommendation: fatigueDetected
          ? 'Consider refreshing creative or expanding audience to reduce frequency'
          : 'No significant fatigue detected',
        daily_data: dailyData,
      }, opts.output as OutputFormat));
    }));

  analytics
    .command('competitive-intel')
    .description('Get competitive intelligence from Ads Library tracking')
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
    .description('Generate a performance summary report')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('--level <level>', 'Report level: account, campaign', 'campaign')
    .option('--breakdowns <dims>', 'Breakdown dimensions (age, gender, country)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const params: Record<string, string> = {
        fields: 'campaign_name,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type',
        level: opts.level,
        limit: '100',
      };
      if (opts.breakdowns) params.breakdowns = opts.breakdowns;

      const response = await client.request(`${opts.accountId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  analytics
    .command('optimization-insights')
    .description('Get meta-cognition insights from past optimization patterns')
    .option('--resource-type <type>', 'Resource type: campaign, adset, ad')
    .option('--resource-id <id>', 'Specific resource ID')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--days <n>', 'Days to analyze', '30')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const entityId = opts.resourceId || opts.accountId;
      if (!entityId) throw new Error('Either --resource-id or --account-id required');

      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - parseInt(opts.days));

      // Get daily performance data
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,date_start,date_stop',
        time_range: JSON.stringify({
          since: start.toISOString().slice(0, 10),
          until: now.toISOString().slice(0, 10),
        }),
        time_increment: '1',
        level: opts.resourceType || 'campaign',
      };

      const response = await client.request(`${entityId}/insights`, { params });
      const dailyData = (response.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      // Analyze patterns
      const insights: Record<string, unknown> = {
        total_data_points: dailyData.length,
        patterns: [] as string[],
      };

      if (dailyData.length >= 7) {
        // Day-of-week analysis
        const dowSpend: Record<number, number[]> = {};
        for (const d of dailyData) {
          const dow = new Date(String(d.date_start)).getDay();
          if (!dowSpend[dow]) dowSpend[dow] = [];
          dowSpend[dow].push(parseFloat(String(d.spend || 0)));
        }
        const dowAvg = Object.entries(dowSpend).map(([dow, vals]) => ({
          day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parseInt(dow)],
          avg_spend: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
        }));
        insights.day_of_week_spend = dowAvg;

        // Trend detection
        const firstWeek = dailyData.slice(0, 7);
        const lastWeek = dailyData.slice(-7);
        const avgCtrFirst = firstWeek.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / 7;
        const avgCtrLast = lastWeek.reduce((s, d) => s + parseFloat(String(d.ctr || 0)), 0) / 7;

        if (avgCtrLast > avgCtrFirst * 1.1) {
          (insights.patterns as string[]).push('CTR is improving over time');
        } else if (avgCtrLast < avgCtrFirst * 0.9) {
          (insights.patterns as string[]).push('CTR is declining — consider creative refresh');
        }
      }

      console.log(formatOutput(insights, opts.output as OutputFormat));
    }));
}
