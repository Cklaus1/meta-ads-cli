import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { actionValue, deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, type DerivedMetrics } from '../metrics.js';
import { META_DATE_PRESETS, runInsights, TIME_RANGE_HELP } from './insights.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

type Row = Record<string, unknown>;

/** The result event for a row: --result-event, else the row's objective/optimization goal. */
function eventFor(insight: Row, resultEvent?: string): string {
  return resultEvent || resultEventFor({
    objective: insight.objective as string | undefined,
    optimizationGoal: insight.optimization_goal as string | undefined,
  });
}

/**
 * Purchase ROAS from an insights row: revenue (action_values, canonical
 * purchase type only) / spend, falling back to Meta's purchase_roas list.
 */
export function getRoas(insight: Row): number | undefined {
  const spend = Number(insight.spend) || 0;
  const revenue = actionValue(insight.action_values, 'purchase');
  if (spend > 0 && revenue > 0) return Number((revenue / spend).toFixed(4));
  const list = insight.purchase_roas as Array<{ action_type?: string; value?: string | number }> | undefined;
  if (!Array.isArray(list) || list.length === 0) return spend > 0 && Array.isArray(insight.action_values) ? 0 : undefined;
  const omni = list.find(a => a.action_type === 'omni_purchase');
  return parseFloat(String((omni ?? list[0]).value ?? 0)) || 0;
}

/**
 * Results for the row's objective (or resultEvent), counting each event once:
 * Meta reports the same purchase as purchase, omni_purchase and the pixel
 * type, so summing them over-counts.
 */
export function getConversions(insight: Row, resultEvent?: string): number {
  const event = eventFor(insight, resultEvent);
  return event === 'reach' ? Number(insight.reach) || 0 : actionValue(insight.actions, event);
}

function parseThreshold(value: string, name: string): number {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got: "${value}"`);
  return n;
}

export interface PauseThresholds {
  maxCpc?: string; maxSpend?: string; minRoas?: string; maxCpa?: string;
  minSpend?: string; minImpressions?: string; minResults?: string; resultEvent?: string;
}

/** Volume floors below which a cost/ROAS judgement is noise. */
export const DEFAULT_FLOORS = { minImpressions: '1000', minResults: '3' };

/**
 * Reasons an entity's insights breach the thresholds (empty = keep running).
 * Cost and ROAS rules only fire once the row clears the volume floors, and
 * a CPA rule with no results fires only after spending 2× the target CPA.
 */
export function pauseReasons(insight: Row, opts: PauseThresholds): string[] {
  const reasons: string[] = [];
  const m: DerivedMetrics = deriveMetrics(insight, eventFor(insight, opts.resultEvent));
  const minSpend = opts.minSpend ? parseThreshold(opts.minSpend, '--min-spend') : 0;
  const minImpressions = parseThreshold(opts.minImpressions ?? DEFAULT_FLOORS.minImpressions, '--min-impressions');
  const minResults = parseThreshold(opts.minResults ?? DEFAULT_FLOORS.minResults, '--min-results');
  const enoughDelivery = m.spend >= minSpend && m.impressions >= minImpressions;

  if (opts.maxSpend) {
    const max = parseThreshold(opts.maxSpend, '--max-spend');
    if (m.spend > max) reasons.push(`Spend ${m.spend} > ${max}`);
  }
  if (opts.maxCpc) {
    const max = parseThreshold(opts.maxCpc, '--max-cpc');
    if (enoughDelivery && m.cpc !== null && m.cpc > max) reasons.push(`Link CPC ${m.cpc.toFixed(2)} > ${max}`);
  }
  if (opts.maxCpa) {
    const max = parseThreshold(opts.maxCpa, '--max-cpa');
    if (m.results >= minResults && m.cost_per_result !== null && m.cost_per_result > max) {
      reasons.push(`Cost per ${m.result_event} ${m.cost_per_result.toFixed(2)} > ${max} (${m.results} results)`);
    } else if (m.results === 0 && m.spend >= 2 * max && max > 0) {
      reasons.push(`No ${m.result_event} results after spending ${m.spend} (≥ 2× target CPA ${max})`);
    }
  }
  if (opts.minRoas) {
    const min = parseThreshold(opts.minRoas, '--min-roas');
    // ROAS is only judged with enough delivery; no spend means no signal.
    if (enoughDelivery && m.spend > 0) {
      const roas = getRoas(insight) ?? 0;
      if (roas < min) reasons.push(`ROAS ${roas} < ${min}`);
    }
  }
  return reasons;
}

/** Learning status for an entity row from the ad set (or the ad's ad set). */
export function learningStatus(entity: Row): string | undefined {
  const info = (entity.learning_stage_info ?? (entity.adset as Row | undefined)?.learning_stage_info) as Row | undefined;
  return info?.status as string | undefined;
}

// ─── Notifications ────────────────────────────────────────────────────────────

export interface NotifyPayload { title: string; lines: string[]; data: unknown }

/** Parse --notify webhook:<url> | slack:<incoming webhook url>. */
export function parseNotifyTarget(target: string): { kind: 'webhook' | 'slack'; url: string } {
  const m = /^(webhook|slack):(https?:\/\/.+)$/.exec(target);
  if (!m) throw new Error(`--notify must be webhook:<https url> or slack:<incoming webhook url>, got: "${target}"`);
  return { kind: m[1] as 'webhook' | 'slack', url: m[2] };
}

/** Send a notification; failures are reported on stderr, never fatal. */
export async function sendNotification(target: string, payload: NotifyPayload): Promise<boolean> {
  const { kind, url } = parseNotifyTarget(target);
  const body = kind === 'slack'
    ? { text: [`*${payload.title}*`, ...payload.lines].join('\n') }
    : payload;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Notification to ${kind} failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Notification to ${kind} failed: ${(err as Error).message}`);
    return false;
  }
}

