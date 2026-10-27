import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, PolicyError } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const RULE_FIELDS = 'id,name,status,evaluation_spec,execution_spec,schedule_spec,created_time,updated_time';

// From the ad rules evaluation-spec docs (checked 2026-10-27).
export const TIME_PRESETS = [
  'LIFETIME', 'TODAY', 'YESTERDAY', 'THIS_MONTH', 'THIS_WEEK_MON_TODAY', 'THIS_WEEK_SUN_TODAY',
  'LAST_2_DAYS', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_28_DAYS', 'LAST_30_DAYS',
  'LAST_2D', 'LAST_3D', 'LAST_7D', 'LAST_14D', 'LAST_28D', 'LAST_30D',
];
const ENTITY_TYPES = ['AD', 'ADSET', 'CAMPAIGN'];

interface RuleFilter { field: string; value: unknown; operator: string }

/** Cost metrics; Meta rejects rules that pause on these (error 2703). */
export function isCostField(field: string): boolean {
  return ['cpc', 'cpm', 'cpa', 'cpp'].includes(field) || field.startsWith('cost_per');
}

/**
 * Meta returns error 2703 ("Rules that turn off ads can't have cost
 * conditions") for PAUSE rules filtering on cost metrics. Catch it locally
 * with an explanation and an alternative.
 */
export function assertRuleAllowed(evaluationSpec: { filters?: RuleFilter[] }, executionSpec: { execution_type?: string }): void {
  if (executionSpec.execution_type !== 'PAUSE') return;
  const cost = (evaluationSpec.filters || []).filter(f => isCostField(f.field)).map(f => f.field);
  if (cost.length) {
    throw new Error(
      `Meta doesn't allow rules that turn off ads to use cost conditions (${cost.join(', ')}); it returns error 2703. `
      + 'Use --action NOTIFICATION to be alerted instead, or pause on a non-cost condition such as frequency or CTR.',
    );
  }
}

/** Guardrail state the rule checks need, taken from the client and global flags. */
export interface RuleGuardrails {
  blockGoingLive: boolean;
  allowLive: boolean;
  /** Effective per-write cap in cents (0 = none). */
  spendCapCents: number;
  /** Policy account daily-budget ceiling in cents (0 = none). */
  accountCeilingCents: number;
  allowBudgetRules: boolean;
}

const UNPAUSING_TYPES = ['UNPAUSE', 'REBALANCE_BUDGET'];
const BUDGET_CHANGING_TYPES = ['CHANGE_BUDGET', 'CHANGE_BID', 'REBALANCE_BUDGET'];

/** The change_spec value inside an execution_spec, if any. */
function changeSpec(execution: Record<string, unknown>): Record<string, unknown> | undefined {
  const opts = execution.execution_options;
  if (!Array.isArray(opts)) return undefined;
  const hit = (opts as Array<Record<string, unknown>>).find(o => o.field === 'change_spec');
  const value = hit?.value;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return undefined; }
  }
  return value as Record<string, unknown> | undefined;
}

/**
 * Rules run later on Meta's servers, out of reach of the spend cap and the
 * going-live policy, so check what they will do before creating them.
 */
export function assertRuleWithinGuardrails(execution: Record<string, unknown>, g: RuleGuardrails): void {
  const type = String(execution.execution_type || '').toUpperCase();
  if (g.blockGoingLive && !g.allowLive && UNPAUSING_TYPES.includes(type)) {
    throw new PolicyError(
      `Policy: a ${type} rule can turn ads back on later, which the policy blocks. Pass --allow-live to confirm.`,
    );
  }
  if (!BUDGET_CHANGING_TYPES.includes(type)) return;
  const limits = [g.spendCapCents, g.accountCeilingCents].filter(n => n > 0);
  if (limits.length === 0) return;
  const cap = Math.min(...limits);
  const spec = changeSpec(execution);
  // A pure decrease can't push spend past the cap.
  const amount = Number(spec?.amount);
  if (type !== 'REBALANCE_BUDGET' && Number.isFinite(amount) && amount < 0) return;
  if (!g.allowBudgetRules) {
    throw new PolicyError(
      `Spend-cap guard: a ${type} rule can raise budgets or bids later on Meta's servers, beyond the ${cap}¢ cap. `
      + 'Pass --allow-budget-rules and set an absolute "limit" (in cents) within the cap in change_spec.',
    );
  }
  const limit = Number(spec?.limit);
  if (!spec || spec.limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    throw new PolicyError(`Spend-cap guard: a ${type} rule needs an absolute change_spec "limit" (cents) so it can't exceed the ${cap}¢ cap.`);
  }
  if (limit > cap) {
    throw new PolicyError(`Spend-cap guard: change_spec limit ${limit}¢ exceeds the spend cap of ${cap}¢.`);
  }
}

