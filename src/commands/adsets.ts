import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
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
    .requiredOption('--optimization-goal <goal>', 'Optimization goal (LINK_CLICKS, REACH, CONVERSIONS, VALUE, etc.)')
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
    .option('--targeting-automation <json>', 'Targeting automation config as JSON (v25: age/gender as suggestions)')
    .option('--start-time <time>', 'Start time (ISO 8601)')
    .option('--end-time <time>', 'End time (ISO 8601)')
    .option('--adset-schedule <json>', 'Dayparting schedule as JSON array')
    .option('--promoted-object <json>', 'Promoted object as JSON string')
    .option('--destination-type <type>', 'Destination type (WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, WHATSAPP, etc.)')
    .option('--attribution-spec <json>', 'Attribution spec as JSON (e.g., [{"event_type":"CLICK_THROUGH","window_days":7}])')
    .option('--dynamic-creative', 'Enable dynamic creative')
    .option('--frequency-control-specs <json>', 'Frequency capping as JSON array')
    .option('--publisher-platforms <platforms>', 'Comma-separated publisher platforms (facebook,instagram,threads,messenger,audience_network,whatsapp)')
    .option('--facebook-positions <positions>', 'Comma-separated Facebook positions (feed,story,reels,marketplace,video_feeds,instream_video,search,right_hand_column,profile_feed)')
    .option('--instagram-positions <positions>', 'Comma-separated Instagram positions (stream,story,explore,reels,explore_home,profile_feed,ig_search,profile_reels)')
    .option('--threads-positions <positions>', 'Comma-separated Threads positions (threads_stream)')
    .option('--messenger-positions <positions>', 'Comma-separated Messenger positions (sponsored_messages,story)')
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
      if (opts.targetingAutomation) body.targeting_automation = opts.targetingAutomation;
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
    .option('--targeting-automation <json>', 'Targeting automation config as JSON')
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
      if (opts.targetingAutomation) body.targeting_automation = opts.targetingAutomation;
      if (opts.optimizationGoal) body.optimization_goal = opts.optimizationGoal;
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.endTime) body.end_time = opts.endTime;
      if (opts.adsetSchedule) body.adset_schedule = opts.adsetSchedule;

      // Build targeting with placement controls
      const targeting = opts.targeting ? JSON.parse(opts.targeting) : {};
      let hasPlacement = false;
      if (opts.publisherPlatforms) { targeting.publisher_platforms = opts.publisherPlatforms.split(','); hasPlacement = true; }
      if (opts.facebookPositions) { targeting.facebook_positions = opts.facebookPositions.split(','); hasPlacement = true; }
      if (opts.instagramPositions) { targeting.instagram_positions = opts.instagramPositions.split(','); hasPlacement = true; }
      if (opts.threadsPositions) { targeting.threads_positions = opts.threadsPositions.split(','); hasPlacement = true; }
      if (opts.messengerPositions) { targeting.messenger_positions = opts.messengerPositions.split(','); hasPlacement = true; }
      if (opts.whatsappPositions) { targeting.whatsapp_positions = opts.whatsappPositions.split(','); hasPlacement = true; }
      if (opts.audienceNetworkPositions) { targeting.audience_network_positions = opts.audienceNetworkPositions.split(','); hasPlacement = true; }
      if (opts.devicePlatforms) { targeting.device_platforms = opts.devicePlatforms.split(','); hasPlacement = true; }
      if (opts.targeting || hasPlacement) body.targeting = JSON.stringify(targeting);
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