function validateDatePreset(preset: string): string {
  if (!META_DATE_PRESETS.includes(preset)) {
    throw new Error(`Unknown --date-preset "${preset}". Use one of: ${META_DATE_PRESETS.join(', ')}`);
  }
  return preset;
}

// ─── Evaluation shared by auto-pause and watch ────────────────────────────────

interface EvaluateOpts extends PauseThresholds {
  accountId: string; level: string; datePreset: string; includeLearning?: boolean;
}

export interface Evaluation {
  entities_checked: number;
  to_pause: Array<{ id: string; name: string; reason: string }>;
  skipped_learning: string[];
}

const LEVELS: Record<string, { edge: string; idField: string; listFields: string }> = {
  campaign: { edge: 'campaigns', idField: 'campaign_id', listFields: 'id,name,status' },
  adset: { edge: 'adsets', idField: 'adset_id', listFields: 'id,name,status,learning_stage_info' },
  ad: { edge: 'ads', idField: 'ad_id', listFields: 'id,name,status,adset{learning_stage_info}' },
};

/** List active entities, fetch their insights in one account-level query, and apply the thresholds. */
export async function evaluateEntities(client: MetaClient, opts: EvaluateOpts): Promise<Evaluation> {
  const level = LEVELS[opts.level];
  if (!level) throw new Error(`--level must be campaign, adset or ad, got: "${opts.level}"`);

  const listResponse = await client.requestAllPages(`${opts.accountId}/${level.edge}`, {
    params: { fields: level.listFields, effective_status: JSON.stringify(['ACTIVE']), limit: '200' },
  });
  const entities = ((listResponse.data as Row).data as Row[]) || [];

  // One account-level insights query instead of a call per entity.
  const insightsResponse = await client.requestAllPages(`${opts.accountId}/insights`, {
    params: {
      level: opts.level,
      fields: `${level.idField},${PERFORMANCE_FIELDS},purchase_roas,objective,optimization_goal`,
      date_preset: opts.datePreset,
      limit: '500',
    },
  });
  const byId = new Map<string, Row>();
  for (const row of ((insightsResponse.data as Row).data as Row[]) || []) byId.set(String(row[level.idField]), row);

  const toPause: Evaluation['to_pause'] = [];
  const skipped: string[] = [];
  for (const entity of entities) {
    const id = String(entity.id);
    if (!opts.includeLearning && learningStatus(entity) === 'LEARNING') {
      skipped.push(id);
      continue;
    }
    const reasons = pauseReasons(byId.get(id) || {}, opts);
    if (reasons.length > 0) toPause.push({ id, name: String(entity.name), reason: reasons.join('; ') });
  }
  return { entities_checked: entities.length, to_pause: toPause, skipped_learning: skipped };
}

