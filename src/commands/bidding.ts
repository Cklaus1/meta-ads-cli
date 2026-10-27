import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, PolicyError, UsageError } from '../errors.js';
import { deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, hasEnoughVolume, minorUnitFactor, type DerivedMetrics } from '../metrics.js';
import { insightsTimeParams } from '../time-range.js';
import { parseJsonInput } from '../json-input.js';

/** Ad set optimization_goal values from the Marketing API AdSet reference (v26.0). */
export const OPTIMIZATION_GOALS = [
  'NONE', 'APP_INSTALLS', 'AD_RECALL_LIFT', 'ENGAGED_USERS', 'EVENT_RESPONSES', 'IMPRESSIONS', 'LEAD_GENERATION',
  'QUALITY_LEAD', 'LINK_CLICKS', 'OFFSITE_CONVERSIONS', 'PAGE_LIKES', 'POST_ENGAGEMENT', 'QUALITY_CALL', 'REACH',
  'LANDING_PAGE_VIEWS', 'VISIT_INSTAGRAM_PROFILE', 'ENGAGED_PAGE_VIEWS', 'VALUE', 'THRUPLAY', 'DERIVED_EVENTS',
  'APP_INSTALLS_AND_OFFSITE_CONVERSIONS', 'CONVERSATIONS', 'IN_APP_VALUE', 'MESSAGING_PURCHASE_CONVERSION',
  'MESSAGING_DEEP_CONVERSATION_AND_FOLLOW', 'SUBSCRIBERS', 'REMINDERS_SET', 'MEANINGFUL_CALL_ATTEMPT',
  'PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'ADVERTISER_SILOED_VALUE', 'AUTOMATIC_OBJECTIVE',
  'MESSAGING_APPOINTMENT_CONVERSION',
];

/** Current bid strategies. TARGET_COST was deprecated in Marketing API v9 (use COST_CAP). */
export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'];

/**
 * optimization_goal → allowed billing_event, from Meta's billing events guide.
 * Goals not listed bill on IMPRESSIONS only.
 */
