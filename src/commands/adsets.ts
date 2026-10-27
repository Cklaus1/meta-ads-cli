import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { deriveMetrics, resultEventFor, PERFORMANCE_FIELDS, type DerivedMetrics } from '../metrics.js';
import { insightsTimeParams } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/** Placement values Meta has removed, with the reason shown to the user. */
const REMOVED_PLACEMENTS: Record<string, Record<string, string>> = {
  facebook_positions: { video_feeds: 'Facebook video feeds was removed in v24.0' },
  instagram_positions: { explore: 'the Instagram Explore Feed placement was removed in v26.0 (explore_home is still available)' },
  messenger_positions: { story: 'Messenger Stories was removed in v26.0' },
};

/** Throw if a targeting spec uses a placement Meta has removed. */
export function assertNoRemovedPlacements(targeting: Record<string, unknown>): void {
  for (const [key, removed] of Object.entries(REMOVED_PLACEMENTS)) {
    const values = targeting[key];
    if (!Array.isArray(values)) continue;
    for (const v of values) {
      const reason = removed[String(v)];
      if (reason) throw new Error(`Placement ${key}=${v} is no longer supported: ${reason}. Remove it and try again.`);
    }
  }
}

function parseAdvantageAudience(value: unknown): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  if (value === '0' || value === '1') return Number(value) as 0 | 1;
  throw new Error(`--advantage-audience must be 0 or 1, got: "${value}"`);
}

/**
 * Put targeting automation into the targeting spec, where Meta reads it:
 * --targeting-automation JSON first, then --advantage-audience on top.
 */
export function applyTargetingAutomation(
  targeting: Record<string, unknown>,
  automationJson: string | undefined,
  advantageAudience: 0 | 1 | undefined,
): void {
  if (!automationJson && advantageAudience === undefined) return;
  const automation: Record<string, unknown> = {
    ...((targeting.targeting_automation as Record<string, unknown>) || {}),
    ...(automationJson ? parseJsonInput<Record<string, unknown>>(automationJson, '--targeting-automation') : {}),
  };
  if (advantageAudience !== undefined) automation.advantage_audience = advantageAudience;
  targeting.targeting_automation = automation;
}

/** Whether targeting narrows the audience (custom audiences or interests). */
export function hasRelaxableTargeting(targeting: Record<string, unknown>): boolean {
  const nonEmpty = (v: unknown) => Array.isArray(v) ? v.length > 0 : Boolean(v && typeof v === 'object' && Object.keys(v).length);
  return nonEmpty(targeting.custom_audiences) || nonEmpty(targeting.interests) || nonEmpty(targeting.flexible_spec);
}

/**
 * Housing/Employment/Financial (HEC-F) ad sets with narrowed targeting must
 * set targeting_automation.advantage_audience explicitly (v26.0+, and all
 * versions from 2026-10-27). Check before sending so the user gets a clear hint.
 */
export async function assertHecfAdvantageAudience(
  client: MetaClient,
  campaignId: string,
  targeting: Record<string, unknown>,
): Promise<void> {
  const automation = targeting.targeting_automation as Record<string, unknown> | undefined;
  if (automation?.advantage_audience !== undefined || !hasRelaxableTargeting(targeting)) return;
  if (client.isDryRun()) return;
  const campaign = await client.request(campaignId, { params: { fields: 'special_ad_categories' } });
  const categories = ((campaign.data as { special_ad_categories?: string[] }).special_ad_categories || [])
    .filter(c => c && c !== 'NONE');
  if (categories.length) {
    throw new Error(
      `This campaign has special ad categories (${categories.join(', ')}) and the targeting uses custom audiences or interests, `
      + 'so Meta requires an explicit Advantage+ audience setting. Pass --advantage-audience 1 (let Meta expand the audience) '
      + 'or --advantage-audience 0 (keep it as specified).',
    );
  }
}

/** Parse a JSON option (inline, @file or -) and re-serialise it for the request body. */
function jsonOption(value: string, flag: string): string {
  return JSON.stringify(parseJsonInput(value, flag));
}

