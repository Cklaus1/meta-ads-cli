import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

// Targeting spec keys whose entries are {id, name} objects checked by targetingvalidation.
const VALIDATABLE_KEYS = ['interests', 'behaviors', 'life_events', 'industries', 'income', 'family_statuses', 'work_employers', 'work_positions', 'education_schools', 'education_majors'];

/** Collect {type, id} pairs for every interest/behavior/etc. in a targeting spec, including flexible_spec and exclusions. */
export function targetingEntries(spec: Record<string, unknown>): Array<{ type: string; id: string }> {
  const out: Array<{ type: string; id: string }> = [];
  const scan = (obj: Record<string, unknown>) => {
    for (const key of VALIDATABLE_KEYS) {
      const list = obj[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : item;
        if (id !== undefined && id !== null) out.push({ type: key, id: String(id) });
      }
    }
  };
  scan(spec);
  for (const group of Array.isArray(spec.flexible_spec) ? spec.flexible_spec : []) scan(group as Record<string, unknown>);
  if (spec.exclusions && typeof spec.exclusions === 'object') scan(spec.exclusions as Record<string, unknown>);
  return out;
}

/** Split --ids into typed (type:id) targeting_list entries and bare IDs. */
export function parseIdList(value: unknown): { typed: Array<{ type: string; id: string }>; untyped: string[] } {
  const typed: Array<{ type: string; id: string }> = [];
  const untyped: string[] = [];
  for (const raw of String(value ?? '').split(',').map(v => v.trim()).filter(Boolean)) {
    const m = /^([a-z_]+):(\d+)$/.exec(raw);
    if (m) {
      if (!VALIDATABLE_KEYS.includes(m[1])) throw new Error(`Unknown targeting type "${m[1]}". Use one of: ${VALIDATABLE_KEYS.join(', ')}`);
      typed.push({ type: m[1], id: m[2] });
    } else {
      untyped.push(raw);
    }
  }
  return { typed, untyped };
}

/**
 * Replace each unresolved bare ID's "invalid" node with what the typed retry
 * found. One ID can be valid as several types (e.g. a field of study and an
 * employer), so list every match rather than guessing.
 */
