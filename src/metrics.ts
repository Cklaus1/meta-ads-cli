/**
 * Shared performance math for insights rows: one canonical action type per
 * conversion event (Meta reports the same purchase under several types, so
 * summing them double-counts), the result for each objective, revenue from
 * action_values, and derived cost per result / ROAS.
 */

export type InsightsRow = Record<string, unknown>;
type ActionList = Array<{ action_type: string; value: string | number }>;

// Ordered by preference; the first type present in a row is used.
export const CANONICAL_ACTION_TYPES: Record<string, string[]> = {
  purchase: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'],
  lead: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'],
  add_to_cart: ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'],
  initiate_checkout: ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
  complete_registration: ['omni_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration'],
  app_install: ['omni_app_install', 'mobile_app_install', 'app_install'],
  landing_page_view: ['omni_landing_page_view', 'landing_page_view'],
  link_click: ['link_click'],
  post_engagement: ['post_engagement'],
  video_view: ['video_view'],
  thruplay: ['video_thruplay_watched_actions'],
  messaging_conversation_started: ['onsite_conversion.messaging_conversation_started_7d'],
};

// Pixel/CAPI custom_event_type → canonical event.
const CUSTOM_EVENT_TO_EVENT: Record<string, string> = {
  PURCHASE: 'purchase',
  LEAD: 'lead',
  ADD_TO_CART: 'add_to_cart',
  INITIATED_CHECKOUT: 'initiate_checkout',
  COMPLETE_REGISTRATION: 'complete_registration',
};

const GOAL_TO_EVENT: Record<string, string> = {
  LINK_CLICKS: 'link_click',
  LANDING_PAGE_VIEWS: 'landing_page_view',
  LEAD_GENERATION: 'lead',
  QUALITY_LEAD: 'lead',
  APP_INSTALLS: 'app_install',
  POST_ENGAGEMENT: 'post_engagement',
  THRUPLAY: 'thruplay',
  CONVERSATIONS: 'messaging_conversation_started',
  VALUE: 'purchase',
};

const OBJECTIVE_TO_EVENT: Record<string, string> = {
  OUTCOME_SALES: 'purchase',
  OUTCOME_LEADS: 'lead',
  OUTCOME_TRAFFIC: 'link_click',
  OUTCOME_ENGAGEMENT: 'post_engagement',
  OUTCOME_APP_PROMOTION: 'app_install',
  // Awareness is measured by reach, not an action.
  OUTCOME_AWARENESS: 'reach',
};

/** The event that counts as a "result", most specific signal first. */
export function resultEventFor(opts: { objective?: string; optimizationGoal?: string; customEventType?: string }): string {
  if (opts.customEventType && CUSTOM_EVENT_TO_EVENT[opts.customEventType]) return CUSTOM_EVENT_TO_EVENT[opts.customEventType];
  if (opts.optimizationGoal && GOAL_TO_EVENT[opts.optimizationGoal]) return GOAL_TO_EVENT[opts.optimizationGoal];
  if (opts.objective && OBJECTIVE_TO_EVENT[opts.objective]) return OBJECTIVE_TO_EVENT[opts.objective];
  return 'link_click';
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Value of one event from an action list, using its canonical type only (no double counting). */
export function actionValue(list: unknown, event: string): number {
  if (!Array.isArray(list)) return 0;
  const types = CANONICAL_ACTION_TYPES[event] || [event];
  for (const type of types) {
    const hit = (list as ActionList).find(a => a.action_type === type);
    if (hit) return num(hit.value);
  }
  return 0;
}

export interface DerivedMetrics {
  result_event: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number;
  cost_per_result: number | null;
  revenue: number;
  roas: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  frequency: number | null;
}

/** Derive buyer-facing metrics from an insights row. Money is in account currency units. */
export function deriveMetrics(row: InsightsRow, resultEvent: string): DerivedMetrics {
  const spend = num(row.spend);
  const impressions = num(row.impressions);
  const reach = num(row.reach);
  const clicks = num(row.inline_link_clicks ?? row.clicks);
  const results = resultEvent === 'reach' ? reach : actionValue(row.actions, resultEvent);
  const revenue = actionValue(row.action_values, resultEvent === 'reach' ? 'purchase' : resultEvent);
  return {
    result_event: resultEvent,
    spend,
    impressions,
    reach,
    clicks,
    results,
    cost_per_result: results > 0 ? spend / results : null,
    revenue,
    roas: spend > 0 && revenue > 0 ? revenue / spend : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    frequency: reach > 0 ? impressions / reach : null,
  };
}

/** Insights fields needed by deriveMetrics. */
export const PERFORMANCE_FIELDS = 'spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values,cpm,ctr,cpc';

/** True when a row has enough volume to judge (avoids acting on noise). */
export function hasEnoughVolume(m: DerivedMetrics, floors: { minSpend?: number; minResults?: number; minImpressions?: number }): boolean {
  if (floors.minSpend !== undefined && m.spend < floors.minSpend) return false;
  if (floors.minResults !== undefined && m.results < floors.minResults) return false;
  if (floors.minImpressions !== undefined && m.impressions < floors.minImpressions) return false;
  return true;
}

/**
 * Two-proportion z-test (e.g. conversion rate of A vs B). Returns the
 * two-sided p-value; small values mean the difference is unlikely to be noise.
 */
export function compareProportions(successA: number, totalA: number, successB: number, totalB: number): { z: number; pValue: number } {
  if (totalA <= 0 || totalB <= 0) return { z: 0, pValue: 1 };
  const pA = successA / totalA;
  const pB = successB / totalB;
  const pooled = (successA + successB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (pA - pB) / se;
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun approximation (error < 7.5e-8).
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}

/**
 * Minor units per major unit for a currency (100 for USD, 1 for JPY/KRW).
 * Meta budgets are in the currency's minor unit, so convert with this
 * instead of assuming cents.
 */
export function minorUnitFactor(currency: string | undefined): number {
  if (!currency) return 100;
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    return 100;
  }
}