function csvList(value: string): string[] {
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

// ─── Bidding ────────────────────────────────────────────────────────────────

/** Convert a ROAS goal (e.g. 2.5 = 250%) to Meta's roas_average_floor (scaled 10000x). */
export function roasFloor(value: string): number {
  const roas = Number(value);
  if (!/^\d+(\.\d+)?$/.test(String(value).trim()) || roas < 0.01 || roas > 1000) {
    throw new Error(`--roas-goal must be a ROAS between 0.01 and 1000 (e.g. 2.5 for 250%), got: "${value}"`);
  }
  return Math.round(roas * 10000);
}

/**
 * Apply the bid helper flags. Each one sets the matching bid strategy:
 * --roas-goal → LOWEST_COST_WITH_MIN_ROAS + bid_constraints.roas_average_floor,
 * --cost-cap → COST_CAP + bid_amount, --bid-cap → LOWEST_COST_WITH_BID_CAP + bid_amount.
 */
export function applyBidHelpers(
  body: Record<string, string>,
  opts: { roasGoal?: string; costCap?: string; bidCap?: string; bidStrategy?: string; bidAmount?: string; bidConstraints?: string; optimizationGoal?: string },
): void {
  if (opts.bidStrategy === 'TARGET_COST') {
    throw new Error('TARGET_COST was deprecated by Meta. Use --cost-cap <cents> (COST_CAP) for a target cost per result.');
  }
  const helpers = [opts.roasGoal && '--roas-goal', opts.costCap && '--cost-cap', opts.bidCap && '--bid-cap'].filter(Boolean);
  if (helpers.length > 1) throw new Error(`Use only one of ${helpers.join(', ')}`);
  if (helpers.length && opts.bidStrategy) {
    throw new Error(`${helpers[0]} sets the bid strategy itself; don't combine it with --bid-strategy`);
  }
  if (opts.bidConstraints) body.bid_constraints = jsonOption(opts.bidConstraints, '--bid-constraints');

  if (opts.roasGoal) {
    if (opts.bidAmount) throw new Error('--roas-goal can\'t be combined with --bid-amount: the ROAS floor is the bid.');
    if (opts.optimizationGoal && opts.optimizationGoal !== 'VALUE') {
      throw new Error(`A ROAS goal needs --optimization-goal VALUE, got ${opts.optimizationGoal}`);
    }
    body.bid_strategy = 'LOWEST_COST_WITH_MIN_ROAS';
    const existing = body.bid_constraints ? JSON.parse(body.bid_constraints) as Record<string, unknown> : {};
    body.bid_constraints = JSON.stringify({ ...existing, roas_average_floor: roasFloor(opts.roasGoal) });
  } else if (opts.costCap) {
    body.bid_strategy = 'COST_CAP';
    body.bid_amount = opts.costCap;
  } else if (opts.bidCap) {
    body.bid_strategy = 'LOWEST_COST_WITH_BID_CAP';
    body.bid_amount = opts.bidCap;
  }
}

// ─── Frequency caps ─────────────────────────────────────────────────────────

const FREQUENCY_CAP_GOALS = new Set(['REACH', 'THRUPLAY']);

/** Parse --frequency-cap "<impressions>/<days>" into frequency_control_specs. */
export function frequencyCapSpecs(value: string): string {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value).trim());
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1 || Number(m[2]) > 90) {
    throw new Error(`--frequency-cap must look like <impressions>/<days>, e.g. 2/7 (days 1-90), got: "${value}"`);
  }
  return JSON.stringify([{ event: 'IMPRESSIONS', max_frequency: Number(m[1]), interval_days: Number(m[2]) }]);
}

/** Meta only accepts frequency_control_specs on ad sets optimised for REACH or THRUPLAY. */
export function assertFrequencyCapAllowed(goal: string | undefined): void {
  if (goal && !FREQUENCY_CAP_GOALS.has(goal)) {
    throw new Error(
      `Frequency caps can only be set on ad sets optimised for REACH or THRUPLAY (this one is ${goal}). `
      + 'For conversion ad sets, control frequency with audience size, exclusions and budget instead.',
    );
  }
}

// ─── Targeting helpers ──────────────────────────────────────────────────────

const GENDERS: Record<string, number[] | undefined> = { all: undefined, male: [1], female: [2] };