/** Collect guardrail state for a rules command. `cmd` is the Commander command running. */
export function ruleGuardrails(client: MetaClient, cmd: Command | undefined, allowBudgetRules: boolean): RuleGuardrails {
  const policy = client.getPolicy();
  void cmd;
  return {
    blockGoingLive: Boolean(policy.blockGoingLive),
    // Read from the client, which ignores --allow-live in MCP tool calls the server didn't allow.
    allowLive: client.isLiveAllowed(),
    spendCapCents: client.getMaxSpendCapCents(),
    accountCeilingCents: policy.maxAccountDailyBudgetCents ?? 0,
    allowBudgetRules,
  };
}

function baseFilters(entity: string, timePreset: string, ids: { campaigns?: string[]; adsets?: string[] }): RuleFilter[] {
  const e = entity.toUpperCase();
  if (!ENTITY_TYPES.includes(e)) throw new Error(`--entity must be one of ${ENTITY_TYPES.join(', ')}, got "${entity}"`);
  const t = timePreset.toUpperCase();
  if (!TIME_PRESETS.includes(t)) throw new Error(`--time-preset must be one of ${TIME_PRESETS.join(', ')}, got "${timePreset}"`);
  const filters: RuleFilter[] = [
    { field: 'entity_type', value: e, operator: 'EQUAL' },
    { field: 'time_preset', value: t, operator: 'EQUAL' },
    { field: 'attribution_window', value: 'ACCOUNT_DEFAULT', operator: 'EQUAL' },
    { field: 'effective_status', value: ['ACTIVE'], operator: 'IN' },
  ];
  if (ids.campaigns?.length) filters.push({ field: 'campaign.id', value: ids.campaigns, operator: 'IN' });
  if (ids.adsets?.length) filters.push({ field: 'adset.id', value: ids.adsets, operator: 'IN' });
  return filters;
}