async function pauseAll(client: MetaClient, items: Evaluation['to_pause']) {
  const paused: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const item of items) {
    try {
      await client.request(item.id, { method: 'POST', body: { status: 'PAUSED' } });
      paused.push(item.id);
    } catch (err) {
      failed.push({ id: item.id, error: (err as Error).message });
    }
  }
  return { paused, failed };
}

/** Parse --interval like 90s, 15m, 1h (minimum 60s, to respect rate limits). */
export function parseInterval(value: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(value);
  if (!m) throw new Error(`--interval must look like 90s, 15m or 1h, got: "${value}"`);
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  if (ms < 60_000) throw new Error('--interval must be at least 60s');
  return ms;
}

/** Alerts not present in the previous tick, so a watch doesn't repeat the same notification. */
export function newAlerts(prev: Set<string>, current: Evaluation['to_pause']): Evaluation['to_pause'] {
  return current.filter(a => !prev.has(`${a.id}|${a.reason}`));
}

function addThresholdOptions(cmd: Command): Command {
  return cmd
    .option('--max-cpa <value>', 'Flag if cost per result exceeds this (account currency units, e.g. dollars — not cents). With no results, flags after spending 2× this')
    .option('--min-roas <value>', 'Flag if purchase ROAS (revenue / spend) drops below this')
    .option('--max-cpc <value>', 'Flag if link CPC exceeds this (account currency units, not cents)')
    .option('--max-spend <value>', 'Flag if spend in the window exceeds this (account currency units, not cents)')
    .option('--result-event <event>', 'Event that counts as a result (default: from each row\'s objective/optimization goal)')
    .option('--min-spend <value>', 'Only judge cost/ROAS once spend reaches this (currency units)')
    .option('--min-impressions <n>', 'Only judge cost/ROAS once impressions reach this', DEFAULT_FLOORS.minImpressions)
    .option('--min-results <n>', 'Only judge CPA once results reach this', DEFAULT_FLOORS.minResults)
    .option('--include-learning', 'Also act on ad sets still in the learning phase (skipped by default)');
}

