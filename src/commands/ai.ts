import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { isLlmAvailable, llmProviderLabel, reasonStructured } from '../llm.js';
import { computeBenchmarks, classify, type MetricStats } from '../benchmark.js';
import { deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, type DerivedMetrics } from '../metrics.js';
import { timeParams, TIME_RANGE_HELP } from './insights.js';
import { daysToPreset } from './analytics.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

type Row = Record<string, unknown>;

function rowsOf(data: unknown): Row[] {
  const d = (data as Row)?.data;
  return Array.isArray(d) ? d as Row[] : [];
}

/** Distribution stats compatible with benchmark.classify(). */
export function distribution(values: number[]): MetricStats {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { median: 0, mean: 0, min: 0, max: 0, p25: 0, p75: 0, count: 0 };
  const q = (p: number) => v[Math.min(n - 1, Math.floor(p * n))];
  return { median: q(0.5), mean: v.reduce((a, b) => a + b, 0) / n, min: v[0], max: v[n - 1], p25: q(0.25), p75: q(0.75), count: n };
}

/** Share of peers this value beats (0-100); lowerIsBetter flips the comparison. */
export function percentileRank(value: number, peers: number[], lowerIsBetter: boolean): number {
  const valid = peers.filter(x => Number.isFinite(x));
  if (valid.length === 0) return 50;
  const beaten = valid.filter(p => (lowerIsBetter ? value < p : value > p)).length;
  const ties = valid.filter(p => p === value).length;
  return Math.round(((beaten + ties / 2) / valid.length) * 100);
}

export type ScoredMetrics = DerivedMetrics & { link_ctr: number | null };

function withLinkCtr(row: Row, event: string): ScoredMetrics {
  const m = deriveMetrics(row, event);
  return { ...m, link_ctr: m.ctr };
}

const KPIS: Array<{ key: keyof ScoredMetrics; lowerIsBetter: boolean; weight: number; needsResults?: boolean; needsRevenue?: boolean }> = [
  { key: 'roas', lowerIsBetter: false, weight: 0.35, needsRevenue: true },
  { key: 'cost_per_result', lowerIsBetter: true, weight: 0.35, needsResults: true },
  { key: 'link_ctr', lowerIsBetter: false, weight: 0.12 },
  { key: 'cpm', lowerIsBetter: true, weight: 0.1 },
  { key: 'frequency', lowerIsBetter: true, weight: 0.08 },
];

/**
 * Score an entity 0-100 against peers with the same objective, on that
 * objective's KPIs (cost per result, ROAS), with link CTR, CPM and frequency
 * as secondary signals. Components without enough volume are left out.
 */
export function scoreAgainstPeers(entity: ScoredMetrics, peers: ScoredMetrics[], minResults = 3) {
  const components: Record<string, { value: number | null; percentile: number | null; peer_median: number | null; note?: string }> = {};
  let weighted = 0;
  let totalWeight = 0;
  for (const k of KPIS) {
    const value = entity[k.key] as number | null;
    const peerValues = peers
      .filter(p => (!k.needsResults || p.results >= minResults) && (!k.needsRevenue || p.revenue > 0))
      .map(p => p[k.key] as number | null)
      .filter((x): x is number => x !== null);
    const lacksVolume = (k.needsResults && entity.results < minResults) || (k.needsRevenue && entity.revenue <= 0);
    if (value === null || lacksVolume || peerValues.length < 3) {
      components[k.key] = {
        value, percentile: null, peer_median: peerValues.length ? distribution(peerValues).median : null,
        note: lacksVolume ? 'not enough volume' : peerValues.length < 3 ? 'fewer than 3 comparable peers' : 'no data',
      };
      continue;
    }
    const pct = percentileRank(value, peerValues, k.lowerIsBetter);
    components[k.key] = { value, percentile: pct, peer_median: distribution(peerValues).median };
    weighted += pct * k.weight;
    totalWeight += k.weight;
  }
  const hasPrimary = components.cost_per_result.percentile !== null || components.roas.percentile !== null;
  return {
    overall_score: totalWeight > 0 && hasPrimary ? Math.round(weighted / totalWeight) : null,
    components,
  };
}

