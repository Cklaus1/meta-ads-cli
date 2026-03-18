import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAiCommands(program: Command, getClient: () => MetaClient): void {
  const ai = program.command('ai').description('AI-powered performance scoring, anomaly detection, and recommendations');

  ai
    .command('score <entityId>')
    .description('Get AI-powered performance score for a campaign, ad set, or ad')
    .requiredOption('--type <type>', 'Entity type: campaign, adset, ad')
    .option('--time-range <range>', 'Time range for analysis', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      const client = getClient();

      // Fetch insights
      const insightsParams: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type',
      };
      const insightsResponse = await client.request(`${entityId}/insights`, { params: insightsParams });
      const insights = ((insightsResponse.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

      // Calculate component scores
      const impressions = parseFloat(String(insights.impressions || 0));
      const clicks = parseFloat(String(insights.clicks || 0));
      const spend = parseFloat(String(insights.spend || 0));
      const ctr = parseFloat(String(insights.ctr || 0));
      const cpc = parseFloat(String(insights.cpc || 0));
      const frequency = parseFloat(String(insights.frequency || 0));

      const efficiencyScore = Math.min(100, ctr > 0 ? ctr * 20 : 0); // Higher CTR = better
      const engagementScore = Math.min(100, clicks > 0 ? Math.log10(clicks) * 25 : 0);
      const costScore = cpc > 0 ? Math.max(0, 100 - cpc * 10) : 50; // Lower CPC = better
      const reachScore = Math.min(100, impressions > 0 ? Math.log10(impressions) * 15 : 0);
      const frequencyPenalty = frequency > 3 ? (frequency - 3) * 10 : 0;

      const overallScore = Math.max(0, Math.min(100,
        efficiencyScore * 0.3 + engagementScore * 0.2 + costScore * 0.25 + reachScore * 0.15 + 10 - frequencyPenalty
      ));

      const recommendations: string[] = [];
      if (ctr < 1) recommendations.push('Low CTR — test new creative or refine targeting');
      if (frequency > 3) recommendations.push('High frequency — expand audience or refresh creative');
      if (cpc > 2) recommendations.push('High CPC — consider lowering bids or optimizing for cheaper actions');
      if (impressions < 1000) recommendations.push('Low delivery — increase budget or broaden targeting');

      console.log(formatOutput({
        entity_id: entityId,
        entity_type: opts.type,
        overall_score: Math.round(overallScore),
        component_scores: {
          efficiency: Math.round(efficiencyScore),
          engagement: Math.round(engagementScore),
          cost_effectiveness: Math.round(costScore),
          reach: Math.round(reachScore),
        },
        trend_direction: overallScore > 60 ? 'good' : overallScore > 40 ? 'needs_attention' : 'poor',
        recommendations,
        insights,
      }, opts.output as OutputFormat));
    }));

  ai
    .command('anomalies <entityId>')
    .description('Detect performance anomalies using statistical analysis')
    .requiredOption('--type <type>', 'Entity type: campaign, adset, ad')
    .option('--sensitivity <level>', 'Sensitivity (0.0-1.0, higher = more alerts)', '0.8')
    .option('--days <n>', 'Days of data to analyze', '14')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      const client = getClient();
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - parseInt(opts.days));

      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,date_start,date_stop',
        time_range: JSON.stringify({
          since: start.toISOString().slice(0, 10),
          until: now.toISOString().slice(0, 10),
        }),
        time_increment: '1',
      };

      const response = await client.request(`${entityId}/insights`, { params });
      const dailyData = (response.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      const anomalies: unknown[] = [];
      const sensitivity = parseFloat(opts.sensitivity);

      for (const metric of ['spend', 'cpc', 'ctr', 'impressions']) {
        const values = dailyData.map(d => parseFloat(String(d[metric] || 0)));
        if (values.length < 3) continue;

        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
        const threshold = stdDev * (2 - sensitivity); // Higher sensitivity = lower threshold

        for (let i = 0; i < values.length; i++) {
          if (Math.abs(values[i] - mean) > threshold && threshold > 0) {
            anomalies.push({
              date: dailyData[i].date_start,
              metric,
              value: values[i],
              expected: mean.toFixed(2),
              deviation: ((values[i] - mean) / stdDev).toFixed(1) + ' std devs',
              type: values[i] > mean ? 'spike' : 'drop',
            });
          }
        }
      }

      console.log(formatOutput({
        entity_id: entityId,
        anomalies_detected: anomalies.length,
        anomalies,
        analysis_period: { days: parseInt(opts.days), data_points: dailyData.length },
      }, opts.output as OutputFormat));
    }));

  ai
    .command('recommendations')
    .description('Get AI-powered optimization recommendations for an account')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--type <type>', 'Recommendation type: performance, budget, creative, audience', 'performance')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Get active campaigns with insights
      const campaignParams: Record<string, string> = {
        fields: 'id,name,objective,status,daily_budget,bid_strategy',
        effective_status: JSON.stringify(['ACTIVE']),
        limit: '50',
      };
      const campaignsResponse = await client.request(`${opts.accountId}/campaigns`, { params: campaignParams });
      const campaigns = (campaignsResponse.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      const recommendations: unknown[] = [];

      for (const campaign of campaigns.slice(0, 10)) {
        const insightParams: Record<string, string> = {
          fields: 'impressions,clicks,spend,cpc,cpm,ctr,frequency,actions',
        };
        const insightResponse = await client.request(`${campaign.id}/insights`, { params: insightParams });
        const insight = ((insightResponse.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

        const ctr = parseFloat(String(insight.ctr || 0));
        const cpc = parseFloat(String(insight.cpc || 0));
        const frequency = parseFloat(String(insight.frequency || 0));

        const recs: string[] = [];
        if (ctr < 0.5) recs.push('Very low CTR — consider testing new ad creatives');
        if (cpc > 5) recs.push('High CPC — try broader targeting or lower-funnel optimization');
        if (frequency > 4) recs.push('High frequency — audience may be saturated');
        if (!campaign.bid_strategy || campaign.bid_strategy === 'LOWEST_COST_WITHOUT_CAP') {
          recs.push('No bid cap — consider COST_CAP for better cost control');
        }

        if (recs.length > 0) {
          recommendations.push({
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            recommendations: recs,
            metrics: { ctr, cpc, frequency },
          });
        }
      }

      console.log(formatOutput({
        account_id: opts.accountId,
        recommendation_type: opts.type,
        total_campaigns_analyzed: campaigns.length,
        recommendations,
      }, opts.output as OutputFormat));
    }));

  ai
    .command('export-dataset')
    .description('Export ML-ready dataset for external analysis')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--data-type <type>', 'Data type: performance, audience, creative', 'performance')
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('--level <level>', 'Granularity: campaign, adset, ad', 'ad')
    .option('-o, --output <format>', 'Output format', 'csv')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const params: Record<string, string> = {
        fields: 'campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions,cost_per_action_type,date_start,date_stop',
        level: opts.level,
        limit: '500',
        time_increment: '1',
      };

      const response = await client.requestAllPages(`${opts.accountId}/insights`, { params }, 10);
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