/** Merge the geo/age/gender/audience/brand-safety helper flags into a targeting spec. */
export function applyTargetingHelpers(
  targeting: Record<string, unknown>,
  opts: {
    countries?: string; ageMin?: string; ageMax?: string; genders?: string;
    customAudiences?: string; excludedCustomAudiences?: string;
    publisherBlockLists?: string; excludedPublisherCategories?: string;
    creativeAudiencePairing?: string;
  },
): boolean {
  let changed = false;
  if (opts.countries) {
    const geo = { ...((targeting.geo_locations as Record<string, unknown>) || {}) };
    geo.countries = csvList(opts.countries).map(c => c.toUpperCase());
    targeting.geo_locations = geo;
    changed = true;
  }
  for (const [flag, key] of [['ageMin', 'age_min'], ['ageMax', 'age_max']] as const) {
    const v = opts[flag];
    if (v === undefined) continue;
    const age = Number(v);
    if (!Number.isInteger(age) || age < 13 || age > 65) throw new Error(`--${flag === 'ageMin' ? 'age-min' : 'age-max'} must be an integer from 13 to 65, got: "${v}"`);
    targeting[key] = age;
    changed = true;
  }
  if (opts.genders !== undefined) {
    const g = String(opts.genders).toLowerCase();
    if (!(g in GENDERS)) throw new Error(`--genders must be all, male or female, got: "${opts.genders}"`);
    if (GENDERS[g]) targeting.genders = GENDERS[g];
    else delete targeting.genders;
    changed = true;
  }
  if (opts.customAudiences) {
    targeting.custom_audiences = csvList(opts.customAudiences).map(id => ({ id }));
    changed = true;
  }
  if (opts.excludedCustomAudiences) {
    targeting.excluded_custom_audiences = csvList(opts.excludedCustomAudiences).map(id => ({ id }));
    changed = true;
  }
  if (opts.publisherBlockLists) {
    targeting.excluded_publisher_list_ids = csvList(opts.publisherBlockLists);
    changed = true;
  }
  if (opts.excludedPublisherCategories) {
    targeting.excluded_publisher_categories = csvList(opts.excludedPublisherCategories);
    changed = true;
  }
  if (opts.creativeAudiencePairing !== undefined) {
    if (opts.creativeAudiencePairing !== '0' && opts.creativeAudiencePairing !== '1') {
      throw new Error(`--creative-audience-pairing must be 0 or 1, got: "${opts.creativeAudiencePairing}"`);
    }
    targeting.targeting_automation = {
      ...((targeting.targeting_automation as Record<string, unknown>) || {}),
      creative_audience_pairing: Number(opts.creativeAudiencePairing),
    };
    changed = true;
  }
  if (targeting.age_min !== undefined && targeting.age_max !== undefined && Number(targeting.age_min) > Number(targeting.age_max)) {
    throw new Error('--age-min can\'t be greater than --age-max');
  }
  return changed;
}

// ─── EU Digital Services Act ────────────────────────────────────────────────

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Whether a targeting spec reaches the EU (countries or an EU/EEA country group). */
export function targetsEu(targeting: Record<string, unknown>): boolean {
  const geo = (targeting.geo_locations || {}) as Record<string, unknown>;
  const countries = Array.isArray(geo.countries) ? geo.countries as string[] : [];
  const groups = Array.isArray(geo.country_groups) ? geo.country_groups as string[] : [];
  return countries.some(c => EU_COUNTRIES.has(String(c).toUpperCase()))
    || groups.some(g => ['eu', 'eea', 'europe', 'worldwide'].includes(String(g).toLowerCase()));
}

/**
 * Fill dsa_beneficiary/dsa_payor for EU-targeted ad sets from
 * META_ADS_CLI_DSA_BENEFICIARY / META_ADS_CLI_DSA_PAYOR when not given.
 * Returns a warning when they're still missing.
 */
export function applyDsaDefaults(body: Record<string, string>, targeting: Record<string, unknown>): string | undefined {
  if (!targetsEu(targeting)) return undefined;
  if (!body.dsa_beneficiary && process.env.META_ADS_CLI_DSA_BENEFICIARY) body.dsa_beneficiary = process.env.META_ADS_CLI_DSA_BENEFICIARY;
  if (!body.dsa_payor && process.env.META_ADS_CLI_DSA_PAYOR) body.dsa_payor = process.env.META_ADS_CLI_DSA_PAYOR;
  if (body.dsa_beneficiary && body.dsa_payor) return undefined;
  return 'Warning: this ad set targets the EU but has no DSA beneficiary/payor. Meta rejects it unless the ad account has defaults. '
    + 'Pass --dsa-beneficiary/--dsa-payor or set META_ADS_CLI_DSA_BENEFICIARY/META_ADS_CLI_DSA_PAYOR.';
}

// ─── Learning phase ─────────────────────────────────────────────────────────

const SIGNIFICANT_FIELDS: Record<string, string> = {
  bid_amount: 'bid amount',
  bid_strategy: 'bid strategy',
  bid_constraints: 'bid constraints',
  targeting: 'targeting',
  optimization_goal: 'optimization goal',
  promoted_object: 'conversion event (promoted object)',
  billing_event: 'billing event',
};

/**
 * Which parts of an update count as "significant edits" that restart the
 * learning phase: bid, targeting, optimisation, conversion event, or a
 * budget change of more than 20%.
 */
export function significantEdits(body: Record<string, string>, current: Record<string, unknown>): string[] {
  const reasons = Object.keys(SIGNIFICANT_FIELDS).filter(k => body[k] !== undefined).map(k => SIGNIFICANT_FIELDS[k]);
  for (const field of ['daily_budget', 'lifetime_budget']) {
    if (body[field] === undefined) continue;
    const before = Number(current[field]);
    const after = Number(body[field]);
    if (before > 0 && Math.abs(after - before) / before > 0.2) {
      reasons.push(`${field.replace('_', ' ')} change of ${Math.round(((after - before) / before) * 100)}%`);
    }
  }
  return reasons;
}

// ─── Inline performance ─────────────────────────────────────────────────────