/** Learning-phase counts per campaign from ad set learning_stage_info. */
function learningByCampaign(adsets: Row[]): Map<string, { learning: number; learning_limited: number; optimization_goals: string[]; custom_event_types: string[] }> {
  const out = new Map<string, { learning: number; learning_limited: number; optimization_goals: string[]; custom_event_types: string[] }>();
  for (const a of adsets) {
    const id = String(a.campaign_id);
    if (!out.has(id)) out.set(id, { learning: 0, learning_limited: 0, optimization_goals: [], custom_event_types: [] });
    const entry = out.get(id)!;
    const status = (a.learning_stage_info as Row | undefined)?.status;
    if (status === 'LEARNING') entry.learning++;
    if (status === 'FAIL') entry.learning_limited++;
    const goal = a.optimization_goal as string | undefined;
    if (goal && !entry.optimization_goals.includes(goal)) entry.optimization_goals.push(goal);
    const cet = (a.promoted_object as Row | undefined)?.custom_event_type as string | undefined;
    if (cet && !entry.custom_event_types.includes(cet)) entry.custom_event_types.push(cet);
  }
  return out;
}

const RECS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'recommendations'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph account-level read on performance.' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['priority', 'campaign', 'finding', 'action', 'rationale'],
        properties: {
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          campaign: { type: 'string', description: 'Campaign name (or "account" for account-wide).' },
          finding: { type: 'string', description: 'What the data shows.' },
          action: { type: 'string', description: 'Specific recommended action.' },
          rationale: { type: 'string', description: 'Why, grounded in the metrics + benchmarks provided.' },
        },
      },
    },
  },
} as const;

