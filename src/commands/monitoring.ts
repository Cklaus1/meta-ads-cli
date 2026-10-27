import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const CONVERSION_ACTION_TYPES = new Set([
  'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'lead', 'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
]);

type ActionList = Array<{ action_type?: string; value?: string | number }> | undefined;

function sumActions(list: ActionList, filter?: (type: string) => boolean): number {
  if (!Array.isArray(list)) return 0;
  return list
    .filter(a => !filter || filter(String(a.action_type || '')))
    .reduce((sum, a) => sum + (parseFloat(String(a.value ?? 0)) || 0), 0);
}

/** Purchase ROAS from an insights row (Meta returns it as an action list). */
export function getRoas(insight: Record<string, unknown>): number | undefined {
  const list = insight.purchase_roas as ActionList;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const omni = list.find(a => a.action_type === 'omni_purchase');
  return parseFloat(String((omni ?? list[0]).value ?? 0)) || 0;
}

/** Conversion count: the `conversions` field when present, else conversion-type actions. */
export function getConversions(insight: Record<string, unknown>): number {
  if (Array.isArray(insight.conversions)) return sumActions(insight.conversions as ActionList);
  return sumActions(insight.actions as ActionList, t => CONVERSION_ACTION_TYPES.has(t));
}

function parseThreshold(value: string, name: string): number {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got: "${value}"`);
  return n;
}

export interface PauseThresholds { maxCpc?: string; maxSpend?: string; minRoas?: string }

/** Reasons an entity's insights breach the auto-pause thresholds (empty = keep running). */
export function pauseReasons(insight: Record<string, unknown>, opts: PauseThresholds): string[] {
  const reasons: string[] = [];
  const spend = parseFloat(String(insight.spend || 0));
  if (opts.maxCpc) {
    const max = parseThreshold(opts.maxCpc, '--max-cpc');
    const cpc = parseFloat(String(insight.cpc || 0));
    if (cpc > max) reasons.push(`CPC ${cpc} > ${max}`);
  }
  if (opts.maxSpend) {
    const max = parseThreshold(opts.maxSpend, '--max-spend');
    if (spend > max) reasons.push(`Spend ${spend} > ${max}`);
  }
  if (opts.minRoas) {
    const min = parseThreshold(opts.minRoas, '--min-roas');
    // Only judge ROAS once something has been spent; no spend means no signal.
    if (spend > 0) {
      const roas = getRoas(insight) ?? 0;
      if (roas < min) reasons.push(`ROAS ${roas} < ${min}`);
    }
  }
  return reasons;
}

export function registerMonitoringCommands(program: Command, getClient: () => MetaClient): void {
  const monitoring = program.command('monitor').description('Real-time performance monitoring and automated alerts');

  monitoring
    .command('check <entityId>')
    .description('Check performance against alert thresholds for a campaign/adset')
    .option('--max-cpc <value>', 'Alert if CPC exceeds this value (account currency units, e.g. dollars — not cents)')
    .option('--min-ctr <value>', 'Alert if CTR (percent) drops below this value')
    .option('--max-frequency <value>', 'Alert if frequency exceeds this value')
    .option('--max-spend <value>', 'Alert if spend in the --date-preset window exceeds this value (account currency units, not cents)')
    .option('--min-conversions <value>', 'Alert if conversions in the window drop below this value')
    .option('--date-preset <preset>', 'Insights window (Meta date_preset, e.g. today, yesterday, last_7d)', 'today')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions',
        date_preset: opts.datePreset,
      };

      const response = await client.request(`${entityId}/insights`, { params });
      const data = ((response.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

      const alerts: Array<{ type: string; severity: string; message: string; current: number; threshold: number }> = [];

      if (opts.maxCpc) {
        const cpc = parseFloat(String(data.cpc || 0));
        if (cpc > parseFloat(opts.maxCpc)) {
          alerts.push({ type: 'HIGH_CPC', severity: 'warning', message: `CPC ${cpc} exceeds threshold ${opts.maxCpc}`, current: cpc, threshold: parseFloat(opts.maxCpc) });
        }
      }
      if (opts.minCtr) {
        const ctr = parseFloat(String(data.ctr || 0));
        if (ctr < parseFloat(opts.minCtr)) {
          alerts.push({ type: 'LOW_CTR', severity: 'warning', message: `CTR ${ctr} below threshold ${opts.minCtr}`, current: ctr, threshold: parseFloat(opts.minCtr) });
        }
      }
      if (opts.maxFrequency) {
        const freq = parseFloat(String(data.frequency || 0));
        if (freq > parseFloat(opts.maxFrequency)) {
          alerts.push({ type: 'HIGH_FREQUENCY', severity: 'warning', message: `Frequency ${freq} exceeds threshold ${opts.maxFrequency}`, current: freq, threshold: parseFloat(opts.maxFrequency) });
        }
      }
      if (opts.maxSpend) {
        const spend = parseFloat(String(data.spend || 0));
        if (spend > parseFloat(opts.maxSpend)) {
          alerts.push({ type: 'BUDGET_DEPLETION', severity: 'critical', message: `Spend ${spend} exceeds threshold ${opts.maxSpend}`, current: spend, threshold: parseFloat(opts.maxSpend) });
        }
      }
      if (opts.minConversions) {
        const min = parseThreshold(opts.minConversions, '--min-conversions');
        const conversions = getConversions(data);
        if (conversions < min) {
          alerts.push({ type: 'LOW_CONVERSIONS', severity: 'warning', message: `Conversions ${conversions} below threshold ${min}`, current: conversions, threshold: min });
        }
      }

      console.log(formatOutput({
        entity_id: entityId,
        date_preset: opts.datePreset,
        current_metrics: data,
        alerts_triggered: alerts.length,
        alerts,
        status: alerts.length === 0 ? 'OK' : alerts.some(a => a.severity === 'critical') ? 'CRITICAL' : 'WARNING',
      }, opts.output as OutputFormat));
    }));

  monitoring
    .command('auto-pause')
    .description('Auto-pause entities that exceed thresholds')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--max-cpc <value>', 'Pause if CPC exceeds this value (account currency units, e.g. dollars — not cents)')
    .option('--max-spend <value>', 'Pause if spend in the --date-preset window exceeds this value (account currency units, not cents)')
    .option('--min-roas <value>', 'Pause if purchase ROAS drops below this value (only entities with spend > 0)')
    .option('--date-preset <preset>', 'Insights window (Meta date_preset, e.g. today, yesterday, last_7d)', 'today')
    .option('--level <level>', 'Level: campaign, adset, ad', 'adset')
    .option('--confirm', 'Actually pause (without this flag, dry-run only)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      if (!opts.maxCpc && !opts.maxSpend && !opts.minRoas) {
        throw new Error('Provide at least one threshold: --max-cpc, --max-spend or --min-roas');
      }
      // Validate thresholds up front, before any API calls.
      pauseReasons({}, opts);
      const client = getClient();

      const listParams: Record<string, string> = {
        fields: 'id,name,status',
        effective_status: JSON.stringify(['ACTIVE']),
        limit: '100',
      };

      const entityEndpoint = opts.level === 'campaign'
        ? `${opts.accountId}/campaigns`
        : opts.level === 'ad'
          ? `${opts.accountId}/ads`
          : `${opts.accountId}/adsets`;

      const listResponse = await client.requestAllPages(entityEndpoint, { params: listParams });
      const entities = (listResponse.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      const toPause: Array<{ id: string; name: string; reason: string }> = [];

      for (const entity of entities) {
        const insightResponse = await client.request(`${entity.id}/insights`, {
          params: { fields: 'spend,cpc,actions,cost_per_action_type,purchase_roas', date_preset: opts.datePreset },
        });
        const insight = ((insightResponse.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

        const reasons = pauseReasons(insight, opts);

        if (reasons.length > 0) {
          toPause.push({ id: String(entity.id), name: String(entity.name), reason: reasons.join('; ') });
        }
      }

      // Pause each entity independently, so one failure doesn't stop the rest.
      const paused: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];
      if (opts.confirm) {
        for (const item of toPause) {
          try {
            await client.request(item.id, { method: 'POST', body: { status: 'PAUSED' } });
            paused.push(item.id);
          } catch (err) {
            failed.push({ id: item.id, error: (err as Error).message });
          }
        }
      }

      console.log(formatOutput({
        entities_checked: entities.length,
        entities_to_pause: toPause.length,
        date_preset: opts.datePreset,
        confirm: Boolean(opts.confirm),
        paused,
        failed,
        details: toPause,
        note: opts.confirm
          ? `Paused ${paused.length} of ${toPause.length} entities${failed.length ? `; ${failed.length} failed` : ''}`
          : 'Dry-run mode. Use --confirm to actually pause.',
      }, opts.output as OutputFormat));
      if (failed.length > 0) process.exitCode = 1;
    }));

  monitoring
    .command('dashboard')
    .description('Quick performance dashboard for an account')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'table')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      // Get active campaigns with insights
      const params: Record<string, string> = {
        fields: 'campaign_name,campaign_id,impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions',
        level: 'campaign',
        limit: '25',
      };

      const response = await client.request(`${opts.accountId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