/** Field expansion that embeds insights for a date preset in a list request. */
export function insightsExpansion(preset: string): string {
  const time = insightsTimeParams(preset);
  if (!time.date_preset) throw new Error('--with-insights needs a named range such as last_7d');
  return `insights.date_preset(${time.date_preset}){${PERFORMANCE_FIELDS}}`;
}

const ASCENDING_METRICS = new Set(['cost_per_result', 'cpc', 'cpm']);

/**
 * Replace each row's embedded insights with derived performance (results,
 * cost per result, revenue, ROAS) for the ad set's optimisation event, and
 * optionally sort by a metric.
 */
export function attachPerformance(rows: Array<Record<string, unknown>>, sortBy?: string): void {
  for (const row of rows) {
    const adset = (row.adset as Record<string, unknown> | undefined) || row;
    const promoted = (adset.promoted_object || {}) as Record<string, unknown>;
    const event = resultEventFor({
      optimizationGoal: adset.optimization_goal as string | undefined,
      customEventType: promoted.custom_event_type as string | undefined,
    });
    const insights = ((row.insights as { data?: Record<string, unknown>[] } | undefined)?.data || [])[0] || {};
    row.performance = deriveMetrics(insights, event);
    delete row.insights;
  }
  if (!sortBy) return;
  const metric = sortBy as keyof DerivedMetrics;
  const asc = ASCENDING_METRICS.has(sortBy);
  rows.sort((a, b) => {
    const va = (a.performance as DerivedMetrics)[metric] as number | null;
    const vb = (b.performance as DerivedMetrics)[metric] as number | null;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return asc ? va - vb : vb - va;
  });
}

export const SORTABLE_METRICS = ['spend', 'results', 'cost_per_result', 'revenue', 'roas', 'ctr', 'cpc', 'cpm', 'impressions', 'frequency'];

export function assertSortable(sortBy: string | undefined): void {
  if (sortBy && !SORTABLE_METRICS.includes(sortBy)) {
    throw new Error(`--sort-by must be one of: ${SORTABLE_METRICS.join(', ')}`);
  }
}