export function registerAiCommands(program: Command, getClient: () => MetaClient): void {
  const ai = program.command('ai').description('AI-powered performance scoring, anomaly detection, and recommendations');

  ai
    .command('score <entityId>')
    .description('Score a campaign/ad set/ad 0-100 against same-objective peers in its account (cost per result, ROAS, link CTR, CPM, frequency)')
    .requiredOption('--type <type>', 'Entity type: campaign, adset, ad')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_7d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective/optimization goal)')
    .option('--min-results <n>', 'Results needed before cost per result is scored', '3')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      if (!['campaign', 'adset', 'ad'].includes(opts.type)) throw new Error('--type must be campaign, adset or ad');
      const client = getClient();
      const time = timeParams(opts.timeRange, opts.since, opts.until);
      const fields = `account_id,${opts.type}_id,${PERFORMANCE_FIELDS},objective,optimization_goal`;

      const insightsResponse = await client.request(`${entityId}/insights`, { params: { fields, ...time } });
      const row = rowsOf(insightsResponse.data)[0] || {};
      const event = opts.resultEvent || resultEventFor({ objective: row.objective as string, optimizationGoal: row.optimization_goal as string });
      const entity = withLinkCtr(row, event);
      const minResults = Number(opts.minResults);

      // Peers: same level, same objective, same window, same account.
      let peers: ScoredMetrics[] = [];
      if (row.account_id) {
        const peerResponse = await client.requestAllPages(`act_${row.account_id}/insights`, {
          params: { fields, level: opts.type, limit: '500', ...time },
        });
        peers = rowsOf(peerResponse.data)
          .filter(p => String(p[`${opts.type}_id`]) !== entityId && (!row.objective || p.objective === row.objective))
          .map(p => withLinkCtr(p, event));
      }
      const scored = scoreAgainstPeers(entity, peers, minResults);

      const recommendations: string[] = [];
      const c = scored.components;
      if (c.cost_per_result.percentile !== null && c.cost_per_result.percentile < 25) {
        recommendations.push(`Cost per ${event} is in the worst quarter of comparable ${opts.type}s (${c.cost_per_result.value} vs median ${c.cost_per_result.peer_median}). Review audience, creative and offer before scaling.`);
      }
      if (c.roas.percentile !== null && c.roas.percentile < 25) {
        recommendations.push(`ROAS is in the bottom quarter (${c.roas.value} vs median ${c.roas.peer_median}).`);
      }
      if (c.link_ctr.percentile !== null && c.link_ctr.percentile < 25 && (c.cost_per_result.percentile ?? 50) < 50) {
        recommendations.push('Link CTR is low relative to peers and results are weak too — test new creative.');
      }
      if (c.frequency.percentile !== null && c.frequency.percentile < 15) {
        recommendations.push(`Frequency is among the highest in the account (${c.frequency.value}) — watch for fatigue (analytics creative-fatigue).`);
      }
      if (entity.results < minResults) {
        recommendations.push(`Only ${entity.results} ${event} results in this window — too few to judge cost; wait for more data or widen --time-range.`);
      }

      console.log(formatOutput({
        entity_id: entityId,
        entity_type: opts.type,
        objective: row.objective ?? null,
        result_event: event,
        method: 'percentile vs same-objective peers in the account',
        peers_compared: peers.length,
        overall_score: scored.overall_score,
        rating: scored.overall_score === null ? 'insufficient_data'
          : scored.overall_score >= 60 ? 'good' : scored.overall_score >= 40 ? 'needs_attention' : 'poor',
        component_scores: scored.components,
        metrics: entity,
        recommendations,
      }, opts.output as OutputFormat));
    }));

  ai
    .command('anomalies <entityId>')
    .description('Detect performance anomalies using statistical analysis')
    .requiredOption('--type <type>', 'Entity type: campaign, adset, ad')
    .option('--sensitivity <level>', 'Sensitivity (0.0-1.0, higher = more alerts)', '0.8')
    .option('--days <n>', 'Days of data to analyze: 7, 14, 28, 30 or 90 (excludes today)', '14')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective)')
    .option('--min-impressions <n>', 'Ignore days with fewer impressions (too noisy)', '200')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: `${PERFORMANCE_FIELDS},objective,optimization_goal,date_start,date_stop`,
        date_preset: daysToPreset(opts.days),
        time_increment: '1',
      };

      const response = await client.requestAllPages(`${entityId}/insights`, { params });
      const minImpressions = Number(opts.minImpressions);
      const raw = rowsOf(response.data);
      const first = raw[0] || {};
      const event = opts.resultEvent || resultEventFor({ objective: first.objective as string, optimizationGoal: first.optimization_goal as string });
      const dailyData = raw
        .filter(d => (Number(d.impressions) || 0) >= minImpressions)
        .map(d => ({ ...d, ...withLinkCtr(d, event) })) as Array<Record<string, unknown>>;

      const anomalies: unknown[] = [];
      const sensitivity = parseFloat(opts.sensitivity);

      for (const metric of ['spend', 'cpm', 'link_ctr', 'cpc', 'cost_per_result', 'results', 'impressions']) {
        const points = dailyData
          .map(d => ({ date: d.date_start, value: d[metric] === null || d[metric] === undefined ? NaN : Number(d[metric]) }))
          .filter(p => Number.isFinite(p.value));
        const values = points.map(p => p.value);
        if (values.length < 5) continue;

        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        // Sample standard deviation (n - 1).
        const stdDev = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1));
        const threshold = stdDev * (2 - sensitivity); // Higher sensitivity = lower threshold

        for (let i = 0; i < values.length; i++) {
          if (Math.abs(values[i] - mean) > threshold && threshold > 0) {
            anomalies.push({
              date: points[i].date,
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
        result_event: event,
        analysis_period: { date_preset: params.date_preset, data_points: dailyData.length, excluded_low_volume_days: raw.length - dailyData.length },
      }, opts.output as OutputFormat));
    }));

  ai
    .command('recommendations')
    .description('Get AI-powered optimization recommendations for an account (LLM-backed when available)')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--type <type>', 'Recommendation type: performance, budget, creative, audience', 'performance')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_30d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--min-results <n>', 'Results a campaign needs before its cost per result is judged', '10')
    .option('--no-llm', 'Skip the LLM and use rule-based heuristics only')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const time = timeParams(opts.timeRange, opts.since, opts.until);
      const minResults = Number(opts.minResults);

      // 1. Active campaigns, their ad sets' learning state, and one insights query for all of them.
      const [campaignsResponse, adsetsResponse, insightsResponse] = await Promise.all([
        client.requestAllPages(`${opts.accountId}/campaigns`, {
          params: {
            fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy',
            effective_status: JSON.stringify(['ACTIVE']),
            limit: '200',
          },
        }),
        client.requestAllPages(`${opts.accountId}/adsets`, {
          params: {
            fields: 'campaign_id,optimization_goal,promoted_object,learning_stage_info',
            effective_status: JSON.stringify(['ACTIVE']),
            limit: '200',
          },
        }),
        client.requestAllPages(`${opts.accountId}/insights`, {
          params: { level: 'campaign', fields: `campaign_id,${PERFORMANCE_FIELDS},attribution_setting`, limit: '500', ...time },
        }),
      ]);
      const campaigns = rowsOf(campaignsResponse.data);
      const learning = learningByCampaign(rowsOf(adsetsResponse.data));
      const insightsById = new Map(rowsOf(insightsResponse.data).map(r => [String(r.campaign_id), r]));

      // 2. Per-campaign KPIs for the campaign's own objective / optimization event.
      const enriched: Array<Record<string, unknown>> = campaigns.map(campaign => {
        const insight = insightsById.get(String(campaign.id)) || {};
        const l = learning.get(String(campaign.id));
        const event = resultEventFor({
          objective: campaign.objective as string,
          optimizationGoal: l?.optimization_goals.length === 1 ? l.optimization_goals[0] : undefined,
          customEventType: l?.custom_event_types.length === 1 ? l.custom_event_types[0] : undefined,
        });
        const m = withLinkCtr(insight, event);
        return {
          campaign_id: campaign.id,
          name: campaign.name,
          objective: campaign.objective,
          result_event: event,
          bid_strategy: campaign.bid_strategy || null,
          daily_budget_cents: campaign.daily_budget || null,
          lifetime_budget_cents: campaign.lifetime_budget || null,
          attribution_setting: insight.attribution_setting ?? null,
          adsets_learning: l?.learning ?? 0,
          adsets_learning_limited: l?.learning_limited ?? 0,
          impressions: m.impressions,
          spend: m.spend,
          results: m.results,
          cost_per_result: m.cost_per_result === null ? null : Number(m.cost_per_result.toFixed(2)),
          revenue: m.revenue,
          roas: m.roas === null ? null : Number(m.roas.toFixed(2)),
          ctr: m.link_ctr === null ? 0 : Number(m.link_ctr.toFixed(3)),
          cpc: m.cpc === null ? 0 : Number(m.cpc.toFixed(2)),
          cpm: m.cpm === null ? 0 : Number(m.cpm.toFixed(2)),
          frequency: m.frequency === null ? 0 : Number(m.frequency.toFixed(2)),
        };
      });

      // 3. Account-relative benchmarks (context layer). Cost per result is only
      // comparable within one result event, so it's benchmarked per event.
      const benchmarks = computeBenchmarks(enriched);
      const cprByEvent = new Map<string, MetricStats>();
      for (const event of new Set(enriched.map(e => String(e.result_event)))) {
        cprByEvent.set(event, distribution(enriched
          .filter(e => e.result_event === event && Number(e.results) >= minResults && e.cost_per_result !== null)
          .map(e => Number(e.cost_per_result))));
      }
      const roasStats = distribution(enriched.filter(e => e.roas !== null).map(e => Number(e.roas)));

      for (const e of enriched) {
        const ctrC = classify(e.ctr as number, benchmarks.metrics.ctr, false);
        const cpmC = classify(e.cpm as number, benchmarks.metrics.cpm, true);
        e.link_ctr_vs_account = `${ctrC.label} (${ctrC.vsMedian})`;
        e.cpm_vs_account = `${cpmC.label} (${cpmC.vsMedian})`;
        const cprStats = cprByEvent.get(String(e.result_event))!;
        e.cost_per_result_vs_account = Number(e.results) >= minResults && e.cost_per_result !== null
          ? (({ label, vsMedian }) => `${label} (${vsMedian})`)(classify(Number(e.cost_per_result), cprStats, true))
          : 'not enough results';
        e.roas_vs_account = e.roas !== null ? (({ label, vsMedian }) => `${label} (${vsMedian})`)(classify(Number(e.roas), roasStats, false)) : 'n/a';
      }

      const useLlm = opts.llm !== false && isLlmAvailable();

      // 4a. LLM-backed reasoning (preferred).
      if (useLlm) {
        const system = 'You are a senior Meta Ads strategist. You are given an advertiser\'s active '
          + 'campaigns with last-period performance and account-relative benchmarks (each metric '
          + 'annotated vs the account median). Judge each campaign on its objective\'s result: '
          + 'cost_per_result for its result_event and ROAS where revenue exists; link CTR, CPM and '
          + 'frequency are secondary diagnostics. Do not judge cost on campaigns with few results. '
          + 'Treat ad sets in learning as not yet judgeable, and learning-limited ones as a sign to '
          + 'consolidate or raise budget. Note that attribution_setting can differ between campaigns. '
          + 'Only suggest cost or bid caps when a CPA/ROAS baseline supports a specific value. '
          + 'Produce prioritized, specific, actionable recommendations grounded in the numbers provided. '
          + 'Be concrete (name the campaign, cite the metric). Do not invent data not present. '
          + 'Focus area: ' + String(opts.type) + '.';
        const userContent = JSON.stringify({
          account_id: opts.accountId,
          time_range: opts.timeRange,
          benchmarks,
          campaigns: enriched,
        }, null, 2);

        try {
          const result = await reasonStructured<{ summary: string; recommendations: unknown[] }>(
            system, userContent, { schema: RECS_SCHEMA as unknown as Record<string, unknown>, maxTokens: 4000 },
          );
          console.log(formatOutput({
            account_id: opts.accountId,
            recommendation_type: opts.type,
            engine: `llm:${llmProviderLabel()}`,
            time_range: opts.timeRange,
            campaigns_analyzed: enriched.length,
            benchmarks,
            campaigns: enriched,
            summary: result.summary,
            recommendations: result.recommendations,
          }, opts.output as OutputFormat));
          return;
        } catch (err) {
          console.error(`LLM analysis failed (${(err as Error).message}); falling back to heuristics.`);
        }
      }

      // 4b. Rule-based fallback (no key, --no-llm, or LLM error): relative to the
      // account, on the objective's result, with volume floors.
      const recommendations = enriched
        .map((e) => {
          const recs: string[] = [];
          const cprStats = cprByEvent.get(String(e.result_event))!;
          if (Number(e.results) >= minResults && e.cost_per_result !== null && cprStats.count >= 3 && Number(e.cost_per_result) >= cprStats.p75) {
            recs.push(`Cost per ${e.result_event} ${e.cost_per_result} is in the account's worst quarter (median ${cprStats.median}) — review audience/creative, or move budget to better campaigns`);
          }
          if (Number(e.results) < minResults && Number(e.spend) > 0) {
            recs.push(`Only ${e.results} ${e.result_event} results — too few to judge cost; consolidate ad sets or extend the window before changing it`);
          }
          if (e.roas !== null && roasStats.count >= 3 && Number(e.roas) <= roasStats.p25) {
            recs.push(`ROAS ${e.roas} is in the account's bottom quarter (median ${roasStats.median})`);
          }
          if (Number(e.adsets_learning_limited) > 0) {
            recs.push(`${e.adsets_learning_limited} ad set(s) are learning-limited — consolidate ad sets or raise budget so each gets ~50 results a week`);
          }
          if (benchmarks.metrics.frequency.count >= 3 && Number(e.frequency) >= benchmarks.metrics.frequency.p75 && String(e.link_ctr_vs_account).startsWith('poor')) {
            recs.push('High frequency with weak link CTR relative to the account — likely creative fatigue; refresh creative or broaden the audience');
          }
          return recs.length ? {
            campaign: e.name,
            result_event: e.result_event,
            metrics: { results: e.results, cost_per_result: e.cost_per_result, roas: e.roas, frequency: e.frequency, link_ctr: e.ctr },
            recommendations: recs,
          } : null;
        })
        .filter(Boolean);

      console.log(formatOutput({
        account_id: opts.accountId,
        recommendation_type: opts.type,
        engine: 'heuristic',
        method: 'relative to the account (quartiles), on each campaign\'s result event, with volume floors',
        time_range: opts.timeRange,
        campaigns_analyzed: enriched.length,
        benchmarks,
        recommendations,
      }, opts.output as OutputFormat));
    }));

  ai
    .command('export-dataset')
    .description('Export a daily dataset (one row per entity per day) for external analysis; see insights export-mmm for MMM')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--data-type <type>', 'Data type: performance, audience, creative', 'performance')
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_30d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('--level <level>', 'Granularity: campaign, adset, ad', 'ad')
    .option('--page-limit <n>', 'Max pages to fetch (500 rows each)', '1000')
    .option('-o, --output <format>', 'Output format', 'csv')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const params: Record<string, string> = {
        fields: 'campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,objective,optimization_goal,impressions,reach,frequency,clicks,inline_link_clicks,spend,cpc,cpm,ctr,actions,action_values,cost_per_action_type,account_currency,attribution_setting,date_start,date_stop',
        level: opts.level,
        limit: '500',
        time_increment: '1',
        ...timeParams(opts.timeRange, opts.since, opts.until),
      };

      const response = await client.requestAllPages(`${opts.accountId}/insights`, { params }, Number(opts.pageLimit));
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
