import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerBiddingCommands(program: Command, getClient: () => MetaClient): void {
  const bidding = program.command('bidding').description('Bid strategy management and analysis');

  bidding
    .command('validate')
    .description('Validate a bid strategy configuration')
    .requiredOption('--bid-strategy <strategy>', 'Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, etc.)')
    .requiredOption('--optimization-goal <goal>', 'Optimization goal')
    .requiredOption('--billing-event <event>', 'Billing event')
    .option('--target-roas <roas>', 'Target ROAS value')
    .option('--target-cost <cost>', 'Target cost value')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      // Local validation logic
      const validStrategies = [
        'LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP',
        'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS', 'TARGET_COST',
      ];
      const validGoals = [
        'LINK_CLICKS', 'REACH', 'CONVERSIONS', 'APP_INSTALLS',
        'OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS',
        'LEAD_GENERATION', 'VALUE',
      ];
      const validEvents = ['IMPRESSIONS', 'LINK_CLICKS', 'APP_INSTALLS', 'NONE'];

      const result: Record<string, unknown> = {
        bid_strategy: opts.bidStrategy,
        optimization_goal: opts.optimizationGoal,
        billing_event: opts.billingEvent,
        valid: true,
        warnings: [] as string[],
      };

      if (!validStrategies.includes(opts.bidStrategy)) {
        result.valid = false;
        (result.warnings as string[]).push(`Unknown bid strategy: ${opts.bidStrategy}. Valid: ${validStrategies.join(', ')}`);
      }
      if (!validGoals.includes(opts.optimizationGoal)) {
        (result.warnings as string[]).push(`Unknown optimization goal: ${opts.optimizationGoal}. Valid: ${validGoals.join(', ')}`);
      }
      if (!validEvents.includes(opts.billingEvent)) {
        (result.warnings as string[]).push(`Unknown billing event: ${opts.billingEvent}. Valid: ${validEvents.join(', ')}`);
      }
      if (opts.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && !opts.targetRoas) {
        result.valid = false;
        (result.warnings as string[]).push('LOWEST_COST_WITH_MIN_ROAS requires --target-roas');
      }

      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  bidding
    .command('analyze <adsetIds>')
    .description('Analyze bid performance for ad sets (comma-separated IDs)')
    .option('--time-range <range>', 'Time range', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string, opts) => {
      const client = getClient();
      const ids = adsetIds.split(',');
      const results: unknown[] = [];

      for (const id of ids) {
        const params: Record<string, string> = {
          fields: 'id,name,bid_strategy,bid_amount,optimization_goal,billing_event,daily_budget,status',
        };
        const adsetResponse = await client.request(id.trim(), { params });

        const insightParams: Record<string, string> = {
          fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type',
        };
        const insightsResponse = await client.request(`${id.trim()}/insights`, { params: insightParams });

        results.push({
          adset: adsetResponse.data,
          insights: insightsResponse.data,
        });
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bidding
    .command('learning-phase <adsetIds>')
    .description('Monitor learning phase status for ad sets (comma-separated IDs)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string, opts) => {
      const client = getClient();
      const ids = adsetIds.split(',');
      const results: unknown[] = [];

      for (const id of ids) {
        const params: Record<string, string> = {
          fields: 'id,name,status,bid_strategy,optimization_goal,issues_info',
        };
        const response = await client.request(id.trim(), { params });
        results.push(response.data);
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bidding
    .command('budget-schedule')
    .description('Create a budget schedule for a campaign')
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--budget-value <value>', 'Budget value')
    .requiredOption('--budget-type <type>', 'Budget value type (ABSOLUTE, MULTIPLIER)')
    .requiredOption('--time-start <time>', 'Schedule start time (ISO 8601)')
    .requiredOption('--time-end <time>', 'Schedule end time (ISO 8601)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        budget_value: opts.budgetValue,
        budget_value_type: opts.budgetType,
        time_start: opts.timeStart,
        time_end: opts.timeEnd,
      };

      const response = await client.request(`${opts.campaignId}/budget_schedules`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  bidding
    .command('seasonal-schedule')
    .description('Create seasonal bid adjustments for ad sets')
    .requiredOption('--adset-ids <ids>', 'Comma-separated ad set IDs')
    .requiredOption('--pattern <pattern>', 'Pattern: holiday_boost, weekend_reduction, weekday_focus')
    .requiredOption('--adjustment <pct>', 'Adjustment percentage (e.g., 20 for +20%, -15 for -15%)')
    .requiredOption('--start-date <date>', 'Start date (YYYY-MM-DD)')
    .requiredOption('--end-date <date>', 'End date (YYYY-MM-DD)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.adsetIds.split(',').map((id: string) => id.trim());
      const adjustment = parseFloat(opts.adjustment) / 100;
      const results: unknown[] = [];

      for (const id of ids) {
        // Get current bid
        const adsetResponse = await client.request(id, {
          params: { fields: 'id,name,bid_amount,daily_budget' },
        });
        const adset = adsetResponse.data as Record<string, unknown>;
        const currentBudget = parseInt(String(adset.daily_budget || 0));

        if (currentBudget > 0) {
          const adjustedBudget = Math.round(currentBudget * (1 + adjustment));
          results.push({
            adset_id: id,
            adset_name: adset.name,
            current_daily_budget: currentBudget,
            adjusted_daily_budget: adjustedBudget,
            adjustment_pct: opts.adjustment + '%',
            pattern: opts.pattern,
            period: { start: opts.startDate, end: opts.endDate },
            note: 'Use "meta-ads adsets update" to apply adjusted budgets when the seasonal period begins.',
          });
        }
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bidding
    .command('competitor-analysis <campaignId>')
    .description('Analyze competitor bidding landscape via auction insights')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();

      // Get campaign insights with auction overlap
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency',
      };
      const insightsResponse = await client.request(`${campaignId}/insights`, { params });

      // Get campaign details for context
      const campaignResponse = await client.request(campaignId, {
        params: { fields: 'id,name,objective,bid_strategy,daily_budget' },
      });

      const insights = ((insightsResponse.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};
      const cpm = parseFloat(String(insights.cpm || 0));

      // Provide bid landscape analysis
      const recommendations: string[] = [];
      if (cpm > 15) recommendations.push('High CPM suggests competitive auction — consider niche targeting');
      if (cpm < 5) recommendations.push('Low CPM suggests opportunity — consider scaling budget');

      console.log(formatOutput({
        campaign: campaignResponse.data,
        insights,
        bid_landscape: {
          competitiveness: cpm > 15 ? 'high' : cpm > 8 ? 'moderate' : 'low',
          cpm_benchmark: cpm,
          recommendations,
        },
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('optimize-budget')
    .description('Get budget allocation recommendations across campaigns')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      const insightsParams: Record<string, string> = {
        fields: 'campaign_id,campaign_name,impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type',
        level: 'campaign',
        limit: '50',
      };
      const insightsResponse = await client.request(`${opts.accountId}/insights`, { params: insightsParams });
      const campaigns = (insightsResponse.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      // Rank campaigns by efficiency (CTR/CPC ratio)
      const ranked = campaigns
        .map(c => ({
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          spend: parseFloat(String(c.spend || 0)),
          cpc: parseFloat(String(c.cpc || 0)),
          ctr: parseFloat(String(c.ctr || 0)),
          efficiency_score: parseFloat(String(c.ctr || 0)) / Math.max(parseFloat(String(c.cpc || 1)), 0.01),
        }))
        .sort((a, b) => b.efficiency_score - a.efficiency_score);

      const totalSpend = ranked.reduce((s, c) => s + c.spend, 0);

      console.log(formatOutput({
        account_id: opts.accountId,
        total_spend: totalSpend.toFixed(2),
        campaigns_ranked_by_efficiency: ranked.map((c, i) => ({
          rank: i + 1,
          ...c,
          recommendation: i < ranked.length / 3 ? 'INCREASE budget' : i > ranked.length * 2 / 3 ? 'DECREASE budget' : 'MAINTAIN',
        })),
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('recommendations')
    .description('Get personalized bid strategy recommendations based on campaign goals')
    .requiredOption('--objective <objective>', 'Campaign objective (OUTCOME_TRAFFIC, OUTCOME_SALES, etc.)')
    .requiredOption('--budget-range <range>', 'Budget range (low, medium, high)')
    .requiredOption('--target-metric <metric>', 'Target metric (cpc, cpa, roas)')
    .option('--business-type <type>', 'Business type (ecommerce, saas, local, agency)', 'ecommerce')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      // Local recommendation engine
      const recommendations: Record<string, unknown> = {
        objective: opts.objective,
        budget_range: opts.budgetRange,
        target_metric: opts.targetMetric,
        business_type: opts.businessType,
        strategies: [] as unknown[],
      };

      const strategies = recommendations.strategies as Array<Record<string, unknown>>;
      if (opts.targetMetric === 'cpc') {
        strategies.push({ strategy: 'LOWEST_COST_WITH_BID_CAP', reason: 'Best for controlling per-click costs', risk: 'low' });
        strategies.push({ strategy: 'COST_CAP', reason: 'Maintains average cost within target', risk: 'medium' });
      } else if (opts.targetMetric === 'roas') {
        strategies.push({ strategy: 'LOWEST_COST_WITH_MIN_ROAS', reason: 'Optimizes for return on ad spend', risk: 'medium' });
      } else {
        strategies.push({ strategy: 'LOWEST_COST_WITHOUT_CAP', reason: 'Maximizes results within budget', risk: 'low' });
        strategies.push({ strategy: 'COST_CAP', reason: 'Keeps cost per action near target', risk: 'medium' });
      }

      if (opts.budgetRange === 'high') {
        strategies.push({ strategy: 'TARGET_COST', reason: 'Consistent cost at scale', risk: 'high' });
      }

      console.log(formatOutput(recommendations, opts.output as OutputFormat));
    }));

  bidding
    .command('auto-adjustments <adsetIds>')
    .description('Generate automated bid adjustment recommendations (comma-separated IDs)')
    .option('--threshold <value>', 'Performance threshold (0.0-1.0)', '0.5')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string, opts) => {
      const client = getClient();
      const ids = adsetIds.split(',').map((id: string) => id.trim());
      const threshold = parseFloat(opts.threshold);
      const adjustments: unknown[] = [];

      for (const id of ids) {
        const [adset, insights] = await Promise.all([
          client.request(id, { params: { fields: 'id,name,bid_amount,bid_strategy,daily_budget,optimization_goal' } }),
          client.request(`${id}/insights`, { params: { fields: 'impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type' } }),
        ]);

        const adsetData = adset.data as Record<string, unknown>;
        const insightData = ((insights.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

        const cpc = parseFloat(String(insightData.cpc || 0));
        const ctr = parseFloat(String(insightData.ctr || 0));
        const currentBid = parseInt(String(adsetData.bid_amount || 0));

        let action = 'no_change';
        let newBid = currentBid;
        let reason = '';

        if (ctr > threshold * 2 && cpc < 1) {
          action = 'increase_bid';
          newBid = Math.round(currentBid * 1.15);
          reason = 'Strong performance — increase bid to capture more volume';
        } else if (ctr < threshold * 0.5 || cpc > 5) {
          action = 'decrease_bid';
          newBid = Math.round(currentBid * 0.85);
          reason = 'Poor performance — decrease bid to reduce waste';
        }

        adjustments.push({
          adset_id: id,
          adset_name: adsetData.name,
          current_bid: currentBid,
          recommended_bid: newBid,
          action,
          reason,
          metrics: { cpc, ctr },
        });
      }

      console.log(formatOutput(adjustments, opts.output as OutputFormat));
    }));

  bidding
    .command('cross-campaign-coordination')
    .description('Coordinate bids across multiple campaigns to avoid overlap')
    .requiredOption('--campaign-ids <ids>', 'Comma-separated campaign IDs')
    .option('--strategy <strategy>', 'Coordination strategy (balanced, priority, budget_pool)', 'balanced')
    .option('--total-budget <cents>', 'Total budget pool in cents')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.campaignIds.split(',').map((id: string) => id.trim());
      const results: unknown[] = [];

      for (const id of ids) {
        const [campaign, insights] = await Promise.all([
          client.request(id, { params: { fields: 'id,name,daily_budget,bid_strategy,objective,status' } }),
          client.request(`${id}/insights`, { params: { fields: 'spend,cpc,cpm,ctr,impressions,actions' } }),
        ]);
        const insightData = ((insights.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};
        results.push({ campaign: campaign.data, insights: insightData });
      }

      // Calculate efficiency ranking
      const ranked = results.map((r: unknown, i: number) => {
        const item = r as Record<string, unknown>;
        const insight = item.insights as Record<string, unknown>;
        const ctr = parseFloat(String(insight.ctr || 0));
        const cpc = parseFloat(String(insight.cpc || 0));
        return { ...item, efficiency: ctr / Math.max(cpc, 0.01), rank: 0 };
      }).sort((a, b) => b.efficiency - a.efficiency);
      ranked.forEach((r, i) => r.rank = i + 1);

      console.log(formatOutput({
        strategy: opts.strategy,
        campaigns: ranked,
        recommendation: `Allocate more budget to top-ranked campaigns (${opts.strategy} strategy)`,
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('scaling-recommendation <campaignId>')
    .description('Get recommendations for scaling campaign budgets')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const [campaign, insights] = await Promise.all([
        client.request(campaignId, { params: { fields: 'id,name,daily_budget,lifetime_budget,bid_strategy,objective,status' } }),
        client.request(`${campaignId}/insights`, { params: { fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type' } }),
      ]);

      const campaignData = campaign.data as Record<string, unknown>;
      const insightData = ((insights.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

      const currentBudget = parseFloat(String(campaignData.daily_budget || 0));
      const frequency = parseFloat(String(insightData.frequency || 0));
      const ctr = parseFloat(String(insightData.ctr || 0));
      const cpc = parseFloat(String(insightData.cpc || 0));

      let scalingAction = 'maintain';
      let suggestedBudget = currentBudget;
      const reasons: string[] = [];

      if (frequency < 2 && ctr > 1 && cpc < 2) {
        scalingAction = 'scale_up';
        suggestedBudget = Math.round(currentBudget * 1.2);
        reasons.push('Low frequency + strong CTR = room to grow');
      } else if (frequency > 4) {
        scalingAction = 'scale_down_or_expand';
        reasons.push('High frequency — audience saturated');
      } else if (cpc > 5) {
        scalingAction = 'optimize_first';
        reasons.push('High CPC — optimize targeting before scaling');
      } else {
        reasons.push('Performance is stable — gradual 10-20% increases recommended');
        suggestedBudget = Math.round(currentBudget * 1.1);
      }

      console.log(formatOutput({
        campaign_id: campaignId,
        campaign_name: campaignData.name,
        current_daily_budget: currentBudget,
        suggested_daily_budget: suggestedBudget,
        scaling_action: scalingAction,
        reasons,
        metrics: { frequency, ctr, cpc },
      }, opts.output as OutputFormat));
    }));
}