export function registerAdSetCommands(program: Command, getClient: () => MetaClient): void {
  const adsets = program.command('adsets').description('Ad set management');

  adsets
    .command('list')
    .description('List ad sets for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--limit <n>', 'Maximum number of ad sets', '10')
    .option('--status <status>', 'Filter by effective status')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('--with-insights <range>', 'Add performance (spend, results, cost per result, revenue, ROAS) for a date preset, e.g. last_7d')
    .option('--sort-by <metric>', 'With --with-insights: sort by spend, results, cost_per_result, revenue, roas, ctr, cpc, cpm, impressions or frequency')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      assertSortable(opts.sortBy);
      if (opts.sortBy && !opts.withInsights) throw new Error('--sort-by needs --with-insights');
      const client = getClient();
      let fields = 'id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,targeting,bid_amount,bid_strategy,bid_constraints,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative,learning_stage_info,issues_info,destination_type,promoted_object,created_time,updated_time';
      if (opts.withInsights) fields += `,${insightsExpansion(opts.withInsights)}`;
      const params: Record<string, string> = {
        fields,
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }

      let endpoint: string;
      if (opts.campaignId) {
        endpoint = `${opts.campaignId}/adsets`;
      } else {
        endpoint = `${opts.accountId}/adsets`;
      }

      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      const rows = (response.data as { data?: Array<Record<string, unknown>> }).data;
      if (opts.withInsights && Array.isArray(rows)) attachPerformance(rows, opts.sortBy);

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('get <adsetId>')
    .description('Get detailed info for a specific ad set')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,targeting,bid_amount,bid_strategy,bid_adjustments,bid_constraints,optimization_goal,placement_soft_opt_out,existing_customer_budget_percentage,billing_event,start_time,end_time,adset_schedule,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type,attribution_spec,learning_stage_info,issues_info,pacing_type,adlabels,dsa_beneficiary,dsa_payor,brand_safety_config,source_adset_id,created_time,updated_time',
      };

      const response = await client.request(adsetId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('create')
    .description('Create a new ad set')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--campaign-id <id>', 'Campaign ID')
    .requiredOption('--name <name>', 'Ad set name')
    .requiredOption('--optimization-goal <goal>', 'Optimization goal (LINK_CLICKS, REACH, OFFSITE_CONVERSIONS, VALUE, LANDING_PAGE_VIEWS, THRUPLAY, LEAD_GENERATION, PROFILE_VISIT, etc.)')
    .requiredOption('--billing-event <event>', 'Billing event (IMPRESSIONS, LINK_CLICKS, etc.)')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--daily-budget <cents>', 'Daily budget in cents')
    .option('--lifetime-budget <cents>', 'Lifetime budget in cents')
    .option('--daily-min-spend-target <cents>', 'Minimum daily spend target in cents')
    .option('--daily-spend-cap <cents>', 'Maximum daily spend cap in cents')
    .option('--lifetime-min-spend-target <cents>', 'Minimum lifetime spend target in cents')
    .option('--lifetime-spend-cap <cents>', 'Maximum lifetime spend cap in cents')
    .option('--bid-amount <cents>', 'Bid amount in cents')
    .option('--bid-strategy <strategy>', 'Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS). Prefer the --roas-goal/--cost-cap/--bid-cap helpers')
    .option('--roas-goal <roas>', 'Minimum ROAS goal, e.g. 2.5 for 250% (sets LOWEST_COST_WITH_MIN_ROAS; needs --optimization-goal VALUE)')
    .option('--cost-cap <cents>', 'Target cost per result in cents (sets COST_CAP)')
    .option('--bid-cap <cents>', 'Maximum bid in cents (sets LOWEST_COST_WITH_BID_CAP)')
    .option('--bid-constraints <json>', 'Raw bid_constraints JSON (inline, @file or -)')
    .option('--targeting <json>', 'Targeting spec as JSON (inline, @file or -)')
    .option('--countries <codes>', 'Comma-separated country codes, merged into targeting.geo_locations')
    .option('--age-min <n>', 'Minimum age (13-65)')
    .option('--age-max <n>', 'Maximum age (13-65)')
    .option('--genders <g>', 'all, male or female')
    .option('--custom-audiences <ids>', 'Comma-separated custom audience IDs to include')
    .option('--excluded-custom-audiences <ids>', 'Comma-separated custom audience IDs to exclude (e.g. purchasers)')
    .option('--publisher-block-lists <ids>', 'Comma-separated publisher block list IDs (targeting.excluded_publisher_list_ids)')
    .option('--excluded-publisher-categories <cats>', 'Comma-separated publisher categories to exclude (e.g. debated_social_issues,mature_audiences,tragedy_and_conflict)')
    .option('--brand-safety-filter <levels>', 'Comma-separated inventory filter levels (brand_safety_content_filter_levels, e.g. FACEBOOK_STANDARD,AN_STANDARD)')
    .option('--placement-soft-opt-out <json>', 'Let up to 5% of spend reach excluded placements (placement_soft_opt_out JSON, Sales/Leads objectives)')
    .option('--creative-audience-pairing <0|1>', 'Advantage+ creative audience pairing (targeting.targeting_automation.creative_audience_pairing)')
    .option('--frequency-cap <n/days>', 'Frequency cap, e.g. 2/7 = at most 2 impressions per person per 7 days (REACH/THRUPLAY ad sets only)')
    .option('--targeting-automation <json>', 'Targeting automation config as JSON, merged into targeting.targeting_automation (v25: age/gender as suggestions)')
    .option('--advantage-audience <0|1>', 'Advantage+ audience: 1 lets Meta expand targeting, 0 keeps it as specified. Required for housing/employment/financial ad sets with custom audiences or interests')
    .option('--start-time <time>', 'Start time (ISO 8601)')
    .option('--end-time <time>', 'End time (ISO 8601)')
    .option('--adset-schedule <json>', 'Dayparting schedule as JSON array')
    .option('--promoted-object <json>', 'Promoted object as JSON string')
    .option('--destination-type <type>', 'Destination type (WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, WHATSAPP, etc.)')
    .option('--attribution-spec <json>', 'Attribution spec as JSON (e.g., [{"event_type":"CLICK_THROUGH","window_days":7}])')
    .option('--dynamic-creative', 'Enable dynamic creative')
    .option('--frequency-control-specs <json>', 'Frequency capping as JSON array (REACH/THRUPLAY ad sets only)')
    .option('--publisher-platforms <platforms>', 'Comma-separated publisher platforms (facebook,instagram,threads,messenger,audience_network,whatsapp)')
    .option('--facebook-positions <positions>', 'Comma-separated Facebook positions (feed,story,facebook_reels,marketplace,instream_video,search,right_hand_column,profile_feed,notification)')
    .option('--instagram-positions <positions>', 'Comma-separated Instagram positions (stream,story,reels,explore_home,profile_feed,ig_search,profile_reels)')
    .option('--threads-positions <positions>', 'Comma-separated Threads positions (threads_stream)')
    .option('--messenger-positions <positions>', 'Comma-separated Messenger positions (sponsored_messages)')
    .option('--whatsapp-positions <positions>', 'Comma-separated WhatsApp positions (status)')
    .option('--audience-network-positions <positions>', 'Comma-separated Audience Network positions (classic,rewarded_video)')
    .option('--device-platforms <platforms>', 'Comma-separated device platforms (mobile,desktop)')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--dsa-beneficiary <name>', 'EU/DSA ad beneficiary (default: META_ADS_CLI_DSA_BENEFICIARY for EU-targeted ad sets)')
    .option('--dsa-payor <name>', 'EU/DSA ad payor (default: META_ADS_CLI_DSA_PAYOR for EU-targeted ad sets)')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        campaign_id: opts.campaignId,
        name: opts.name,
        optimization_goal: opts.optimizationGoal,
        billing_event: opts.billingEvent,
        status: opts.status,
      };

      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.dailyMinSpendTarget) body.daily_min_spend_target = opts.dailyMinSpendTarget;
      if (opts.dailySpendCap) body.daily_spend_cap = opts.dailySpendCap;
      if (opts.lifetimeMinSpendTarget) body.lifetime_min_spend_target = opts.lifetimeMinSpendTarget;
      if (opts.lifetimeSpendCap) body.lifetime_spend_cap = opts.lifetimeSpendCap;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      applyBidHelpers(body, opts);
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.adsetSchedule) body.adset_schedule = jsonOption(opts.adsetSchedule, '--adset-schedule');
      if (opts.promotedObject) body.promoted_object = jsonOption(opts.promotedObject, '--promoted-object');
      if (opts.destinationType) body.destination_type = opts.destinationType;
      if (opts.attributionSpec) body.attribution_spec = jsonOption(opts.attributionSpec, '--attribution-spec');
      if (opts.dynamicCreative) body.is_dynamic_creative = 'true';
      if (opts.frequencyControlSpecs && opts.frequencyCap) throw new Error('Use either --frequency-cap or --frequency-control-specs');
      if (opts.frequencyControlSpecs) body.frequency_control_specs = jsonOption(opts.frequencyControlSpecs, '--frequency-control-specs');
      if (opts.frequencyCap) body.frequency_control_specs = frequencyCapSpecs(opts.frequencyCap);
      if (body.frequency_control_specs) assertFrequencyCapAllowed(opts.optimizationGoal);
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.dsaBeneficiary) body.dsa_beneficiary = opts.dsaBeneficiary;
      if (opts.dsaPayor) body.dsa_payor = opts.dsaPayor;
      if (opts.adlabels) body.adlabels = jsonOption(opts.adlabels, '--adlabels');
      if (opts.brandSafetyFilter) body.brand_safety_content_filter_levels = JSON.stringify(csvList(opts.brandSafetyFilter));
      if (opts.placementSoftOptOut) body.placement_soft_opt_out = jsonOption(opts.placementSoftOptOut, '--placement-soft-opt-out');

      // Build targeting with placement controls
      const targeting: Record<string, unknown> = opts.targeting ? parseJsonInput(opts.targeting, '--targeting') : {};
      applyTargetingHelpers(targeting, opts);
      if (opts.publisherPlatforms) targeting.publisher_platforms = opts.publisherPlatforms.split(',');
      if (opts.facebookPositions) targeting.facebook_positions = opts.facebookPositions.split(',');
      if (opts.instagramPositions) targeting.instagram_positions = opts.instagramPositions.split(',');
      if (opts.threadsPositions) targeting.threads_positions = opts.threadsPositions.split(',');
      if (opts.messengerPositions) targeting.messenger_positions = opts.messengerPositions.split(',');
      if (opts.whatsappPositions) targeting.whatsapp_positions = opts.whatsappPositions.split(',');
      if (opts.audienceNetworkPositions) targeting.audience_network_positions = opts.audienceNetworkPositions.split(',');
      if (opts.devicePlatforms) targeting.device_platforms = opts.devicePlatforms.split(',');
      applyTargetingAutomation(targeting, opts.targetingAutomation, parseAdvantageAudience(opts.advantageAudience));
      assertNoRemovedPlacements(targeting);
      await assertHecfAdvantageAudience(client, opts.campaignId, targeting);
      if (Object.keys(targeting).length > 0) body.targeting = JSON.stringify(targeting);
      const dsaWarning = applyDsaDefaults(body, targeting);
      if (dsaWarning) console.error(dsaWarning);

      const response = await client.request(`${opts.accountId}/adsets`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('update <adsetId>')
    .description('Update an existing ad set')
    .option('--name <name>', 'New ad set name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--daily-budget <cents>', 'New daily budget in cents')
    .option('--lifetime-budget <cents>', 'New lifetime budget in cents')
    .option('--daily-min-spend-target <cents>', 'Minimum daily spend target in cents')
    .option('--daily-spend-cap <cents>', 'Maximum daily spend cap in cents')
    .option('--lifetime-min-spend-target <cents>', 'Minimum lifetime spend target in cents')
    .option('--lifetime-spend-cap <cents>', 'Maximum lifetime spend cap in cents')
    .option('--bid-amount <cents>', 'New bid amount in cents')
    .option('--bid-strategy <strategy>', 'New bid strategy')
    .option('--roas-goal <roas>', 'Minimum ROAS goal, e.g. 2.5 (sets LOWEST_COST_WITH_MIN_ROAS)')
    .option('--cost-cap <cents>', 'Target cost per result in cents (sets COST_CAP)')
    .option('--bid-cap <cents>', 'Maximum bid in cents (sets LOWEST_COST_WITH_BID_CAP)')
    .option('--bid-constraints <json>', 'Raw bid_constraints JSON (inline, @file or -)')
    .option('--targeting <json>', 'New targeting spec as JSON (replaces it; inline, @file or -)')
    .option('--countries <codes>', 'Comma-separated country codes (merged into current targeting)')
    .option('--age-min <n>', 'Minimum age (13-65)')
    .option('--age-max <n>', 'Maximum age (13-65)')
    .option('--genders <g>', 'all, male or female')
    .option('--custom-audiences <ids>', 'Comma-separated custom audience IDs to include')
    .option('--excluded-custom-audiences <ids>', 'Comma-separated custom audience IDs to exclude')
    .option('--publisher-block-lists <ids>', 'Comma-separated publisher block list IDs')
    .option('--excluded-publisher-categories <cats>', 'Comma-separated publisher categories to exclude')
    .option('--brand-safety-filter <levels>', 'Comma-separated inventory filter levels (brand_safety_content_filter_levels)')
    .option('--placement-soft-opt-out <json>', 'placement_soft_opt_out JSON')
    .option('--creative-audience-pairing <0|1>', 'Advantage+ creative audience pairing')
    .option('--frequency-cap <n/days>', 'Frequency cap, e.g. 2/7 (REACH/THRUPLAY ad sets only)')
    .option('--frequency-control-specs <json>', 'Frequency capping as JSON array (REACH/THRUPLAY ad sets only)')
    .option('--promoted-object <json>', 'New promoted object JSON (conversion event)')
    .option('--destination-type <type>', 'New destination type')
    .option('--force', 'Apply significant edits even while the ad set is in the learning phase')
    .option('--targeting-automation <json>', 'Targeting automation config as JSON, merged into targeting.targeting_automation')
    .option('--advantage-audience <0|1>', 'Advantage+ audience: 1 lets Meta expand targeting, 0 keeps it as specified')
    .option('--optimization-goal <goal>', 'New optimization goal')
    .option('--start-time <time>', 'New start time (ISO 8601)')
    .option('--end-time <time>', 'New end time (ISO 8601)')
    .option('--adset-schedule <json>', 'Dayparting schedule as JSON array')
    .option('--attribution-spec <json>', 'Attribution spec as JSON')
    .option('--publisher-platforms <platforms>', 'Comma-separated publisher platforms (facebook,instagram,threads,messenger,audience_network,whatsapp)')
    .option('--facebook-positions <positions>', 'Comma-separated Facebook positions')
    .option('--instagram-positions <positions>', 'Comma-separated Instagram positions')
    .option('--threads-positions <positions>', 'Comma-separated Threads positions')
    .option('--messenger-positions <positions>', 'Comma-separated Messenger positions')
    .option('--whatsapp-positions <positions>', 'Comma-separated WhatsApp positions')
    .option('--audience-network-positions <positions>', 'Comma-separated Audience Network positions')
    .option('--device-platforms <platforms>', 'Comma-separated device platforms (mobile,desktop)')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--dsa-beneficiary <name>', 'EU/DSA ad beneficiary')
    .option('--dsa-payor <name>', 'EU/DSA ad payor')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.dailyMinSpendTarget) body.daily_min_spend_target = opts.dailyMinSpendTarget;
      if (opts.dailySpendCap) body.daily_spend_cap = opts.dailySpendCap;
      if (opts.lifetimeMinSpendTarget) body.lifetime_min_spend_target = opts.lifetimeMinSpendTarget;
      if (opts.lifetimeSpendCap) body.lifetime_spend_cap = opts.lifetimeSpendCap;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      applyBidHelpers(body, opts);
      if (opts.optimizationGoal) body.optimization_goal = opts.optimizationGoal;
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.adsetSchedule) body.adset_schedule = jsonOption(opts.adsetSchedule, '--adset-schedule');
      if (opts.promotedObject) body.promoted_object = jsonOption(opts.promotedObject, '--promoted-object');
      if (opts.destinationType) body.destination_type = opts.destinationType;
      if (opts.frequencyControlSpecs && opts.frequencyCap) throw new Error('Use either --frequency-cap or --frequency-control-specs');
      if (opts.frequencyControlSpecs) body.frequency_control_specs = jsonOption(opts.frequencyControlSpecs, '--frequency-control-specs');
      if (opts.frequencyCap) body.frequency_control_specs = frequencyCapSpecs(opts.frequencyCap);
      if (opts.brandSafetyFilter) body.brand_safety_content_filter_levels = JSON.stringify(csvList(opts.brandSafetyFilter));
      if (opts.placementSoftOptOut) body.placement_soft_opt_out = jsonOption(opts.placementSoftOptOut, '--placement-soft-opt-out');

      // Build targeting with placement controls
      const placements: Record<string, string[]> = {};
      if (opts.publisherPlatforms) placements.publisher_platforms = opts.publisherPlatforms.split(',');
      if (opts.facebookPositions) placements.facebook_positions = opts.facebookPositions.split(',');
      if (opts.instagramPositions) placements.instagram_positions = opts.instagramPositions.split(',');
      if (opts.threadsPositions) placements.threads_positions = opts.threadsPositions.split(',');
      if (opts.messengerPositions) placements.messenger_positions = opts.messengerPositions.split(',');
      if (opts.whatsappPositions) placements.whatsapp_positions = opts.whatsappPositions.split(',');
      if (opts.audienceNetworkPositions) placements.audience_network_positions = opts.audienceNetworkPositions.split(',');
      if (opts.devicePlatforms) placements.device_platforms = opts.devicePlatforms.split(',');
      const advantageAudience = parseAdvantageAudience(opts.advantageAudience);
      const hasPlacement = Object.keys(placements).length > 0;
      const hasHelpers = applyTargetingHelpers({}, opts);
      const changesTargeting = hasPlacement || hasHelpers || Boolean(opts.targetingAutomation) || advantageAudience !== undefined;

      let targeting: Record<string, unknown> = {};
      let campaignId: string | undefined;
      // In dry-run the read is a stub, so a merged preview would look like the
      // ad set's geo/audiences are being wiped. Preview only the changed keys.
      const previewMerge = client.isDryRun() && !opts.targeting && changesTargeting;
      if (opts.targeting || changesTargeting) {
        if (!client.isDryRun()) {
          const current = await client.request(adsetId, { params: { fields: 'targeting,campaign_id' } });
          const data = current.data as { targeting?: Record<string, unknown>; campaign_id?: string };
          campaignId = data.campaign_id;
          // Meta replaces the whole targeting spec, so merge placements and
          // automation into the current one instead of wiping geo/audiences.
          if (!opts.targeting && data.targeting) targeting = data.targeting;
        }
        if (opts.targeting) targeting = parseJsonInput(opts.targeting, '--targeting');
      }
      Object.assign(targeting, placements);
      applyTargetingHelpers(targeting, opts);
      applyTargetingAutomation(targeting, opts.targetingAutomation, advantageAudience);
      assertNoRemovedPlacements(targeting);
      if (opts.targeting || changesTargeting) {
        // Same checks as create: HEC-F ad sets need an explicit Advantage+
        // audience setting, and EU-targeted ad sets get DSA defaults.
        if (campaignId) await assertHecfAdvantageAudience(client, campaignId, targeting);
        body.targeting = JSON.stringify(targeting);
        if (!previewMerge) {
          const dsaWarning = applyDsaDefaults(body, targeting);
          if (dsaWarning) console.error(dsaWarning);
        } else {
          console.error('[dry-run] Targeting shows only the changed keys; the real update merges them into the ad set\'s current targeting.');
        }
      }
      if (opts.attributionSpec) body.attribution_spec = jsonOption(opts.attributionSpec, '--attribution-spec');
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.dsaBeneficiary) body.dsa_beneficiary = opts.dsaBeneficiary;
      if (opts.dsaPayor) body.dsa_payor = opts.dsaPayor;
      if (opts.adlabels) body.adlabels = jsonOption(opts.adlabels, '--adlabels');

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      // Check the current state once for the frequency-cap rule and the
      // learning-phase guard (skipped in dry-run, where reads are fake).
      const edits = significantEdits(body, {});
      const budgetChange = body.daily_budget !== undefined || body.lifetime_budget !== undefined;
      if (!client.isDryRun() && (body.frequency_control_specs || edits.length || budgetChange)) {
        const current = (await client.request(adsetId, {
          params: { fields: 'optimization_goal,daily_budget,lifetime_budget,learning_stage_info' },
        })).data as Record<string, unknown>;
        if (body.frequency_control_specs) assertFrequencyCapAllowed(body.optimization_goal || current.optimization_goal as string | undefined);
        const reasons = significantEdits(body, current);
        const learning = (current.learning_stage_info as { status?: string } | undefined)?.status;
        if (reasons.length && learning === 'LEARNING' && !opts.force) {
          throw new Error(
            `Ad set ${adsetId} is still in the learning phase, and this update is a significant edit (${reasons.join(', ')}) `
            + 'that restarts learning. Wait until it exits learning, or re-run with --force.',
          );
        }
        if (reasons.length && learning !== 'LEARNING') {
          console.error(`Warning: significant edit (${reasons.join(', ')}); Meta may restart the learning phase for this ad set.`);
        }
      } else if (body.frequency_control_specs) {
        assertFrequencyCapAllowed(body.optimization_goal);
      }

      const response = await client.request(adsetId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('delete <adsetId>')
    .description('Delete (archive) an ad set')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const response = await client.request(adsetId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