export function mergeRetried(
  nodes: Array<Record<string, unknown>>, retry: Array<Record<string, unknown>>, unresolved: string[],
): Array<Record<string, unknown>> {
  return nodes.map(node => {
    const id = String(node.id);
    if (!unresolved.includes(id) || node.valid !== false) return node;
    const matches = retry.filter(r => String(r.id) === id && r.valid === true);
    if (matches.length === 0) return node;
    if (matches.length === 1) return matches[0];
    return {
      id,
      name: matches[0].name,
      valid: true,
      matched_types: matches.map(m => ({ type: m.type, path: m.path, audience_size_lower_bound: m.audience_size_lower_bound })),
      note: 'This ID is valid as several targeting types; pass type:id (e.g. education_majors:ID) to check the one you use.',
    };
  });
}

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerTargetingCommands(program: Command, getClient: () => MetaClient): void {
  const targeting = program.command('targeting').description('Audience targeting and research');

  targeting
    .command('search-interests <query>')
    .description('Search interest targeting options')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adinterest',
        q: query,
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('suggest-interests')
    .description('Get interest suggestions based on existing interests')
    .requiredOption('--interests <ids>', 'Comma-separated interest IDs')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adinterestsuggestion',
        interest_list: JSON.stringify(opts.interests.split(',')),
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-behaviors')
    .description('Get available behavior targeting options')
    .option('--limit <n>', 'Maximum results', '50')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adTargetingCategory',
        class: 'behaviors',
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-demographics')
    .description('Get demographic targeting options')
    .option('--class <class>', 'Demographic class (demographics, life_events, industries, income, family_statuses)', 'demographics')
    .option('--limit <n>', 'Maximum results', '50')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adTargetingCategory',
        class: opts.class,
        limit: opts.limit,
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('search-geo <query>')
    .description('Search geographic locations')
    .option('--type <type>', 'Location type: country, region, city, zip, geo_market, electoral_district')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'adgeolocation',
        q: query,
        limit: opts.limit,
      };
      if (opts.type) {
        params.location_types = JSON.stringify([opts.type]);
      }

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('estimate-audience')
    .description('Estimate audience size for a targeting spec')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--targeting <json>', 'Targeting spec as JSON (inline, @file or -)')
    .option('--optimization-goal <goal>', 'Optimization goal', 'REACH')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        targeting_spec: JSON.stringify(parseJsonInput(opts.targeting, '--targeting')),
        optimization_goal: opts.optimizationGoal,
      };

      const response = await client.request(`${opts.accountId}/delivery_estimate`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  targeting
    .command('validate')
    .description('Check a targeting spec before launch: invalid or retired interests/behaviors, and whether Meta can estimate delivery')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--targeting <json>', 'Targeting spec to check (inline, @file or -)')
    .option('--ids <ids>', 'Comma-separated targeting IDs to check, optionally typed as type:id (e.g. education_majors:104076956295773); untyped IDs are matched against every targeting type')
    .option('--names <names>', 'Comma-separated interest names to check')
    .option('--optimization-goal <goal>', 'Optimization goal for the delivery estimate', 'REACH')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      if (!opts.targeting && !opts.ids && !opts.names) {
        throw new Error('Pass --targeting, --ids or --names');
      }
      const client = getClient();
      const result: Record<string, unknown> = {};
      const problems: string[] = [];

      const spec = opts.targeting ? parseJsonInput<Record<string, unknown>>(opts.targeting, '--targeting') : undefined;
      const params: Record<string, string> = {};
      const entries = spec ? targetingEntries(spec) : [];
      const { typed, untyped } = parseIdList(opts.ids);
      if (entries.length || typed.length) params.targeting_list = JSON.stringify([...entries, ...typed]);
      if (untyped.length) params.id_list = JSON.stringify(untyped);
      if (opts.names) params.name_list = JSON.stringify(String(opts.names).split(',').map((v: string) => v.trim()).filter(Boolean));

      if (Object.keys(params).length) {
        const validate = async (p: Record<string, string>) => ((await client.request(`${opts.accountId}/targetingvalidation`, { params: p }))
          .data as { data?: Array<Record<string, unknown>> }).data || [];
        let nodes = await validate(params);
        // An untyped id_list only covers interests and behaviors, so other kinds
        // (education majors, employers, ...) come back invalid. Retry those IDs
        // once as every type and keep whichever type Meta recognises.
        const unresolved = untyped.filter(id => nodes.some(n => String(n.id) === id && n.valid === false));
        if (unresolved.length) {
          const retry = await validate({
            targeting_list: JSON.stringify(unresolved.flatMap(id => VALIDATABLE_KEYS.map(type => ({ type, id })))),
          });
          nodes = mergeRetried(nodes, retry, unresolved);
        }
        result.entries = nodes;
        for (const node of nodes) {
          if (node.valid === false) problems.push(`${node.type || 'targeting'} ${node.name || node.id} is not valid`);
        }
      }

      if (spec) {
        if (!spec.geo_locations) problems.push('targeting has no geo_locations; Meta requires a location');
        try {
          const estimate = await client.request(`${opts.accountId}/delivery_estimate`, {
            params: { targeting_spec: JSON.stringify(spec), optimization_goal: opts.optimizationGoal },
          });
          result.delivery_estimate = (estimate.data as { data?: unknown[] }).data?.[0] ?? estimate.data;
        } catch (err) {
          problems.push(`Meta rejected the spec: ${(err as Error).message}`);
        }
      }

      result.valid = problems.length === 0;
      result.problems = problems;
      console.log(formatOutput(result, opts.output as OutputFormat));
      if (problems.length) process.exitCode = 1;
    }));
}