export function registerMonitoringCommands(program: Command, getClient: () => MetaClient): void {
  const monitoring = program.command('monitor').description('Performance monitoring, alerts and guarded auto-pause');

  monitoring
    .command('check <entityId>')
    .description('Check a campaign/ad set/ad against alert thresholds')
    .option('--max-cpa <value>', 'Alert if cost per result exceeds this (account currency units, not cents)')
    .option('--min-roas <value>', 'Alert if purchase ROAS drops below this')
    .option('--max-cpc <value>', 'Alert if link CPC exceeds this (account currency units, e.g. dollars — not cents)')
    .option('--min-ctr <value>', 'Alert if link CTR (percent) drops below this value')
    .option('--max-frequency <value>', 'Alert if frequency exceeds this value')
    .option('--max-spend <value>', 'Alert if spend in the --date-preset window exceeds this value (account currency units, not cents)')
    .option('--min-conversions <value>', 'Alert if results (counted once, by objective or --result-event) drop below this value')
    .option('--result-event <event>', 'Event that counts as a result (default: from the objective/optimization goal)')
    .option('--date-preset <preset>', 'Insights window (Meta date_preset, resolved in the account timezone). Recent days are incomplete: conversions report late', 'last_7d')
    .option('--notify <target>', 'Send alerts to webhook:<url> or slack:<incoming webhook url>')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      validateDatePreset(opts.datePreset);
      if (opts.notify) parseNotifyTarget(opts.notify);
      const client = getClient();
      const params: Record<string, string> = {
        fields: `${PERFORMANCE_FIELDS},purchase_roas,inline_link_click_ctr,objective,optimization_goal`,
        date_preset: opts.datePreset,
      };

      const response = await client.request(`${entityId}/insights`, { params });
      const data = ((response.data as Row).data as unknown[])?.[0] as Row || {};
      const m = deriveMetrics(data, eventFor(data, opts.resultEvent));

      const alerts: Array<{ type: string; severity: string; message: string; current: number; threshold: number }> = [];
      const check = (flag: string | undefined, name: string, value: number | null, above: boolean, type: string, severity: string, label: string) => {
        if (!flag || value === null) return;
        const threshold = parseThreshold(flag, name);
        if (above ? value > threshold : value < threshold) {
          alerts.push({ type, severity, message: `${label} ${Number(value.toFixed(4))} ${above ? 'exceeds' : 'below'} threshold ${threshold}`, current: value, threshold });
        }
      };
      check(opts.maxCpa, '--max-cpa', m.results > 0 ? m.cost_per_result : null, true, 'HIGH_CPA', 'warning', `Cost per ${m.result_event}`);
      check(opts.minRoas, '--min-roas', m.spend > 0 ? (getRoas(data) ?? 0) : null, false, 'LOW_ROAS', 'warning', 'ROAS');
      check(opts.maxCpc, '--max-cpc', m.cpc, true, 'HIGH_CPC', 'warning', 'Link CPC');
      check(opts.minCtr, '--min-ctr', data.inline_link_click_ctr !== undefined ? Number(data.inline_link_click_ctr) : m.ctr, false, 'LOW_CTR', 'warning', 'Link CTR');
      check(opts.maxFrequency, '--max-frequency', Number(data.frequency ?? m.frequency ?? 0), true, 'HIGH_FREQUENCY', 'warning', 'Frequency');
      check(opts.maxSpend, '--max-spend', m.spend, true, 'BUDGET_DEPLETION', 'critical', 'Spend');
      check(opts.minConversions, '--min-conversions', m.results, false, 'LOW_CONVERSIONS', 'warning', `Results (${m.result_event})`);

      const result = {
        entity_id: entityId,
        date_preset: opts.datePreset,
        derived: m,
        current_metrics: data,
        alerts_triggered: alerts.length,
        alerts,
        status: alerts.length === 0 ? 'OK' : alerts.some(a => a.severity === 'critical') ? 'CRITICAL' : 'WARNING',
      };
      if (opts.notify && alerts.length > 0) {
        await sendNotification(opts.notify, {
          title: `meta-ads monitor: ${result.status} for ${entityId}`,
          lines: alerts.map(a => `• ${a.message}`),
          data: result,
        });
      }
      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  addThresholdOptions(monitoring
    .command('auto-pause')
    .description('Pause entities that breach thresholds, judged on a multi-day window with volume floors (dry-run unless --confirm)'))
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--date-preset <preset>', 'Insights window (Meta date_preset). Intraday data is noise and conversions report late, so avoid today', 'last_7d')
    .option('--level <level>', 'Level: campaign, adset, ad', 'adset')
    .option('--confirm', 'Actually pause (without this flag, dry-run only)')
    .option('--notify <target>', 'Report pauses to webhook:<url> or slack:<incoming webhook url>')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      if (!opts.maxCpc && !opts.maxSpend && !opts.minRoas && !opts.maxCpa) {
        throw new Error('Provide at least one threshold: --max-cpa, --min-roas, --max-cpc or --max-spend');
      }
      validateDatePreset(opts.datePreset);
      if (opts.notify) parseNotifyTarget(opts.notify);
      // Validate thresholds up front, before any API calls.
      pauseReasons({}, opts);
      const client = getClient();

      const evaluation = await evaluateEntities(client, opts);
      const { paused, failed } = opts.confirm ? await pauseAll(client, evaluation.to_pause) : { paused: [], failed: [] };

      const result = {
        entities_checked: evaluation.entities_checked,
        entities_to_pause: evaluation.to_pause.length,
        skipped_learning: evaluation.skipped_learning,
        date_preset: opts.datePreset,
        confirm: Boolean(opts.confirm),
        paused,
        failed,
        details: evaluation.to_pause,
        note: opts.confirm
          ? `Paused ${paused.length} of ${evaluation.to_pause.length} entities${failed.length ? `; ${failed.length} failed` : ''}`
          : 'Dry-run mode. Use --confirm to actually pause.',
      };
      if (opts.notify && evaluation.to_pause.length > 0) {
        await sendNotification(opts.notify, {
          title: `meta-ads auto-pause: ${opts.confirm ? `paused ${paused.length}` : `${evaluation.to_pause.length} would be paused`}`,
          lines: evaluation.to_pause.map(p => `• ${p.name} (${p.id}): ${p.reason}`),
          data: result,
        });
      }
      console.log(formatOutput(result, opts.output as OutputFormat));
      if (failed.length > 0) process.exitCode = 1;
    }));

  addThresholdOptions(monitoring
    .command('watch')
    .description('Re-check thresholds on an interval; prints one JSON line per run and notifies on new alerts'))
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--interval <duration>', 'How often to check, e.g. 15m or 1h (minimum 60s)')
    .option('--date-preset <preset>', 'Insights window (Meta date_preset)', 'last_3d')
    .option('--level <level>', 'Level: campaign, adset, ad', 'adset')
    .option('--auto-pause', 'Pause entities that breach thresholds (needs --confirm)')
    .option('--confirm', 'Confirm pausing with --auto-pause')
    .option('--notify <target>', 'Send new alerts to webhook:<url> or slack:<incoming webhook url>')
    .option('--max-runs <n>', 'Stop after this many runs (default: run until interrupted)')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      if (!opts.maxCpc && !opts.maxSpend && !opts.minRoas && !opts.maxCpa) {
        throw new Error('Provide at least one threshold: --max-cpa, --min-roas, --max-cpc or --max-spend');
      }
      const intervalMs = parseInterval(opts.interval);
      validateDatePreset(opts.datePreset);
      if (opts.notify) parseNotifyTarget(opts.notify);
      if (opts.autoPause && !opts.confirm) throw new Error('--auto-pause needs --confirm');
      pauseReasons({}, opts);
      const maxRuns = opts.maxRuns ? parseThreshold(opts.maxRuns, '--max-runs') : Infinity;
      const client = getClient();

      let seen = new Set<string>();
      for (let run = 1; run <= maxRuns; run++) {
        try {
          const evaluation = await evaluateEntities(client, opts);
          const fresh = newAlerts(seen, evaluation.to_pause);
          seen = new Set(evaluation.to_pause.map(a => `${a.id}|${a.reason}`));
          const { paused, failed } = opts.autoPause ? await pauseAll(client, fresh) : { paused: [], failed: [] };
          const tick = { time: new Date().toISOString(), run, ...evaluation, new_alerts: fresh, paused, failed };
          console.log(JSON.stringify(tick));
          if (opts.notify && fresh.length > 0) {
            await sendNotification(opts.notify, {
              title: `meta-ads watch: ${fresh.length} new alert(s)${opts.autoPause ? `, paused ${paused.length}` : ''}`,
              lines: fresh.map(p => `• ${p.name} (${p.id}): ${p.reason}`),
              data: tick,
            });
          }
        } catch (err) {
          // Keep watching through transient API errors.
          console.log(JSON.stringify({ time: new Date().toISOString(), run, error: (err as Error).message }));
        }
        if (run < maxRuns) await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }));

  monitoring
    .command('dashboard')
    .description('Quick campaign dashboard with results, cost per result and ROAS (shortcut for insights account --level campaign --with-derived)')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--time-range <range>', TIME_RANGE_HELP, 'last_7d')
    .option('--since <date>', 'Start date (YYYY-MM-DD); use with --until')
    .option('--until <date>', 'End date (YYYY-MM-DD); use with --since')
    .option('-o, --output <format>', 'Output format', 'table')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const data = await runInsights(client, opts.accountId, {
        level: 'campaign',
        fields: 'campaign_name,campaign_id,impressions,reach,frequency,spend,cpm,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,actions,action_values',
        timeRange: opts.timeRange,
        since: opts.since,
        until: opts.until,
        limit: '100',
        sort: 'spend_descending',
        withDerived: true,
      });
      // Drop the raw action arrays from the dashboard; derived columns carry the result.
      const rows = (((data as Row).data as Row[]) || []).map(({ actions: _a, action_values: _v, ...rest }) => rest);
      console.log(formatOutput(rows.length ? rows : data, opts.output as OutputFormat));
    }));
}
