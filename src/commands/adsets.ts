import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

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
    ...(automationJson ? JSON.parse(automationJson) : {}),
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
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,is_dynamic_creative,learning_stage_info,issues_info,destination_type,promoted_object,created_time,updated_time',
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

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  adsets
    .command('get <adsetId>')
    .description('Get detailed info for a specific ad set')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adsetId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,targeting,bid_amount,bid_strategy,bid_adjustments,bid_constraints,optimization_goal,billing_event,start_time,end_time,adset_schedule,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type,attribution_spec,learning_stage_info,issues_info,pacing_type,adlabels,dsa_beneficiary,dsa_payor,brand_safety_config,source_adset_id,created_time,updated_time',
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
    .option('--bid-strategy <strategy>', 'Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP, LOWEST_COST_WITH_MIN_ROAS)')
    .option('--targeting <json>', 'Targeting spec as JSON string')
    .option('--targeting-automation <json>', 'Targeting automation config as JSON, merged into targeting.targeting_automation (v25: age/gender as suggestions)')
    .option('--advantage-audience <0|1>', 'Advantage+ audience: 1 lets Meta expand targeting, 0 keeps it as specified. Required for housing/employment/financial ad sets with custom audiences or interests')
    .option('--start-time <time>', 'Start time (ISO 8601)')
    .option('--end-time <time>', 'End time (ISO 8601)')
    .option('--adset-schedule <json>', 'Dayparting schedule as JSON array')
    .option('--promoted-object <json>', 'Promoted object as JSON string')
    .option('--destination-type <type>', 'Destination type (WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, WHATSAPP, etc.)')
    .option('--attribution-spec <json>', 'Attribution spec as JSON (e.g., [{"event_type":"CLICK_THROUGH","window_days":7}])')
    .option('--dynamic-creative', 'Enable dynamic creative')
    .option('--frequency-control-specs <json>', 'Frequency capping as JSON array')
    .option('--publisher-platforms <platforms>', 'Comma-separated publisher platforms (facebook,instagram,threads,messenger,audience_network,whatsapp)')
    .option('--facebook-positions <positions>', 'Comma-separated Facebook positions (feed,story,facebook_reels,marketplace,instream_video,search,right_hand_column,profile_feed,notification)')
    .option('--instagram-positions <positions>', 'Comma-separated Instagram positions (stream,story,reels,explore_home,profile_feed,ig_search,profile_reels)')
    .option('--threads-positions <positions>', 'Comma-separated Threads positions (threads_stream)')
    .option('--messenger-positions <positions>', 'Comma-separated Messenger positions (sponsored_messages)')
    .option('--whatsapp-positions <positions>', 'Comma-separated WhatsApp positions (status)')
    .option('--audience-network-positions <positions>', 'Comma-separated Audience Network positions (classic,rewarded_video)')
    .option('--device-platforms <platforms>', 'Comma-separated device platforms (mobile,desktop)')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--dsa-beneficiary <name>', 'EU/DSA ad beneficiary')
    .option('--dsa-payor <name>', 'EU/DSA ad payor')
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
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.adsetSchedule) body.adset_schedule = opts.adsetSchedule;
      if (opts.promotedObject) body.promoted_object = opts.promotedObject;
      if (opts.destinationType) body.destination_type = opts.destinationType;
      if (opts.attributionSpec) body.attribution_spec = opts.attributionSpec;
      if (opts.dynamicCreative) body.is_dynamic_creative = 'true';
      if (opts.frequencyControlSpecs) body.frequency_control_specs = opts.frequencyControlSpecs;
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.dsaBeneficiary) body.dsa_beneficiary = opts.dsaBeneficiary;
      if (opts.dsaPayor) body.dsa_payor = opts.dsaPayor;
      if (opts.adlabels) body.adlabels = opts.adlabels;

      // Build targeting with placement controls
      const targeting = opts.targeting ? JSON.parse(opts.targeting) : {};
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
    .option('--targeting <json>', 'New targeting spec as JSON string')
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
      if (opts.optimizationGoal) body.optimization_goal = opts.optimizationGoal;
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.adsetSchedule) body.adset_schedule = opts.adsetSchedule;

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
      const changesTargeting = hasPlacement || Boolean(opts.targetingAutomation) || advantageAudience !== undefined;

      let targeting: Record<string, unknown> = {};
      if (opts.targeting) {
        targeting = JSON.parse(opts.targeting);
      } else if (changesTargeting) {
        // Meta replaces the whole targeting spec, so merge placements and
        // automation into the current one instead of wiping geo/audiences.
        const current = await client.request(adsetId, { params: { fields: 'targeting' } });
        const existing = (current.data as { targeting?: Record<string, unknown> }).targeting;
        if (existing) targeting = existing;
      }
      Object.assign(targeting, placements);
      applyTargetingAutomation(targeting, opts.targetingAutomation, advantageAudience);
      assertNoRemovedPlacements(targeting);
      if (opts.targeting || changesTargeting) body.targeting = JSON.stringify(targeting);
      if (opts.attributionSpec) body.attribution_spec = opts.attributionSpec;
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.dsaBeneficiary) body.dsa_beneficiary = opts.dsaBeneficiary;
      if (opts.dsaPayor) body.dsa_payor = opts.dsaPayor;
      if (opts.adlabels) body.adlabels = opts.adlabels;

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
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
