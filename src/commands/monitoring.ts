import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerMonitoringCommands(program: Command, getClient: () => MetaClient): void {
  const monitoring = program.command('monitor').description('Real-time performance monitoring and automated alerts');

  monitoring
    .command('check <entityId>')
    .description('Check performance against alert thresholds for a campaign/adset')
    .option('--max-cpc <value>', 'Alert if CPC exceeds this value')
    .option('--min-ctr <value>', 'Alert if CTR drops below this value')
    .option('--max-frequency <value>', 'Alert if frequency exceeds this value')
    .option('--max-spend <value>', 'Alert if daily spend exceeds this value')
    .option('--min-conversions <value>', 'Alert if conversions drop below this value')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entityId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,reach,frequency,actions,conversions',
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

      console.log(formatOutput({
        entity_id: entityId,
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
    .option('--max-cpc <value>', 'Pause if CPC exceeds this value')
    .option('--max-spend <value>', 'Pause if spend exceeds this value')
    .option('--min-roas <value>', 'Pause if ROAS drops below this value')
    .option('--level <level>', 'Level: campaign, adset, ad', 'adset')
    .option('--confirm', 'Actually pause (without this flag, dry-run only)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
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

      const listResponse = await client.request(entityEndpoint, { params: listParams });
      const entities = (listResponse.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      const toPause: Array<{ id: string; name: string; reason: string }> = [];

      for (const entity of entities) {
        const insightResponse = await client.request(`${entity.id}/insights`, {
          params: { fields: 'spend,cpc,actions,cost_per_action_type' },
        });
        const insight = ((insightResponse.data as Record<string, unknown>).data as unknown[])?.[0] as Record<string, unknown> || {};

        const reasons: string[] = [];
        if (opts.maxCpc && parseFloat(String(insight.cpc || 0)) > parseFloat(opts.maxCpc)) {
          reasons.push(`CPC ${insight.cpc} > ${opts.maxCpc}`);
        }
        if (opts.maxSpend && parseFloat(String(insight.spend || 0)) > parseFloat(opts.maxSpend)) {
          reasons.push(`Spend ${insight.spend} > ${opts.maxSpend}`);
        }

        if (reasons.length > 0) {
          toPause.push({ id: String(entity.id), name: String(entity.name), reason: reasons.join('; ') });
        }
      }

      if (opts.confirm && toPause.length > 0) {
        for (const item of toPause) {
          await client.request(item.id, { method: 'POST', body: { status: 'PAUSED' } });
        }
      }

      console.log(formatOutput({
        entities_checked: entities.length,
        entities_to_pause: toPause.length,
        paused: opts.confirm,
        details: toPause,
        note: opts.confirm ? 'Entities have been paused' : 'Dry-run mode. Use --confirm to actually pause.',
      }, opts.output as OutputFormat));
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