export const BILLING_EVENTS_BY_GOAL: Record<string, string[]> = {
  LINK_CLICKS: ['IMPRESSIONS', 'LINK_CLICKS'],
  THRUPLAY: ['IMPRESSIONS', 'THRUPLAY'],
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: ['IMPRESSIONS', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
};

/**
 * ODAX objective → optimization goals Meta accepts, from the objective mapping
 * in the Campaign reference. OUTCOME_SALES is not shown there and comes from the
 * sales objective guide (marked in the docs as best-effort).
 */
export const GOALS_BY_OBJECTIVE: Record<string, string[]> = {
  OUTCOME_AWARENESS: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
  OUTCOME_TRAFFIC: ['LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS', 'QUALITY_CALL', 'CONVERSATIONS', 'VISIT_INSTAGRAM_PROFILE', 'PROFILE_VISIT'],
  OUTCOME_ENGAGEMENT: [
    'POST_ENGAGEMENT', 'PAGE_LIKES', 'EVENT_RESPONSES', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', 'CONVERSATIONS',
    'LINK_CLICKS', 'LEAD_GENERATION', 'OFFSITE_CONVERSIONS', 'REACH', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS',
    'VISIT_INSTAGRAM_PROFILE', 'PROFILE_VISIT', 'PROFILE_AND_PAGE_ENGAGEMENT', 'REMINDERS_SET',
  ],
  OUTCOME_LEADS: ['LEAD_GENERATION', 'QUALITY_LEAD', 'QUALITY_CALL', 'OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'CONVERSATIONS'],
  OUTCOME_APP_PROMOTION: ['APP_INSTALLS', 'LINK_CLICKS', 'OFFSITE_CONVERSIONS', 'VALUE', 'APP_INSTALLS_AND_OFFSITE_CONVERSIONS'],
  OUTCOME_SALES: ['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'IMPRESSIONS', 'REACH', 'CONVERSATIONS'],
};

/** The default optimization goal a buyer would pick for each objective. */
export const DEFAULT_GOAL_BY_OBJECTIVE: Record<string, string> = {
  OUTCOME_AWARENESS: 'REACH',
  OUTCOME_TRAFFIC: 'LANDING_PAGE_VIEWS',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
  OUTCOME_LEADS: 'LEAD_GENERATION',
  OUTCOME_APP_PROMOTION: 'APP_INSTALLS',
  OUTCOME_SALES: 'OFFSITE_CONVERSIONS',
};

/** Goals that need a promoted_object, and which keys it must carry. */
const PROMOTED_OBJECT_KEYS: Record<string, string[][]> = {
  OFFSITE_CONVERSIONS: [['pixel_id', 'custom_event_type'], ['application_id', 'object_store_url'], ['custom_conversion_id']],
  VALUE: [['pixel_id', 'custom_event_type'], ['application_id', 'object_store_url']],
  APP_INSTALLS: [['application_id', 'object_store_url']],
  LEAD_GENERATION: [['page_id']],
  QUALITY_LEAD: [['page_id']],
  PAGE_LIKES: [['page_id']],
};

export interface BidConfig {
  objective?: string;
  bidStrategy?: string;
  optimizationGoal: string;
  billingEvent?: string;
  bidAmount?: string | number;
  roasGoal?: string | number;
  promotedObject?: Record<string, unknown>;
}

/**
 * Check the combinations launches fail on: objective ↔ goal, goal ↔ billing
 * event, goal ↔ promoted_object, and bid strategy ↔ bid amount / ROAS floor.
 * Returns errors (Meta would reject) and warnings (likely a mistake).
 */
export function validateBidConfig(c: BidConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const goal = c.optimizationGoal;

  if (goal === 'CONVERSIONS') {
    errors.push('CONVERSIONS is not an ad set optimization goal; use OFFSITE_CONVERSIONS (pixel/app events) or VALUE.');
  } else if (!OPTIMIZATION_GOALS.includes(goal)) {
    errors.push(`Unknown optimization goal: ${goal}.`);
  }

  if (c.objective) {
    const allowed = GOALS_BY_OBJECTIVE[c.objective];
    if (!allowed) {
      errors.push(`Unknown objective: ${c.objective}. Use one of: ${Object.keys(GOALS_BY_OBJECTIVE).join(', ')}`);
    } else if (!allowed.includes(goal)) {
      errors.push(`${goal} is not a valid optimization goal for ${c.objective}. Valid: ${allowed.join(', ')}`);
    }
  }

  if (c.billingEvent) {
    const events = BILLING_EVENTS_BY_GOAL[goal] || ['IMPRESSIONS'];
    if (!events.includes(c.billingEvent)) {
      errors.push(`billing_event ${c.billingEvent} is not allowed with ${goal}. Use: ${events.join(', ')}`);
    }
  }

  const required = PROMOTED_OBJECT_KEYS[goal];
  if (required) {
    const po = c.promotedObject || {};
    const satisfied = required.some(keys => keys.every(k => po[k] !== undefined && po[k] !== ''));
    if (!satisfied) {
      errors.push(`${goal} needs a promoted_object with ${required.map(k => k.join(' + ')).join(', or ')}.`);
    }
  }

  const strategy = c.bidStrategy;
  if (strategy === 'TARGET_COST') {
    errors.push('TARGET_COST was deprecated in Marketing API v9 and its ad sets no longer deliver. Use COST_CAP.');
  } else if (strategy && !BID_STRATEGIES.includes(strategy)) {
    errors.push(`Unknown bid strategy: ${strategy}. Valid: ${BID_STRATEGIES.join(', ')}`);
  }
  if (strategy === 'COST_CAP' || strategy === 'LOWEST_COST_WITH_BID_CAP') {
    if (!c.bidAmount) errors.push(`${strategy} needs a bid amount (bid_amount, in cents).`);
  }
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    if (goal !== 'VALUE') errors.push('LOWEST_COST_WITH_MIN_ROAS (ROAS goal) needs optimization_goal VALUE.');
    if (!c.roasGoal) errors.push('LOWEST_COST_WITH_MIN_ROAS needs a ROAS goal (bid_constraints.roas_average_floor).');
    if (c.bidAmount) errors.push('Don\'t set bid_amount with a ROAS goal; the ROAS floor is the only bid control.');
  }
  if (c.roasGoal !== undefined) {
    try { roasFloor(c.roasGoal); } catch (err) { errors.push((err as Error).message); }
  }
  if ((strategy === 'LOWEST_COST_WITHOUT_CAP' || !strategy) && c.bidAmount) {
    warnings.push('bid_amount is ignored without a cap strategy (COST_CAP or LOWEST_COST_WITH_BID_CAP).');
  }
  return { errors, warnings };
}

/** Convert a ROAS goal (e.g. 2.5) to Meta's roas_average_floor (×10000; 100–10000000). */
export function roasFloor(roas: string | number): number {
  const value = Number(roas);
  const floor = Math.round(value * 10000);
  if (!Number.isFinite(value) || floor < 100 || floor > 10_000_000) {
    throw new Error(`ROAS goal must be between 0.01 and 1000, got: "${roas}"`);
  }
  return floor;
}

/**
 * Warning text when a budget change is big enough to likely reset the
 * learning phase, or undefined. Meta treats large budget jumps as significant
 * edits; ~20% is the usual safe step.
 */
export function significantChangeWarning(oldCents: number, newCents: number, learningStatus?: string): string | undefined {
  if (!oldCents || !newCents) return undefined;
  const changePct = Math.abs(newCents - oldCents) / oldCents * 100;
  if (changePct <= 20) return undefined;
  const learning = learningStatus === 'LEARNING' ? ' The ad set is still in the learning phase.' : '';
  return `Budget change of ${changePct.toFixed(0)}% may reset the learning phase (changes over ~20% count as significant edits).${learning}`;
}

/** Clamp a proposed budget to at most maxChangePct away from the current one. */
export function capChange(current: number, proposed: number, maxChangePct: number): number {
  if (!current) return Math.round(proposed);
  const max = current * (1 + maxChangePct / 100);
  const min = current * (1 - maxChangePct / 100);
  return Math.round(Math.min(max, Math.max(min, proposed)));
}

function firstRow(data: unknown): Record<string, unknown> {
  return (((data as Record<string, unknown>)?.data as unknown[]) || [])[0] as Record<string, unknown> || {};
}

function rows(data: unknown): Array<Record<string, unknown>> {
  return ((data as Record<string, unknown>)?.data as Array<Record<string, unknown>>) || [];
}

function parsePositive(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number, got: "${value}"`);
  return n;
}

/** Non-negative number for volume floors; NaN would silently turn a floor off. */
export function parseNonNegative(value: unknown, flag: string): number {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < 0) {
    throw new UsageError(`${flag} must be a number ≥ 0, got: "${value}"`);
  }
  return n;
}

function parsePct(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) throw new UsageError(`${flag} must be between 0 and 100, got: "${value}"`);
  return n;
}

// Presets whose length in days is known, for delivery-ratio math.
export const PRESET_DAYS: Record<string, number> = {
  today: 1, yesterday: 1, last_3d: 3, last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30, last_90d: 90,
};

export function presetDays(range: string, flag = '--time-range'): number {
  const days = PRESET_DAYS[range];
  if (!days) throw new UsageError(`${flag} must be one of ${Object.keys(PRESET_DAYS).join(', ')} here (a fixed number of days is needed), got: "${range}"`);
  return days;
}

/** Currency of an ad account, cached per run. Undefined in dry-run (assumes 2 decimals). */
const currencyCache = new Map<string, Promise<string | undefined>>();
export function accountCurrency(client: MetaClient, accountId: unknown): Promise<string | undefined> {
  if (!accountId || client.isDryRun()) return Promise.resolve(undefined);
  const id = String(accountId).startsWith('act_') ? String(accountId) : `act_${accountId}`;
  if (!currencyCache.has(id)) {
    currencyCache.set(id, client.request(id, { params: { fields: 'currency' } })
      .then(r => (r.data as Record<string, unknown>).currency as string | undefined)
      .catch(() => undefined));
  }
  return currencyCache.get(id)!;
}

/** Offset (ms) of a timezone from UTC at an instant. */
function tzOffsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(at)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at;
}

/**
 * Unix seconds for a wall-clock date/time in a timezone (the ad account's),
 * so a schedule "from 2026-11-27" starts at midnight where the account runs.
 */
export function zonedToUnix(date: string, time: string, timeZone: string | undefined, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`${flag}: use YYYY-MM-DD, got "${date}"`);
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  if (!timeZone) return String(Math.floor(asUtc / 1000) + new Date(asUtc).getTimezoneOffset() * 60);
  try {
    // Two passes handle DST transitions near the date.
    let t = asUtc - tzOffsetMs(asUtc, timeZone);
    t = asUtc - tzOffsetMs(t, timeZone);
    return String(Math.floor(t / 1000));
  } catch {
    return String(Math.floor(asUtc / 1000) + new Date(asUtc).getTimezoneOffset() * 60);
  }
}

/**
 * Budget in effect while a budget schedule runs. ABSOLUTE adds budget_value
 * (minor units); MULTIPLIER raises the budget by budget_value percent.
 */
export function scheduledBudget(current: number, value: number, type: string): number {
  return String(type).toUpperCase() === 'MULTIPLIER' ? Math.round(current * (1 + value / 100)) : current + value;
}

/** The spend cap applies to the budget a schedule produces, not just to the increase. */
export function assertScheduleWithinCap(capCents: number, current: number, value: number, type: string, campaignId: string): void {
  if (!capCents || !current) return;
  const resulting = scheduledBudget(current, value, type);
  if (resulting > capCents) {
    throw new PolicyError(
      `Spend-cap guard: the budget schedule on ${campaignId} would raise the budget to ${resulting}¢ during the period, `
      + `above the spend cap of ${capCents}¢.`,
    );
  }
}

/** KPI used to judge a campaign: ROAS when it has revenue, else cost per result. */
type KpiGroup = 'roas' | 'cost_per_result';
function kpiGroup(s: Scored): KpiGroup {
  return s.metrics.roas !== null ? 'roas' : 'cost_per_result';
}

/** Fetch learning_stage_info for every ad set in an account or campaign, keyed by ad set and campaign. */
async function learningByCampaign(client: MetaClient, parent: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (client.isDryRun()) return map;
  const res = await client.requestAllPages(`${parent}/adsets`, {
    params: { fields: 'id,campaign_id,effective_status,learning_stage_info', limit: '200' },
  });
  for (const a of rows(res.data)) {
    if (a.effective_status !== 'ACTIVE') continue;
    const status = (a.learning_stage_info as Record<string, unknown> | undefined)?.status as string | undefined;
    const key = String(a.campaign_id);
    map.set(key, [...(map.get(key) || []), status || 'UNKNOWN']);
  }
  return map;
}

interface Scored {
  id: string;
  name: unknown;
  objective?: string;
  metrics: DerivedMetrics;
  learning: string[];
  enoughVolume: boolean;
}

/**
 * Efficiency used for ranking: ROAS when there's revenue (or a ROAS target),
 * otherwise results per unit spend (inverse cost per result).
 */
function efficiency(s: Scored, useRoas: boolean): number {
  if (useRoas) return s.metrics.roas ?? 0;
  return s.metrics.cost_per_result ? 1 / s.metrics.cost_per_result : 0;
}

/** 'roas', 'cost_per_result', or 'mixed' when both groups were ranked. */
function rankedBy(ranks: Map<Scored, { group: KpiGroup }>): string {
  const groups = new Set([...ranks.values()].map(r => r.group));
  return groups.size === 1 ? [...groups][0] : groups.size ? 'mixed' : 'cost_per_result';
}

/** Rank each campaign within the campaigns that share its KPI (ROAS vs cost per result). */
export function rankWithinGroups(scored: Scored[]): Map<Scored, { group: KpiGroup; rank: number; size: number }> {
  const out = new Map<Scored, { group: KpiGroup; rank: number; size: number }>();
  for (const group of ['roas', 'cost_per_result'] as KpiGroup[]) {
    const members = scored.filter(s => s.enoughVolume && kpiGroup(s) === group)
      .sort((a, b) => efficiency(b, group === 'roas') - efficiency(a, group === 'roas'));
    members.forEach((s, i) => out.set(s, { group, rank: i, size: members.length }));
  }
  return out;
}

export function registerBiddingCommands(program: Command, getClient: () => MetaClient): void {
  const bidding = program.command('bidding').description('Bid strategy management and analysis');

  bidding
    .command('validate')
    .description('Validate objective / optimization goal / billing event / promoted object / bid strategy combinations')
    .requiredOption('--optimization-goal <goal>', 'Optimization goal')
    .option('--objective <objective>', 'Campaign objective (OUTCOME_*), to check goal compatibility')
    .option('--bid-strategy <strategy>', `Bid strategy (${BID_STRATEGIES.join(', ')})`)
    .option('--billing-event <event>', 'Billing event (IMPRESSIONS, LINK_CLICKS, THRUPLAY)')
    .option('--bid-amount <cents>', 'Bid amount / cost cap in cents (COST_CAP, LOWEST_COST_WITH_BID_CAP)')
    .option('--target-cost <cents>', 'Deprecated alias for --bid-amount')
    .option('--target-roas <roas>', 'ROAS goal, e.g. 2.5 (LOWEST_COST_WITH_MIN_ROAS)')
    .option('--promoted-object <json>', 'Promoted object as JSON, @file or - (e.g. {"pixel_id":"1","custom_event_type":"PURCHASE"})')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const config: BidConfig = {
        objective: opts.objective,
        bidStrategy: opts.bidStrategy,
        optimizationGoal: opts.optimizationGoal,
        billingEvent: opts.billingEvent,
        bidAmount: opts.bidAmount ?? opts.targetCost,
        roasGoal: opts.targetRoas,
        promotedObject: opts.promotedObject ? parseJsonInput(opts.promotedObject, '--promoted-object') : undefined,
      };
      const { errors, warnings } = validateBidConfig(config);
      const result: Record<string, unknown> = {
        objective: opts.objective,
        bid_strategy: opts.bidStrategy,
        optimization_goal: opts.optimizationGoal,
        billing_event: opts.billingEvent,
        valid: errors.length === 0,
        errors,
        warnings,
      };
      if (config.roasGoal !== undefined && errors.length === 0) {
        result.bid_constraints = { roas_average_floor: roasFloor(config.roasGoal) };
      }
      console.log(formatOutput(result, opts.output as OutputFormat));
      if (errors.length) process.exitCode = 1;
    }));

  bidding
    .command('analyze <adsetIds>')
    .description('Analyze bid performance for ad sets (comma-separated IDs): cost per result, ROAS, learning state')
    .option('--time-range <range>', 'Time range (date preset in the account timezone)', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string, opts) => {
      const client = getClient();
      const ids = adsetIds.split(',').map(id => id.trim()).filter(Boolean);
      const results: unknown[] = [];

      for (const id of ids) {
        const adsetResponse = await client.request(id, {
          params: { fields: 'id,name,bid_strategy,bid_amount,bid_constraints,optimization_goal,billing_event,daily_budget,lifetime_budget,status,promoted_object,learning_stage_info,campaign{objective}' },
        });
        const adset = adsetResponse.data as Record<string, unknown>;
        const insightsResponse = await client.request(`${id}/insights`, {
          params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams(opts.timeRange) },
        });
        const event = resultEventFor({
          objective: (adset.campaign as Record<string, string> | undefined)?.objective,
          optimizationGoal: adset.optimization_goal as string | undefined,
          customEventType: (adset.promoted_object as Record<string, string> | undefined)?.custom_event_type,
        });
        results.push({
          adset,
          metrics: deriveMetrics(firstRow(insightsResponse.data), event),
        });
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bidding
    .command('learning-phase [adsetIds]')
    .description('Learning phase status (LEARNING / SUCCESS / FAIL = learning limited) for ad sets, or all active ad sets in an account')
    .option('--account-id <id>', 'Scan every active ad set in this account instead of listing IDs')
    .option('--min-weekly-events <n>', 'Flag ad sets below this many optimization events per week', '50')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string | undefined, opts) => {
      const client = getClient();
      const fields = 'id,name,status,effective_status,bid_strategy,optimization_goal,learning_stage_info,issues_info';
      let adsets: Array<Record<string, unknown>> = [];
      if (opts.accountId) {
        const res = await client.requestAllPages(`${opts.accountId}/adsets`, {
          params: { fields, effective_status: JSON.stringify(['ACTIVE']), limit: '200' },
        });
        adsets = rows(res.data);
      } else if (adsetIds) {
        for (const id of adsetIds.split(',').map(s => s.trim()).filter(Boolean)) {
          adsets.push((await client.request(id, { params: { fields } })).data as Record<string, unknown>);
        }
      } else {
        throw new Error('Pass ad set IDs or --account-id');
      }

      const minWeekly = Number(opts.minWeeklyEvents);
      const results = adsets.map(a => {
        const info = (a.learning_stage_info || {}) as Record<string, unknown>;
        const status = (info.status as string | undefined) || 'UNKNOWN';
        const conversions = Number(info.conversions ?? 0);
        const notes: string[] = [];
        if (status === 'FAIL') notes.push('Learning limited: not enough results to exit learning. Consolidate ad sets, broaden targeting, raise budget, or optimize for a more frequent event.');
        if (status === 'LEARNING') {
          notes.push(`In learning (${conversions} optimization events since the last significant edit). Avoid significant edits until it exits.`);
          if (conversions < minWeekly / 7 * 3) notes.push(`Pace looks below ~${minWeekly} events/week; it may end up learning limited.`);
        }
        return {
          id: a.id,
          name: a.name,
          optimization_goal: a.optimization_goal,
          learning_status: status,
          conversions_since_last_edit: info.conversions,
          last_significant_edit: info.last_sig_edit_ts ? new Date(Number(info.last_sig_edit_ts) * 1000).toISOString() : undefined,
          notes,
        };
      });

      console.log(formatOutput({
        summary: {
          total: results.length,
          learning: results.filter(r => r.learning_status === 'LEARNING').length,
          learning_limited: results.filter(r => r.learning_status === 'FAIL').length,
          success: results.filter(r => r.learning_status === 'SUCCESS').length,
        },
        adsets: results,
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('budget-schedule')
    .description('Create a budget schedule (high-demand period) for a campaign')
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--budget-value <value>', 'Increase in cents (ABSOLUTE) or percent (MULTIPLIER)')
    .requiredOption('--budget-type <type>', 'Budget value type (ABSOLUTE, MULTIPLIER)')
    .requiredOption('--time-start <time>', 'Schedule start time (ISO 8601 or unix seconds)')
    .requiredOption('--time-end <time>', 'Schedule end time (ISO 8601 or unix seconds)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const value = parseNonNegative(opts.budgetValue, '--budget-value');
      const cap = client.getMaxSpendCapCents();
      if (cap && !client.isDryRun()) {
        const c = (await client.request(opts.campaignId, { params: { fields: 'daily_budget,lifetime_budget' } })).data as Record<string, unknown>;
        assertScheduleWithinCap(cap, Number(c.daily_budget || c.lifetime_budget || 0), value, opts.budgetType, opts.campaignId);
      }
      const body: Record<string, string> = {
        budget_value: opts.budgetValue,
        budget_value_type: opts.budgetType,
        time_start: toUnix(opts.timeStart, '--time-start'),
        time_end: toUnix(opts.timeEnd, '--time-end'),
      };

      const response = await client.request(`${opts.campaignId}/budget_schedules`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  bidding
    .command('seasonal-schedule')
    .description('Plan (or with --apply, schedule) seasonal budget increases using Meta budget schedules')
    .requiredOption('--campaign-ids <ids>', 'Comma-separated campaign IDs (campaign budgets)')
    .requiredOption('--adjustment <pct>', 'Increase percentage, e.g. 20 for +20%')
    .requiredOption('--start-date <date>', 'Start date (YYYY-MM-DD)')
    .requiredOption('--end-date <date>', 'End date (YYYY-MM-DD)')
    .option('--pattern <pattern>', 'Label for the period (holiday_boost, etc.)', 'seasonal')
    .option('--apply', 'Create the budget schedules (otherwise only prints the plan)')
    .option('--adset-ids <ids>', 'Deprecated: use --campaign-ids')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const idList: string = opts.campaignIds || opts.adsetIds;
      const ids = idList.split(',').map((id: string) => id.trim()).filter(Boolean);
      const adjustment = parsePositive(opts.adjustment, '--adjustment')!;
      const results: unknown[] = [];

      for (const id of ids) {
        const res = await client.request(id, { params: { fields: 'id,name,daily_budget,account_id' } });
        const entity = res.data as Record<string, unknown>;
        const currentBudget = parseInt(String(entity.daily_budget || 0));
        if (!currentBudget && !client.isDryRun()) {
          results.push({ id, name: entity.name, skipped: 'No campaign daily budget; budget schedules need a campaign budget.' });
          continue;
        }
        const increase = Math.round(currentBudget * adjustment / 100);
        const cap = client.getMaxSpendCapCents();
        const plan: Record<string, unknown> = {
          campaign_id: id,
          campaign_name: entity.name,
          current_daily_budget: currentBudget,
          scheduled_increase_cents: increase,
          budget_during_period: currentBudget + increase,
          ...(cap && currentBudget + increase > cap ? { exceeds_spend_cap: cap } : {}),
          pattern: opts.pattern,
          period: { start: opts.startDate, end: opts.endDate },
        };
        if (opts.apply) {
          assertScheduleWithinCap(cap, currentBudget, increase, 'ABSOLUTE', id);
          // Dates are calendar days in the ad account's timezone.
          const tz = entity.account_id && !client.isDryRun()
            ? ((await client.request(`act_${String(entity.account_id).replace(/^act_/, '')}`, { params: { fields: 'timezone_name' } })).data as Record<string, unknown>).timezone_name as string | undefined
            : undefined;
          const created = await client.request(`${id}/budget_schedules`, {
            method: 'POST',
            body: {
              budget_value: String(increase),
              budget_value_type: 'ABSOLUTE',
              time_start: zonedToUnix(opts.startDate, '00:00:00', tz, '--start-date'),
              time_end: zonedToUnix(opts.endDate, '23:59:59', tz, '--end-date'),
            },
          });
          plan.schedule = created.data;
        }
        results.push(plan);
      }

      console.log(formatOutput({
        applied: Boolean(opts.apply),
        schedules: results,
        note: opts.apply ? undefined : 'Re-run with --apply to create these as Meta budget schedules (the budget rises only during the period).',
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('cpm-benchmark <campaignId>')
    .alias('competitor-analysis')
    .description('Compare a campaign\'s CPM with the account\'s own history by platform (Meta has no auction-insights API)')
    .option('--time-range <range>', 'Window for the campaign', 'last_7d')
    .option('--baseline-range <range>', 'Window for the account baseline', 'last_90d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const campaignResponse = await client.request(campaignId, {
        params: { fields: 'id,name,objective,account_id' },
      });
      const campaign = campaignResponse.data as Record<string, unknown>;
      const accountId = campaign.account_id ? `act_${campaign.account_id}` : undefined;

      const params = { fields: 'spend,impressions,cpm', breakdowns: 'publisher_platform' };
      const current = await client.request(`${campaignId}/insights`, { params: { ...params, ...insightsTimeParams(opts.timeRange) } });
      const baseline = accountId
        ? await client.request(`${accountId}/insights`, { params: { ...params, ...insightsTimeParams(opts.baselineRange) } })
        : { data: { data: [] } };

      const baseByPlatform = new Map(rows(baseline.data).map(r => [String(r.publisher_platform), Number(r.cpm)]));
      const comparison = rows(current.data).map(r => {
        const cpm = Number(r.cpm);
        const base = baseByPlatform.get(String(r.publisher_platform));
        const deltaPct = base ? (cpm - base) / base * 100 : null;
        return {
          publisher_platform: r.publisher_platform,
          impressions: Number(r.impressions),
          cpm,
          account_baseline_cpm: base ?? null,
          delta_pct: deltaPct === null ? null : Number(deltaPct.toFixed(1)),
          note: deltaPct === null ? 'No account baseline for this platform'
            : deltaPct > 25 ? 'Well above your own baseline: check audience size, frequency and seasonality'
              : deltaPct < -25 ? 'Well below your own baseline' : 'In line with your baseline',
        };
      });

      console.log(formatOutput({
        campaign,
        window: opts.timeRange,
        baseline_window: opts.baselineRange,
        cpm_by_platform: comparison,
        note: 'Meta does not expose auction insights or competitor bids. For competitor creative, use: meta-ads library search.',
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('optimize-budget')
    .description('Budget reallocation across campaigns by cost per result / ROAS, with volume floors and learning guards')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)')
    .option('--time-range <range>', 'Evaluation window (date preset in the account timezone)', 'last_7d')
    .option('--target-cpa <amount>', 'Target cost per result, in account currency units')
    .option('--target-roas <roas>', 'Target ROAS (e.g. 2.5); ranks by ROAS instead of cost per result')
    .option('--min-results <n>', 'Minimum results in the window before acting on a campaign', '10')
    .option('--min-spend <amount>', 'Minimum spend in the window, currency units', '0')
    .option('--max-change-pct <pct>', 'Largest budget change per step', '20')
    .option('--apply', 'Apply the proposed campaign budgets (campaign budgets only; skips campaigns in learning)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const targetCpa = parsePositive(opts.targetCpa, '--target-cpa');
      const targetRoas = parsePositive(opts.targetRoas, '--target-roas');
      const maxChange = parsePct(opts.maxChangePct, '--max-change-pct');
      const floors = { minResults: parseNonNegative(opts.minResults, '--min-results'), minSpend: parseNonNegative(opts.minSpend, '--min-spend') };

      const [insightsResponse, campaignsResponse, learning] = await Promise.all([
        client.requestAllPages(`${opts.accountId}/insights`, {
          params: { fields: `campaign_id,campaign_name,${PERFORMANCE_FIELDS}`, level: 'campaign', limit: '200', ...insightsTimeParams(opts.timeRange) },
        }),
        client.requestAllPages(`${opts.accountId}/campaigns`, {
          params: { fields: 'id,name,objective,daily_budget,lifetime_budget,effective_status,promoted_object', limit: '200' },
        }),
        learningByCampaign(client, opts.accountId),
      ]);
      const campaignMeta = new Map(rows(campaignsResponse.data).map(c => [String(c.id), c]));

      const scored: Scored[] = rows(insightsResponse.data).map(r => {
        const meta = campaignMeta.get(String(r.campaign_id)) || {};
        const event = resultEventFor({
          objective: meta.objective as string | undefined,
          customEventType: (meta.promoted_object as Record<string, string> | undefined)?.custom_event_type,
        });
        const metrics = deriveMetrics(r, event);
        return {
          id: String(r.campaign_id),
          name: r.campaign_name,
          objective: meta.objective as string | undefined,
          metrics,
          learning: learning.get(String(r.campaign_id)) || [],
          enoughVolume: hasEnoughVolume(metrics, floors),
        };
      });

      // Each campaign is judged on its own KPI and ranked only against
      // campaigns with the same KPI: lead or traffic campaigns have no ROAS.
      const ranks = rankWithinGroups(scored);

      const plan = [];
      for (const s of scored) {
        const meta = campaignMeta.get(s.id) || {};
        const current = Number(meta.daily_budget || 0);
        const reasons: string[] = [];
        let action = 'MAINTAIN';
        const r = ranks.get(s);
        const useRoas = r?.group === 'roas';
        const rank = r?.rank ?? -1;
        const groupSize = r?.size ?? 0;
        const third = Math.max(1, Math.floor(groupSize / 3));
        const target = useRoas ? targetRoas : targetCpa;

        if (!s.enoughVolume) {
          action = 'HOLD';
          reasons.push(`Not enough data (${s.metrics.results} ${s.metrics.result_event} results, ${s.metrics.spend.toFixed(2)} spend); floors are ${floors.minResults} results / ${floors.minSpend} spend.`);
        } else if (s.learning.includes('LEARNING')) {
          action = 'HOLD';
          reasons.push('An ad set is still in the learning phase; budget changes now would reset it.');
        } else {
          const tooFewToRank = !target && groupSize < 2;
          const beatsTarget = useRoas
            ? (targetRoas ? (s.metrics.roas as number) >= targetRoas : rank < third)
            : (targetCpa ? (s.metrics.cost_per_result ?? Infinity) <= targetCpa : rank < third);
          const missesTarget = useRoas
            ? (targetRoas ? (s.metrics.roas as number) < targetRoas * 0.8 : rank >= groupSize - third)
            : (targetCpa ? (s.metrics.cost_per_result ?? Infinity) > targetCpa * 1.2 : rank >= groupSize - third);
          const kpi = useRoas
            ? `ROAS ${s.metrics.roas?.toFixed(2) ?? 'n/a'}${targetRoas ? ` vs target ${targetRoas}` : ''}`
            : `cost per ${s.metrics.result_event} ${s.metrics.cost_per_result?.toFixed(2) ?? 'n/a'}${targetCpa ? ` vs target ${targetCpa}` : ''}`;
          const peers = `${useRoas ? 'ROAS' : 'cost-per-result'} campaigns`;
          if (tooFewToRank) {
            reasons.push(`${kpi}; no other ${peers} to compare with and no target set.`);
          } else if (beatsTarget && !missesTarget) {
            action = 'INCREASE';
            reasons.push(`${kpi}${target ? '' : ` (top third of eligible ${peers})`}.`);
          } else if (missesTarget) {
            action = 'DECREASE';
            reasons.push(`${kpi}${target ? '' : ` (bottom third of eligible ${peers})`}.`);
          } else {
            reasons.push(`${kpi}; within range.`);
          }
          if (action === 'INCREASE' && (s.metrics.frequency ?? 0) > 3) {
            action = 'MAINTAIN';
            reasons.push(`Frequency ${s.metrics.frequency?.toFixed(1)} suggests the audience is saturating; expand the audience before adding budget.`);
          }
        }

        const proposed = action === 'INCREASE' ? capChange(current, current * (1 + maxChange / 100), maxChange)
          : action === 'DECREASE' ? capChange(current, current * (1 - maxChange / 100), maxChange)
            : current;
        const entry: Record<string, unknown> = {
          campaign_id: s.id,
          campaign_name: s.name,
          objective: s.objective,
          result_event: s.metrics.result_event,
          spend: Number(s.metrics.spend.toFixed(2)),
          results: s.metrics.results,
          cost_per_result: s.metrics.cost_per_result === null ? null : Number(s.metrics.cost_per_result.toFixed(2)),
          roas: s.metrics.roas === null ? null : Number(s.metrics.roas.toFixed(2)),
          learning: s.learning,
          action,
          reasons,
          current_daily_budget: current || null,
          proposed_daily_budget: current ? proposed : null,
        };
        if (!current && (action === 'INCREASE' || action === 'DECREASE')) {
          entry.note = 'Budget is set on the ad sets (or is a lifetime budget); adjust those instead.';
        }
        if (opts.apply && current && proposed !== current) {
          const res = await client.request(s.id, { method: 'POST', body: { daily_budget: String(proposed) } });
          entry.applied = res.data;
        }
        plan.push(entry);
      }

      console.log(formatOutput({
        account_id: opts.accountId,
        window: opts.timeRange,
        // Each campaign is ranked only against campaigns with the same KPI.
        ranked_by: rankedBy(ranks),
        applied: Boolean(opts.apply),
        campaigns: plan,
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('recommendations')
    .description('Bid strategy recommendations for a goal')
    .requiredOption('--objective <objective>', 'Campaign objective (OUTCOME_TRAFFIC, OUTCOME_SALES, etc.)')
    .requiredOption('--target-metric <metric>', 'What you are held to: volume, cpa, roas')
    .option('--budget-range <range>', 'Budget range (low, medium, high)', 'medium')
    .option('--business-type <type>', 'Business type (ecommerce, saas, local, agency)', 'ecommerce')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const strategies: Array<Record<string, unknown>> = [];
      const goal = DEFAULT_GOAL_BY_OBJECTIVE[opts.objective];
      if (!goal) throw new Error(`Unknown objective: ${opts.objective}. Use one of: ${Object.keys(DEFAULT_GOAL_BY_OBJECTIVE).join(', ')}`);

      if (opts.targetMetric === 'roas') {
        if (opts.objective !== 'OUTCOME_SALES' && opts.objective !== 'OUTCOME_APP_PROMOTION') {
          throw new Error('ROAS goals need a purchase-value signal: use OUTCOME_SALES or OUTCOME_APP_PROMOTION.');
        }
        strategies.push({ strategy: 'LOWEST_COST_WITHOUT_CAP', optimization_goal: 'VALUE', reason: 'Highest value: spend the budget for the most purchase value. Start here to learn your achievable ROAS.', risk: 'low' });
        strategies.push({ strategy: 'LOWEST_COST_WITH_MIN_ROAS', optimization_goal: 'VALUE', reason: 'ROAS goal (bid_constraints.roas_average_floor). Set it near the ROAS you already achieve; too high throttles delivery.', risk: 'medium', flags: '--bid-strategy LOWEST_COST_WITH_MIN_ROAS --roas-goal <x>' });
      } else if (opts.targetMetric === 'cpa') {
        strategies.push({ strategy: 'LOWEST_COST_WITHOUT_CAP', optimization_goal: goal, reason: 'Highest volume: establish a baseline CPA first.', risk: 'low' });
        strategies.push({ strategy: 'COST_CAP', optimization_goal: goal, reason: 'Keeps average cost per result near the cap. Set the cap at or slightly above your current CPA; a low cap under-delivers.', risk: 'medium', flags: '--bid-strategy COST_CAP --bid-amount <cents>' });
        strategies.push({ strategy: 'LOWEST_COST_WITH_BID_CAP', optimization_goal: goal, reason: 'Hard cap on each auction bid. Most control, most risk of under-delivery; for experienced buyers.', risk: 'high' });
      } else {
        strategies.push({ strategy: 'LOWEST_COST_WITHOUT_CAP', optimization_goal: goal, reason: 'Highest volume: the most results for the budget. Recommended default.', risk: 'low' });
      }

      const notes = [
        'TARGET_COST was deprecated in Marketing API v9; use COST_CAP.',
        'Budget on the campaign is Advantage+ campaign budget (formerly CBO).',
        'Give a new strategy ~50 optimization events per ad set per week before judging it.',
      ];
      if (opts.budgetRange === 'low') notes.push('With a low budget, avoid caps: they need volume to learn. Consolidate into fewer ad sets.');

      console.log(formatOutput({
        objective: opts.objective,
        default_optimization_goal: goal,
        target_metric: opts.targetMetric,
        budget_range: opts.budgetRange,
        business_type: opts.businessType,
        strategies,
        notes,
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('auto-adjustments <adsetIds>')
    .description('Cost-cap / bid-cap / ROAS-floor adjustments from cost per result and delivery (comma-separated IDs)')
    .option('--target-cpa <amount>', 'Target cost per result in currency units (defaults to the current cap)')
    .option('--time-range <range>', 'Evaluation window', 'last_7d')
    .option('--min-results <n>', 'Minimum results before adjusting', '10')
    .option('--max-change-pct <pct>', 'Largest bid change per step', '10')
    .option('--apply', 'Apply the recommended bids (skips ad sets in learning)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetIds: string, opts) => {
      const client = getClient();
      const ids = adsetIds.split(',').map((id: string) => id.trim()).filter(Boolean);
      const targetCpa = parsePositive(opts.targetCpa, '--target-cpa');
      const maxChange = parsePct(opts.maxChangePct, '--max-change-pct');
      const minResults = parseNonNegative(opts.minResults, '--min-results');
      const days = presetDays(opts.timeRange);
      const adjustments: unknown[] = [];

      for (const id of ids) {
        const [adset, insights] = await Promise.all([
          client.request(id, { params: { fields: 'id,name,account_id,bid_amount,bid_strategy,bid_constraints,daily_budget,optimization_goal,promoted_object,learning_stage_info,campaign{objective}' } }),
          client.request(`${id}/insights`, { params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams(opts.timeRange) } }),
        ]);
        const a = adset.data as Record<string, unknown>;
        const event = resultEventFor({
          objective: (a.campaign as Record<string, string> | undefined)?.objective,
          optimizationGoal: a.optimization_goal as string | undefined,
          customEventType: (a.promoted_object as Record<string, string> | undefined)?.custom_event_type,
        });
        const m = deriveMetrics(firstRow(insights.data), event);
        const strategy = a.bid_strategy as string | undefined;
        const learningStatus = (a.learning_stage_info as Record<string, string> | undefined)?.status;
        const currentBid = Number(a.bid_amount || 0);
        const roasFloorCurrent = Number((a.bid_constraints as Record<string, unknown> | undefined)?.roas_average_floor || 0);
        // Budgets and bids are in minor units; insights spend is in major units.
        const factor = minorUnitFactor(await accountCurrency(client, a.account_id));
        const dailyBudget = Number(a.daily_budget || 0) / factor;
        const delivery = dailyBudget ? m.spend / (dailyBudget * days) : null;
        const reasons: string[] = [];
        let action = 'no_change';
        let recommended: Record<string, unknown> = {};

        if (learningStatus === 'LEARNING') {
          reasons.push('In the learning phase; bid edits would reset it.');
        } else if (m.results < minResults) {
          reasons.push(`Only ${m.results} ${event} results in the window (floor ${minResults}); not enough to judge.`);
        } else if ((strategy === 'COST_CAP' || strategy === 'LOWEST_COST_WITH_BID_CAP') && currentBid <= 0) {
          reasons.push('No current bid amount to adjust; set one with adsets update --bid-amount.');
        } else if (strategy === 'COST_CAP' || strategy === 'LOWEST_COST_WITH_BID_CAP') {
          const target = targetCpa ?? currentBid / factor;
          const cpa = m.cost_per_result ?? Infinity;
          if (delivery !== null && delivery < 0.7 && cpa <= target) {
            action = 'raise_bid';
            recommended = { bid_amount: capChange(currentBid, currentBid * (1 + maxChange / 100), maxChange) };
            reasons.push(`Under-delivering (${(delivery * 100).toFixed(0)}% of budget spent) with cost per ${event} ${cpa.toFixed(2)} ≤ target ${target.toFixed(2)}: the cap is likely too tight.`);
          } else if (cpa > target * 1.2) {
            action = 'lower_bid';
            recommended = { bid_amount: capChange(currentBid, currentBid * (1 - maxChange / 100), maxChange) };
            reasons.push(`Cost per ${event} ${cpa.toFixed(2)} is over 120% of target ${target.toFixed(2)}.`);
          } else {
            reasons.push(`Cost per ${event} ${Number.isFinite(cpa) ? cpa.toFixed(2) : 'n/a'} is near target ${target.toFixed(2)}.`);
          }
        } else if (strategy === 'LOWEST_COST_WITH_MIN_ROAS' && roasFloorCurrent) {
          const floor = roasFloorCurrent / 10000;
          if (delivery !== null && delivery < 0.7 && (m.roas ?? 0) >= floor * 1.2) {
            action = 'lower_roas_floor';
            recommended = { bid_constraints: { roas_average_floor: capChange(roasFloorCurrent, roasFloorCurrent * (1 - maxChange / 100), maxChange) } };
            reasons.push(`Under-delivering with ROAS ${(m.roas ?? 0).toFixed(2)} well above the ${floor} floor: a lower floor should unlock volume.`);
          } else {
            reasons.push(`ROAS ${(m.roas ?? 0).toFixed(2)} vs floor ${floor}.`);
          }
        } else {
          reasons.push(`Bid strategy ${strategy || 'LOWEST_COST_WITHOUT_CAP'} has no bid to adjust; manage it with budget instead.`);
        }

        const entry: Record<string, unknown> = {
          adset_id: id,
          adset_name: a.name,
          bid_strategy: strategy,
          learning_status: learningStatus,
          current_bid: currentBid || undefined,
          current_roas_floor: roasFloorCurrent || undefined,
          action,
          recommended,
          reasons,
          metrics: { result_event: event, results: m.results, spend: m.spend, cost_per_result: m.cost_per_result, roas: m.roas, delivery_ratio: delivery },
        };
        if (opts.apply && action !== 'no_change') {
          const body: Record<string, string> = {};
          for (const [k, v] of Object.entries(recommended)) body[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
          entry.applied = (await client.request(id, { method: 'POST', body })).data;
        }
        adjustments.push(entry);
      }

      console.log(formatOutput(adjustments, opts.output as OutputFormat));
    }));

  bidding
    .command('cross-campaign-coordination')
    .description('Split a budget pool across campaigns by cost per result / ROAS, with volume floors and a per-step change cap')
    .requiredOption('--campaign-ids <ids>', 'Comma-separated campaign IDs')
    .option('--total-budget <cents>', 'Total daily budget pool in cents (defaults to the sum of current budgets)')
    .option('--time-range <range>', 'Evaluation window', 'last_7d')
    .option('--min-results <n>', 'Minimum results before a campaign is judged', '10')
    .option('--max-change-pct <pct>', 'Largest change per campaign per step', '20')
    .option('--strategy <strategy>', 'Deprecated; ignored', 'balanced')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.campaignIds.split(',').map((id: string) => id.trim()).filter(Boolean);
      const maxChange = parsePct(opts.maxChangePct, '--max-change-pct');
      const minResults = parseNonNegative(opts.minResults, '--min-results');
      const totalBudget = opts.totalBudget !== undefined ? parsePositive(opts.totalBudget, '--total-budget') : undefined;
      const entries: Array<Scored & { budget: number }> = [];

      for (const id of ids) {
        const [campaign, insights] = await Promise.all([
          client.request(id, { params: { fields: 'id,name,daily_budget,objective,promoted_object' } }),
          client.request(`${id}/insights`, { params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams(opts.timeRange) } }),
        ]);
        const c = campaign.data as Record<string, unknown>;
        const event = resultEventFor({
          objective: c.objective as string | undefined,
          customEventType: (c.promoted_object as Record<string, string> | undefined)?.custom_event_type,
        });
        const metrics = deriveMetrics(firstRow(insights.data), event);
        entries.push({
          id, name: c.name, objective: c.objective as string | undefined, metrics, learning: [],
          enoughVolume: metrics.results >= minResults, budget: Number(c.daily_budget || 0),
        });
      }

      const pool = totalBudget ?? entries.reduce((s, e) => s + e.budget, 0);
      const judged = entries.filter(e => e.enoughVolume);
      const currentTotal = entries.reduce((s, e) => s + e.budget, 0);
      // Unjudged campaigns keep their budget; the rest of the pool is split.
      const judgedPool = pool - entries.filter(e => !e.enoughVolume).reduce((s, e) => s + e.budget, 0);
      const judgedCurrent = judged.reduce((s, e) => s + e.budget, 0);
      // ROAS and cost per result aren't comparable, so each KPI group keeps its
      // current share of the pool and is split by efficiency within the group.
      const groups = new Map<KpiGroup, typeof judged>();
      for (const e of judged) groups.set(kpiGroup(e), [...(groups.get(kpiGroup(e)) || []), e]);

      const allocation = entries.map(e => {
        const group = kpiGroup(e);
        const members = groups.get(group) || [];
        const groupEff = members.reduce((s, m) => s + efficiency(m, group === 'roas'), 0);
        if (!e.enoughVolume || groupEff === 0) {
          return { campaign_id: e.id, campaign_name: e.name, current_daily_budget: e.budget, proposed_daily_budget: e.budget, reason: 'Not enough results to judge; budget unchanged.' };
        }
        const groupCurrent = members.reduce((s, m) => s + m.budget, 0);
        const groupPool = judgedCurrent > 0 ? judgedPool * (groupCurrent / judgedCurrent) : judgedPool / groups.size;
        const share = efficiency(e, group === 'roas') / groupEff;
        const target = groupPool * share;
        const proposed = capChange(e.budget, target, maxChange);
        return {
          campaign_id: e.id,
          campaign_name: e.name,
          result_event: e.metrics.result_event,
          cost_per_result: e.metrics.cost_per_result,
          roas: e.metrics.roas,
          current_daily_budget: e.budget,
          efficiency_share: Number((share * 100).toFixed(1)),
          proposed_daily_budget: proposed,
          kpi: group,
          reason: `${group === 'roas' ? 'ROAS' : 'Results per spend'} share ${(share * 100).toFixed(0)}% among ${group === 'roas' ? 'campaigns with revenue' : 'cost-per-result campaigns'}; change capped at ${maxChange}% per step.`,
        };
      });

      console.log(formatOutput({
        pool_daily_budget: pool,
        current_total_daily_budget: currentTotal,
        ranked_by: 'roas within campaigns with revenue, cost per result within the rest',
        allocation,
        note: 'Campaigns that overlap in audience compete in the same auctions; consider consolidating them instead of splitting budget.',
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('scaling-recommendation <campaignId>')
    .description('Whether a campaign can take more budget: cost per result vs target, frequency, learning state, pacing')
    .option('--target-cpa <amount>', 'Target cost per result in currency units')
    .option('--target-roas <roas>', 'Target ROAS')
    .option('--time-range <range>', 'Evaluation window', 'last_7d')
    .option('--min-results <n>', 'Minimum results before recommending a scale-up', '20')
    .option('--max-change-pct <pct>', 'Largest budget step', '20')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const targetCpa = parsePositive(opts.targetCpa, '--target-cpa');
      const targetRoas = parsePositive(opts.targetRoas, '--target-roas');
      const maxChange = parsePct(opts.maxChangePct, '--max-change-pct');
      const [campaign, insights, learning] = await Promise.all([
        client.request(campaignId, { params: { fields: 'id,name,daily_budget,lifetime_budget,bid_strategy,objective,status,promoted_object' } }),
        client.request(`${campaignId}/insights`, { params: { fields: PERFORMANCE_FIELDS, ...insightsTimeParams(opts.timeRange) } }),
        learningByCampaign(client, campaignId),
      ]);

      const c = campaign.data as Record<string, unknown>;
      const event = resultEventFor({
        objective: c.objective as string | undefined,
        customEventType: (c.promoted_object as Record<string, string> | undefined)?.custom_event_type,
      });
      const m = deriveMetrics(firstRow(insights.data), event);
      const currentBudget = Number(c.daily_budget || 0);
      const learningStates = learning.get(campaignId) || [];
      const reasons: string[] = [];
      let scalingAction = 'maintain';
      let suggestedBudget = currentBudget;

      const kpiOk = targetRoas !== undefined ? (m.roas ?? 0) >= targetRoas
        : targetCpa !== undefined ? (m.cost_per_result ?? Infinity) <= targetCpa
          : null;

      if (m.results < parseNonNegative(opts.minResults, '--min-results')) {
        scalingAction = 'gather_data';
        reasons.push(`Only ${m.results} ${event} results in the window; wait for at least ${opts.minResults} before scaling.`);
      } else if (learningStates.includes('LEARNING')) {
        scalingAction = 'wait_for_learning';
        reasons.push('Ad sets are still learning; scaling now would reset learning.');
      } else if (learningStates.includes('FAIL')) {
        scalingAction = 'fix_learning_limited';
        reasons.push('Some ad sets are learning limited; consolidate or broaden before adding budget.');
      } else if ((m.frequency ?? 0) > 3) {
        scalingAction = 'expand_audience';
        reasons.push(`Frequency ${m.frequency?.toFixed(1)} over the window: the audience is saturating, so more budget would mostly raise frequency.`);
      } else if (kpiOk === false) {
        scalingAction = 'optimize_first';
        reasons.push(targetRoas !== undefined
          ? `ROAS ${(m.roas ?? 0).toFixed(2)} is below the ${targetRoas} target.`
          : `Cost per ${event} ${(m.cost_per_result ?? 0).toFixed(2)} is above the ${targetCpa} target.`);
      } else {
        scalingAction = 'scale_up';
        suggestedBudget = capChange(currentBudget, currentBudget * (1 + maxChange / 100), maxChange);
        reasons.push(kpiOk === null
          ? 'Enough volume, not learning, frequency healthy. No target given, so check cost per result before scaling further.'
          : 'Hitting target with enough volume and healthy frequency.');
        reasons.push(`Raise budget by at most ${maxChange}% per step and wait a few days between steps.`);
      }
      if (!currentBudget) reasons.push('No campaign daily budget: scale the ad set budgets (or lifetime budget) instead.');

      console.log(formatOutput({
        campaign_id: campaignId,
        campaign_name: c.name,
        current_daily_budget: currentBudget || null,
        suggested_daily_budget: currentBudget ? suggestedBudget : null,
        scaling_action: scalingAction,
        reasons,
        learning: learningStates,
        metrics: m,
      }, opts.output as OutputFormat));
    }));

  bidding
    .command('pacing <campaignId>')
    .description('Is the campaign on pace? Spend to date vs flight elapsed (lifetime) or vs daily budget')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const res = await client.request(campaignId, {
        params: { fields: 'id,name,account_id,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,effective_status' },
      });
      const c = res.data as Record<string, unknown>;
      const factor = minorUnitFactor(await accountCurrency(client, c.account_id));
      const now = Date.now();
      const result: Record<string, unknown> = { campaign_id: campaignId, campaign_name: c.name, status: c.effective_status };

      if (Number(c.lifetime_budget) > 0) {
        const lifetime = Number(c.lifetime_budget) / factor;
        const remaining = Number(c.budget_remaining || 0) / factor;
        const spent = lifetime - remaining;
        const start = Date.parse(String(c.start_time));
        const stop = Date.parse(String(c.stop_time));
        result.lifetime_budget = lifetime;
        result.spent = Number(spent.toFixed(2));
        if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
          const elapsed = Math.min(1, Math.max(0, (now - start) / (stop - start)));
          const spentPct = lifetime ? spent / lifetime : 0;
          const projected = elapsed > 0 ? spent / elapsed : 0;
          result.flight_elapsed_pct = Number((elapsed * 100).toFixed(1));
          result.budget_spent_pct = Number((spentPct * 100).toFixed(1));
          result.projected_total_spend = Number(projected.toFixed(2));
          result.pace = elapsed === 0 ? 'not_started'
            : spentPct < elapsed * 0.85 ? 'under_pacing'
              : spentPct > elapsed * 1.15 ? 'over_pacing' : 'on_pace';
        } else {
          result.pace = 'unknown';
          result.note = 'No start/stop time to measure the flight against.';
        }
      } else if (Number(c.daily_budget) > 0) {
        const daily = Number(c.daily_budget) / factor;
        const insights = await client.request(`${campaignId}/insights`, {
          params: { fields: 'spend', time_increment: '1', ...insightsTimeParams('last_7d') },
        });
        const days = rows(insights.data).map(r => ({ date: r.date_start, spend: Number(r.spend) }));
        const avg = days.length ? days.reduce((s, d) => s + d.spend, 0) / days.length : 0;
        result.daily_budget = daily;
        result.last_7d_daily_spend = days;
        result.avg_daily_spend = Number(avg.toFixed(2));
        result.delivery_pct = daily ? Number((avg / daily * 100).toFixed(1)) : null;
        result.pace = !daily || !days.length ? 'unknown' : avg < daily * 0.7 ? 'under_delivering' : 'on_pace';
        result.note = 'Meta may spend up to 75% over the daily budget on a given day, averaging out over the week.';
      } else {
        result.pace = 'unknown';
        result.note = 'Budget is set on the ad sets; check pacing per ad set.';
      }

      console.log(formatOutput(result, opts.output as OutputFormat));
    }));
}

/** Accept ISO 8601 or unix seconds; Meta budget schedules take unix seconds. */
function toUnix(value: string, flag: string): string {
  if (/^\d+$/.test(value)) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${flag}: invalid time "${value}". Use ISO 8601 or unix seconds.`);
  return String(Math.floor(ms / 1000));
}