function list(v?: string): string[] | undefined {
  const out = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function positiveNumber(v: unknown, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${v}"`);
  return n;
}

export interface PresetOptions {
  preset: string;
  entity: string;
  timePreset: string;
  action: string;
  campaigns?: string[];
  adsets?: string[];
  maxCpaCents?: number;
  minSpendCents?: number;
  maxFrequency?: number;
  minCtr?: number;
  minImpressions?: number;
}

/**
 * Build evaluation/execution specs for common guardrail rules. Money values
 * are in the account currency's minor units (cents for USD), as Meta expects.
 */
export function buildPresetRule(o: PresetOptions): { evaluation_spec: Record<string, unknown>; execution_spec: Record<string, unknown> } {
  const filters = baseFilters(o.entity, o.timePreset, { campaigns: o.campaigns, adsets: o.adsets });
  if (o.preset === 'high-cpa') {
    if (o.maxCpaCents === undefined) throw new Error('high-cpa needs --max-cpa-cents');
    filters.push({ field: 'cpa', value: o.maxCpaCents, operator: 'GREATER_THAN' });
    // Don't judge until there's been meaningful spend.
    if (o.minSpendCents !== undefined) filters.push({ field: 'spent', value: o.minSpendCents, operator: 'GREATER_THAN' });
  } else if (o.preset === 'high-frequency') {
    if (o.maxFrequency === undefined) throw new Error('high-frequency needs --max-frequency');
    filters.push({ field: 'frequency', value: o.maxFrequency, operator: 'GREATER_THAN' });
    if (o.minImpressions !== undefined) filters.push({ field: 'impressions', value: o.minImpressions, operator: 'GREATER_THAN' });
  } else if (o.preset === 'low-ctr') {
    if (o.minCtr === undefined) throw new Error('low-ctr needs --min-ctr');
    filters.push({ field: 'ctr', value: o.minCtr, operator: 'LESS_THAN' });
    filters.push({ field: 'impressions', value: o.minImpressions ?? 5000, operator: 'GREATER_THAN' });
  } else {
    throw new Error(`Unknown preset "${o.preset}". Use high-cpa, high-frequency or low-ctr`);
  }
  const action = o.action.toUpperCase();
  if (!['PAUSE', 'NOTIFICATION'].includes(action)) throw new Error(`--action must be PAUSE or NOTIFICATION, got "${o.action}"`);
  const evaluation_spec = { evaluation_type: 'SCHEDULE', filters };
  const execution_spec = { execution_type: action };
  assertRuleAllowed(evaluation_spec, execution_spec);
  return { evaluation_spec, execution_spec };
}

export function registerRuleCommands(program: Command, getClient: () => MetaClient): void {
  const rules = program.command('rules')
    .description('Meta automated rules: run server-side on Meta\'s schedule, visible in Ads Manager, no cron or agent needed');

  rules
    .command('list')
    .description('List automated rules in an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const response = await getClient().request(`${opts.accountId}/adrules_library`, { params: { fields: RULE_FIELDS, limit: opts.limit } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rules
    .command('get <ruleId>')
    .description('Get one rule')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (ruleId: string, opts) => {
      const response = await getClient().request(ruleId, { params: { fields: RULE_FIELDS } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rules
    .command('create')
    .description('Create a rule from raw specs. Money values are in minor units (cents for USD)')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Rule name')
    .requiredOption('--evaluation-spec <json>', 'evaluation_spec (JSON, @file or -)')
    .requiredOption('--execution-spec <json>', 'execution_spec (JSON, @file or -)')
    .option('--schedule-spec <json>', 'schedule_spec (JSON, @file or -), e.g. {"schedule_type":"SEMI_HOURLY"}')
    .option('--status <status>', 'ENABLED or DISABLED', 'ENABLED')
    .option('--allow-budget-rules', 'Allow CHANGE_BUDGET/CHANGE_BID rules under a spend cap (needs an absolute change_spec limit within the cap)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts, cmd: Command) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const evaluation = parseJsonInput<Record<string, unknown>>(opts.evaluationSpec, '--evaluation-spec');
      const execution = parseJsonInput<Record<string, unknown>>(opts.executionSpec, '--execution-spec');
      assertRuleAllowed(evaluation as { filters?: RuleFilter[] }, execution as { execution_type?: string });
      assertRuleWithinGuardrails(execution, ruleGuardrails(getClient(), cmd, Boolean(opts.allowBudgetRules)));
      const body: Record<string, string> = {
        name: opts.name,
        status: String(opts.status).toUpperCase(),
        evaluation_spec: JSON.stringify(evaluation),
        execution_spec: JSON.stringify(execution),
      };
      if (opts.scheduleSpec) body.schedule_spec = JSON.stringify(parseJsonInput(opts.scheduleSpec, '--schedule-spec'));
      const response = await getClient().request(`${opts.accountId}/adrules_library`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rules
    .command('preset <preset>')
    .description('Create a common guardrail rule: high-cpa (alert when cost per result is too high), high-frequency (pause or alert on ad fatigue), low-ctr. Rules that pause can\'t use cost conditions (Meta error 2703)')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--name <name>', 'Rule name (default: from the preset)')
    .option('--entity <type>', 'AD, ADSET or CAMPAIGN', 'ADSET')
    .option('--time-preset <preset>', 'Window Meta evaluates, e.g. LAST_7D (excludes today), LAST_3D, LAST_14D', 'LAST_7D')
    .option('--action <action>', 'NOTIFICATION or PAUSE', 'NOTIFICATION')
    .option('--campaign-ids <ids>', 'Only these campaigns (comma-separated)')
    .option('--adset-ids <ids>', 'Only these ad sets (comma-separated)')
    .option('--max-cpa-cents <n>', 'high-cpa: alert when cost per result exceeds this (minor units)')
    .option('--min-spend-cents <n>', 'high-cpa: only judge entities that spent more than this (minor units)')
    .option('--max-frequency <n>', 'high-frequency: act when frequency exceeds this')
    .option('--min-ctr <pct>', 'low-ctr: act when CTR (%) falls below this')
    .option('--min-impressions <n>', 'Only judge entities with more impressions than this')
    .option('--schedule <type>', 'DAILY, HOURLY or SEMI_HOURLY', 'SEMI_HOURLY')
    .option('--status <status>', 'ENABLED or DISABLED', 'ENABLED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (preset: string, opts, cmd: Command) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const specs = buildPresetRule({
        preset,
        entity: opts.entity,
        timePreset: opts.timePreset,
        action: opts.action,
        campaigns: list(opts.campaignIds),
        adsets: list(opts.adsetIds),
        maxCpaCents: opts.maxCpaCents !== undefined ? positiveNumber(opts.maxCpaCents, '--max-cpa-cents') : undefined,
        minSpendCents: opts.minSpendCents !== undefined ? positiveNumber(opts.minSpendCents, '--min-spend-cents') : undefined,
        maxFrequency: opts.maxFrequency !== undefined ? positiveNumber(opts.maxFrequency, '--max-frequency') : undefined,
        minCtr: opts.minCtr !== undefined ? positiveNumber(opts.minCtr, '--min-ctr') : undefined,
        minImpressions: opts.minImpressions !== undefined ? positiveNumber(opts.minImpressions, '--min-impressions') : undefined,
      });
      assertRuleWithinGuardrails(specs.execution_spec, ruleGuardrails(getClient(), cmd, false));
      const schedule = String(opts.schedule).toUpperCase();
      if (!['DAILY', 'HOURLY', 'SEMI_HOURLY'].includes(schedule)) throw new Error(`--schedule must be DAILY, HOURLY or SEMI_HOURLY, got "${opts.schedule}"`);
      const body: Record<string, string> = {
        name: opts.name || `meta-ads ${preset} (${String(opts.action).toUpperCase()})`,
        status: String(opts.status).toUpperCase(),
        evaluation_spec: JSON.stringify(specs.evaluation_spec),
        execution_spec: JSON.stringify(specs.execution_spec),
        schedule_spec: JSON.stringify({ schedule_type: schedule }),
      };
      const response = await getClient().request(`${opts.accountId}/adrules_library`, { method: 'POST', body });
      console.log(formatOutput({ ...(response.data as Record<string, unknown>), ...specs }, opts.output as OutputFormat));
    }));

  rules
    .command('update <ruleId>')
    .description('Update a rule. Meta needs every field on update, so unchanged fields are copied from the current rule')
    .option('--name <name>', 'Rule name')
    .option('--evaluation-spec <json>', 'evaluation_spec (JSON, @file or -)')
    .option('--execution-spec <json>', 'execution_spec (JSON, @file or -)')
    .option('--schedule-spec <json>', 'schedule_spec (JSON, @file or -)')
    .option('--status <status>', 'ENABLED or DISABLED')
    .option('--allow-budget-rules', 'Allow CHANGE_BUDGET/CHANGE_BID rules under a spend cap (needs an absolute change_spec limit within the cap)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (ruleId: string, opts, cmd: Command) => {
      const client = getClient();
      const current = (await client.request(ruleId, { params: { fields: RULE_FIELDS } })).data as Record<string, unknown>;
      const evaluation = opts.evaluationSpec ? parseJsonInput<Record<string, unknown>>(opts.evaluationSpec, '--evaluation-spec') : current.evaluation_spec;
      const execution = opts.executionSpec ? parseJsonInput<Record<string, unknown>>(opts.executionSpec, '--execution-spec') : current.execution_spec;
      if (evaluation && execution) {
        assertRuleAllowed(evaluation as { filters?: RuleFilter[] }, execution as { execution_type?: string });
      }
      // Enabling (or keeping enabled) a rule lets it act, so check what it will do.
      const finalStatus = String(opts.status ?? current.status ?? '').toUpperCase();
      if (execution && finalStatus !== 'DISABLED') {
        assertRuleWithinGuardrails(execution as Record<string, unknown>, ruleGuardrails(client, cmd, Boolean(opts.allowBudgetRules)));
      }
      const body: Record<string, string> = {};
      const name = opts.name ?? current.name;
      const status = opts.status ? String(opts.status).toUpperCase() : current.status;
      const schedule = opts.scheduleSpec ? parseJsonInput(opts.scheduleSpec, '--schedule-spec') : current.schedule_spec;
      if (name) body.name = String(name);
      if (status) body.status = String(status);
      if (evaluation) body.evaluation_spec = JSON.stringify(evaluation);
      if (execution) body.execution_spec = JSON.stringify(execution);
      if (schedule) body.schedule_spec = JSON.stringify(schedule);
      const response = await client.request(ruleId, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  for (const [cmd, status] of [['enable', 'ENABLED'], ['disable', 'DISABLED']] as const) {
    rules
      .command(`${cmd} <ruleId>`)
      .description(`Set a rule to ${status}`)
      .option('--allow-budget-rules', 'Allow enabling a CHANGE_BUDGET/CHANGE_BID rule under a spend cap (needs an absolute limit within the cap)')
      .option('-o, --output <format>', 'Output format', 'json')
      .action(handleErrors(async (ruleId: string, opts, cmd: Command) => {
        const client = getClient();
        const current = (await client.request(ruleId, { params: { fields: RULE_FIELDS } })).data as Record<string, unknown>;
        if (status === 'ENABLED' && current.execution_spec && typeof current.execution_spec === 'object') {
          assertRuleWithinGuardrails(current.execution_spec as Record<string, unknown>, ruleGuardrails(client, cmd, Boolean(opts.allowBudgetRules)));
        }
        const body: Record<string, string> = { status };
        if (current.name) body.name = String(current.name);
        for (const key of ['evaluation_spec', 'execution_spec', 'schedule_spec']) {
          if (current[key]) body[key] = JSON.stringify(current[key]);
        }
        const response = await client.request(ruleId, { method: 'POST', body });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }));
  }

  rules
    .command('delete <ruleId>')
    .description('Delete a rule')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (ruleId: string, opts) => {
      const response = await getClient().request(ruleId, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rules
    .command('history <ruleId>')
    .description('Execution history: when the rule ran and what it changed')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (ruleId: string, opts) => {
      const response = await getClient().request(`${ruleId}/history`, { params: { limit: opts.limit } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
