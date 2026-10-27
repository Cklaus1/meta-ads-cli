import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { significantChangeWarning, validateBidConfig } from './bidding.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Meta requires is_adset_budget_sharing_enabled when a campaign has no
 * campaign-level budget (the ad sets carry the budget). Sets it to the given
 * value, defaulting to false, and leaves campaigns with a budget untouched.
 */
export function applyAdsetBudgetSharing(body: Record<string, string>, sharing?: boolean | string): Record<string, string> {
  const hasCampaignBudget = Boolean(body.daily_budget) || Boolean(body.lifetime_budget);
  if (!hasCampaignBudget && body.is_adset_budget_sharing_enabled === undefined) {
    body.is_adset_budget_sharing_enabled = String(sharing === true || sharing === 'true');
  }
  return body;
}

/** Advantage+ Shopping/App campaign types Meta no longer lets the API create or copy. */
export const BLOCKED_SMART_PROMOTION_TYPES = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION']);

/** Throw if a campaign's data shows it is an Advantage+ Shopping/App campaign, which Meta blocks copying via API. */
export function assertCopyableCampaign(campaign: Record<string, unknown>, campaignId: string): void {
  const type = campaign.smart_promotion_type;
  if (typeof type === 'string' && BLOCKED_SMART_PROMOTION_TYPES.has(type)) {
    throw new Error(
      `Campaign ${campaignId} is a legacy Advantage+ ${type === 'SMART_APP_PROMOTION' ? 'App' : 'Shopping'} campaign (${type}). `
      + 'Meta no longer allows creating, copying or editing these via the API. Create a new campaign instead: '
      + 'an OUTCOME_SALES/OUTCOME_APP_PROMOTION campaign with a campaign budget, Advantage+ audience and no placement '
      + 'restrictions reaches Advantage+ state (meta-ads campaigns create --advantage-plus).',
    );
  }
}

/** Special ad categories that restrict targeting (housing, employment, credit/financial, issues/politics). */
const RESTRICTED_CATEGORIES = new Set(['HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES', 'ISSUES_ELECTIONS_POLITICS']);

/**
 * Targeting options Meta rejects or ignores for housing/employment/credit/
 * financial ads: narrowed age/gender, postal codes and lookalike audiences.
 */
export function specialCategoryTargetingIssues(targeting: Record<string, unknown> | undefined, categories: string[]): string[] {
  const restricted = categories.filter(c => RESTRICTED_CATEGORIES.has(c) && c !== 'ISSUES_ELECTIONS_POLITICS');
  if (!restricted.length || !targeting) return [];
  const issues: string[] = [];
  const ageMin = Number(targeting.age_min ?? 18);
  const ageMax = Number(targeting.age_max ?? 65);
  if (ageMin > 18 || ageMax < 65) issues.push(`Age must be 18-65+ for ${restricted.join('/')} ads (got ${ageMin}-${ageMax}).`);
  if (Array.isArray(targeting.genders) && targeting.genders.length) issues.push('Gender targeting is not allowed for special ad categories.');
  const geo = targeting.geo_locations as Record<string, unknown> | undefined;
  if (geo?.zips) issues.push('Postal-code targeting is not allowed for special ad categories; use cities or regions with a 15+ mile radius.');
  const audiences = targeting.custom_audiences as Array<Record<string, unknown>> | undefined;
  if (audiences?.some(a => String(a.subtype || '').toUpperCase() === 'LOOKALIKE')) {
    issues.push('Lookalike audiences are not allowed for special ad categories.');
  }
  return issues;
}

function parseCategories(value: string | undefined): string[] {
  return value ? value.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : [];
}

export function registerCampaignCommands(program: Command, getClient: () => MetaClient): void {
  const campaigns = program.command('campaigns').alias('camp').description('Campaign management');

  campaigns
    .command('list')
    .description('List campaigns for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum number of campaigns', '10')
    .option('--status <status>', 'Filter by effective status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--after <cursor>', 'Pagination cursor')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('--page-delay <ms>', 'Delay between pages in ms')
    .option('-o, --output <format>', 'Output format: json, table, csv, text, yaml', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,objective,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,spend_cap,buying_type,bid_strategy,start_time,stop_time,created_time,updated_time,special_ad_categories,pacing_type,issues_info,smart_promotion_type,advantage_state_info',
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }
      if (opts.after) {
        params.after = opts.after;
      }

      const endpoint = `${opts.accountId}/campaigns`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined,
            opts.pageDelay ? parseInt(opts.pageDelay) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('get <campaignId>')
    .description('Get detailed info for a specific campaign')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,objective,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,spend_cap,buying_type,bid_strategy,start_time,stop_time,created_time,updated_time,special_ad_categories,special_ad_category_country,pacing_type,promoted_object,issues_info,adlabels,is_budget_schedule_enabled,is_adset_budget_sharing_enabled,source_campaign_id,smart_promotion_type,advantage_state_info',
      };

      const response = await client.request(campaignId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('create')
    .description('Create a new campaign')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Campaign name')
    .requiredOption('--objective <objective>', 'Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION)')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--daily-budget <cents>', 'Daily budget in cents')
    .option('--lifetime-budget <cents>', 'Lifetime budget in cents')
    .option('--bid-strategy <strategy>', 'Bid strategy (LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP)')
    .option('--bid-cap <cents>', 'Bid cap in cents')
    .option('--spend-cap <cents>', 'Campaign spend cap in cents')
    .option('--buying-type <type>', 'Buying type (e.g., AUCTION)')
    .option('--special-ad-categories <categories>', 'Comma-separated special ad categories')
    .option('--special-ad-category-country <countries>', 'Comma-separated country codes for special ad categories')
    .option('--promoted-object <json>', 'Promoted object as JSON, @file or - (e.g., {"pixel_id":"123","custom_event_type":"PURCHASE"})')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--cbo', 'Deprecated no-op: a campaign-level budget is Advantage+ campaign budget (formerly CBO)')
    .option('--advantage-plus', 'Set up for Advantage+ state: requires a campaign budget; then create ad sets with --advantage-audience 1 and no placement restrictions')
    .option('--pca-unified', 'Mark an OUTCOME_SALES campaign as PCA-unified (is_pca_unified; immutable after creation)')
    .option('--adset-level-budgets', 'Use ad set level budgets instead of campaign level')
    .option('--adset-budget-sharing', 'With ad set budgets, let ad sets share up to 20% of budget (is_adset_budget_sharing_enabled)')
    .option('--start-time <time>', 'Campaign start time (ISO 8601)')
    .option('--stop-time <time>', 'Campaign stop time (ISO 8601)')
    .option('--adlabels <json>', 'Ad labels as JSON array, @file or -')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        objective: opts.objective,
        status: opts.status,
        special_ad_categories: JSON.stringify(parseCategories(opts.specialAdCategories)),
      };

      if (opts.cbo) {
        console.error('Note: --cbo is a no-op. A budget on the campaign (--daily-budget/--lifetime-budget) is Advantage+ campaign budget.');
      }
      if (!opts.adsetLevelBudgets) {
        if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
        if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      }
      if (opts.advantagePlus) {
        if (!['OUTCOME_SALES', 'OUTCOME_APP_PROMOTION', 'OUTCOME_LEADS'].includes(opts.objective)) {
          throw new Error('--advantage-plus applies to OUTCOME_SALES, OUTCOME_APP_PROMOTION and OUTCOME_LEADS campaigns.');
        }
        if (opts.adsetLevelBudgets || (!opts.dailyBudget && !opts.lifetimeBudget)) {
          throw new Error('--advantage-plus needs a campaign budget (--daily-budget or --lifetime-budget); ad set budgets disable Advantage+ state.');
        }
      }
      if (opts.pcaUnified) {
        if (opts.objective !== 'OUTCOME_SALES') throw new Error('--pca-unified applies to OUTCOME_SALES campaigns only.');
        body.is_pca_unified = 'true';
      }
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.bidCap) body.bid_cap = opts.bidCap;
      if (opts.spendCap) body.spend_cap = opts.spendCap;
      if (opts.buyingType) body.buying_type = opts.buyingType;
      if (opts.specialAdCategoryCountry) body.special_ad_category_country = JSON.stringify(opts.specialAdCategoryCountry.split(','));
      if (opts.promotedObject) body.promoted_object = JSON.stringify(parseJsonInput(opts.promotedObject, '--promoted-object'));
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.stopTime) body.stop_time = opts.stopTime;
      if (opts.adlabels) body.adlabels = JSON.stringify(parseJsonInput(opts.adlabels, '--adlabels'));
      if (opts.bidStrategy === 'TARGET_COST') {
        throw new Error('TARGET_COST was deprecated in Marketing API v9. Use COST_CAP.');
      }
      applyAdsetBudgetSharing(body, opts.adsetBudgetSharing);

      const response = await client.request(`${opts.accountId}/campaigns`, {
        method: 'POST',
        body,
      });

      const result: Record<string, unknown> = { ...(response.data as Record<string, unknown>) };
      if (opts.advantagePlus) {
        result.next_steps = [
          'Create ad sets with: meta-ads adsets create ... --advantage-audience 1 (no placement flags = Advantage+ placements)',
          `Then confirm: meta-ads campaigns get ${result.id ?? '<id>'} (advantage_state_info.advantage_state should not be DISABLED)`,
        ];
      }
      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  campaigns
    .command('update <campaignId>')
    .description('Update an existing campaign')
    .option('--name <name>', 'New campaign name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--daily-budget <cents>', 'New daily budget in cents')
    .option('--lifetime-budget <cents>', 'New lifetime budget in cents')
    .option('--bid-strategy <strategy>', 'New bid strategy')
    .option('--bid-cap <cents>', 'New bid cap in cents')
    .option('--spend-cap <cents>', 'New spend cap in cents')
    .option('--pacing-type <type>', 'Pacing type (standard, no_pacing)')
    .option('--start-time <time>', 'Campaign start time (ISO 8601)')
    .option('--stop-time <time>', 'Campaign stop time (ISO 8601)')
    .option('--adlabels <json>', 'Ad labels as JSON array, @file or -')
    .option('--special-ad-categories <categories>', 'Comma-separated special ad categories (NONE to clear)')
    .option('--special-ad-category-country <countries>', 'Comma-separated country codes for special ad categories')
    .option('--force', 'Apply a large budget change even while ad sets are in the learning phase')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.dailyBudget) body.daily_budget = opts.dailyBudget;
      if (opts.lifetimeBudget) body.lifetime_budget = opts.lifetimeBudget;
      if (opts.bidStrategy) body.bid_strategy = opts.bidStrategy;
      if (opts.bidCap) body.bid_cap = opts.bidCap;
      if (opts.spendCap) body.spend_cap = opts.spendCap;
      if (opts.pacingType) body.pacing_type = JSON.stringify([opts.pacingType]);
      if (opts.startTime) body.start_time = opts.startTime;
      if (opts.stopTime) body.stop_time = opts.stopTime;
      if (opts.adlabels) body.adlabels = JSON.stringify(parseJsonInput(opts.adlabels, '--adlabels'));
      if (opts.bidStrategy === 'TARGET_COST') throw new Error('TARGET_COST was deprecated in Marketing API v9. Use COST_CAP.');
      if (opts.specialAdCategories) {
        const cats = parseCategories(opts.specialAdCategories).filter(c => c !== 'NONE');
        body.special_ad_categories = JSON.stringify(cats);
      }
      if (opts.specialAdCategoryCountry) body.special_ad_category_country = JSON.stringify(opts.specialAdCategoryCountry.split(','));

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      // Large budget jumps count as significant edits and can reset learning.
      if ((body.daily_budget || body.lifetime_budget) && !client.isDryRun()) {
        const [currentRes, adsetsRes] = await Promise.all([
          client.request(campaignId, { params: { fields: 'daily_budget,lifetime_budget' } }),
          // Every ad set, not just the first page of a field expansion.
          client.requestAllPages(`${campaignId}/adsets`, { params: { fields: 'learning_stage_info,effective_status', limit: '200' } }),
        ]);
        const current = currentRes.data as Record<string, unknown>;
        const field = body.daily_budget ? 'daily_budget' : 'lifetime_budget';
        const learning = (((adsetsRes.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [])
          .some(a => a.effective_status === 'ACTIVE' && (a.learning_stage_info as Record<string, unknown> | undefined)?.status === 'LEARNING');
        const warning = significantChangeWarning(Number(current[field] || 0), Number(body[field]), learning ? 'LEARNING' : undefined);
        if (warning && learning && !opts.force) {
          throw new Error(`${warning} Re-run with --force to apply anyway, or change the budget in steps of ~20%.`);
        }
        if (warning) console.error(`Warning: ${warning}`);
      }
      if (body.special_ad_categories && !client.isDryRun()) {
        const cats = JSON.parse(body.special_ad_categories) as string[];
        const adsets = (await client.request(`${campaignId}/adsets`, { params: { fields: 'id,name,targeting', limit: '100' } })).data as Record<string, unknown>;
        for (const a of (adsets.data as Array<Record<string, unknown>>) || []) {
          for (const issue of specialCategoryTargetingIssues(a.targeting as Record<string, unknown>, cats)) {
            console.error(`Warning: ad set ${a.id} (${a.name}): ${issue}`);
          }
        }
      }

      const response = await client.request(campaignId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  campaigns
    .command('preflight <campaignId>')
    .description('Will this campaign deliver? Checks account, campaign, ad sets, ads, creatives, schedule, learning and special-category targeting')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const campaign = (await client.request(campaignId, {
        params: { fields: 'id,name,account_id,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time,special_ad_categories,issues_info,smart_promotion_type,advantage_state_info' },
      })).data as Record<string, unknown>;
      const [account, adsetsRes, adsRes] = await Promise.all([
        campaign.account_id
          ? client.request(`act_${campaign.account_id}`, { params: { fields: 'id,name,account_status,disable_reason,spend_cap,amount_spent,currency,funding_source' } })
          : Promise.resolve({ data: {} }),
        client.requestAllPages(`${campaignId}/adsets`, {
          params: { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,bid_constraints,promoted_object,targeting,start_time,end_time,learning_stage_info,issues_info', limit: '100' },
        }),
        client.requestAllPages(`${campaignId}/ads`, {
          params: { fields: 'id,name,adset_id,status,effective_status,creative{id},ad_review_feedback,issues_info', limit: '200' },
        }),
      ]);
      const checks = preflightChecks(
        campaign,
        account.data as Record<string, unknown>,
        ((adsetsRes.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [],
        ((adsRes.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [],
      );
      const fails = checks.filter(c => c.status === 'fail').length;
      console.log(formatOutput({
        campaign_id: campaignId,
        campaign_name: campaign.name,
        will_deliver: fails === 0,
        summary: { fail: fails, warn: checks.filter(c => c.status === 'warn').length, ok: checks.filter(c => c.status === 'ok').length },
        checks,
      }, opts.output as OutputFormat));
      if (fails) process.exitCode = 1;
    }));

  campaigns
    .command('delete <campaignId>')
    .description('Delete (archive) a campaign')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (campaignId: string, opts) => {
      const client = getClient();
      const response = await client.request(campaignId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}

export interface PreflightCheck {
  status: 'ok' | 'warn' | 'fail';
  scope: string;
  check: string;
  detail: string;
}

// Meta account_status codes (AdAccount reference).
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};

/** Pure checks behind `campaigns preflight`, so they can be tested without the API. */
export function preflightChecks(
  campaign: Record<string, unknown>,
  account: Record<string, unknown>,
  adsets: Array<Record<string, unknown>>,
  ads: Array<Record<string, unknown>>,
  now = Date.now(),
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const add = (status: PreflightCheck['status'], scope: string, check: string, detail: string) => checks.push({ status, scope, check, detail });

  // Account
  if (account && account.account_status !== undefined) {
    const code = Number(account.account_status);
    const name = ACCOUNT_STATUS[code] || String(code);
    if (code === 1) add('ok', 'account', 'status', 'Account is active.');
    else add('fail', 'account', 'status', `Account status is ${name}${account.disable_reason ? ` (disable_reason ${account.disable_reason})` : ''}. Resolve it in Account Quality / Billing.`);
    const cap = Number(account.spend_cap || 0);
    const spent = Number(account.amount_spent || 0);
    if (cap > 0 && spent >= cap) add('fail', 'account', 'spend_cap', 'Account spend limit reached; raise or reset it.');
    else if (cap > 0 && spent >= cap * 0.9) add('warn', 'account', 'spend_cap', `Account has used ${(spent / cap * 100).toFixed(0)}% of its spend limit.`);
  }

  // Campaign
  const status = String(campaign.status || '');
  if (status === 'ACTIVE') add('ok', 'campaign', 'status', 'Campaign is ACTIVE.');
  else add('warn', 'campaign', 'status', `Campaign status is ${status || 'unknown'}; it will not deliver until set ACTIVE.`);
  if (campaign.effective_status && !['ACTIVE', 'PAUSED'].includes(String(campaign.effective_status))) {
    add('fail', 'campaign', 'effective_status', `Effective status ${campaign.effective_status}.`);
  }
  const type = campaign.smart_promotion_type;
  if (typeof type === 'string' && BLOCKED_SMART_PROMOTION_TYPES.has(type)) {
    add('warn', 'campaign', 'legacy_advantage_plus', `Legacy ${type} campaign; it can't be edited via the API.`);
  }
  const stop = Date.parse(String(campaign.stop_time || ''));
  if (Number.isFinite(stop) && stop < now) add('fail', 'campaign', 'schedule', `Campaign stop time ${campaign.stop_time} is in the past.`);
  for (const issue of (campaign.issues_info as Array<Record<string, unknown>>) || []) {
    add('fail', 'campaign', 'delivery_issue', String(issue.error_summary || issue.error_message || JSON.stringify(issue)));
  }
  const campaignBudget = Number(campaign.daily_budget || 0) > 0 || Number(campaign.lifetime_budget || 0) > 0;

  const objective = campaign.objective as string | undefined;
  const categories = ((campaign.special_ad_categories as string[]) || []).filter(c => c !== 'NONE');

  // Ad sets
  if (!adsets.length) add('fail', 'campaign', 'adsets', 'Campaign has no ad sets.');
  const deliverableAdsets = new Set<string>();
  for (const a of adsets) {
    const scope = `adset ${a.id} (${a.name})`;
    const aStatus = String(a.status || '');
    const active = aStatus === 'ACTIVE';
    if (!active) {
      add('warn', scope, 'status', `Ad set status is ${aStatus}; it won't deliver, so its problems are reported as warnings.`);
    } else {
      deliverableAdsets.add(String(a.id));
    }
    // Problems on paused or archived ad sets don't stop the campaign delivering.
    const addFor = (st: PreflightCheck['status'], sc: string, check: string, detail: string) =>
      add(st === 'fail' && !active ? 'warn' : st, sc, check, detail);
    const adsetBudget = Number(a.daily_budget || 0) > 0 || Number(a.lifetime_budget || 0) > 0;
    if (!campaignBudget && !adsetBudget) addFor('fail', scope, 'budget', 'No budget at campaign or ad set level.');
    if (campaignBudget && adsetBudget) addFor('fail', scope, 'budget', 'Budget set on both campaign and ad set; Meta rejects this.');
    const targeting = a.targeting as Record<string, unknown> | undefined;
    const geo = targeting?.geo_locations as Record<string, unknown> | undefined;
    if (!geo || !Object.keys(geo).length) addFor('fail', scope, 'targeting', 'No geo_locations in targeting.');
    for (const issue of specialCategoryTargetingIssues(targeting, categories)) addFor('fail', scope, 'special_ad_category', issue);
    const end = Date.parse(String(a.end_time || ''));
    if (Number.isFinite(end) && end < now) addFor('fail', scope, 'schedule', `End time ${a.end_time} is in the past.`);
    if (a.optimization_goal) {
      const { errors } = validateBidConfig({
        objective,
        optimizationGoal: String(a.optimization_goal),
        billingEvent: a.billing_event as string | undefined,
        bidStrategy: a.bid_strategy as string | undefined,
        bidAmount: a.bid_amount as string | undefined,
        roasGoal: (a.bid_constraints as Record<string, unknown> | undefined)?.roas_average_floor !== undefined
          ? Number((a.bid_constraints as Record<string, unknown>).roas_average_floor) / 10000 : undefined,
        promotedObject: a.promoted_object as Record<string, unknown> | undefined,
      });
      for (const e of errors) addFor('fail', scope, 'bidding', e);
    }
    const learning = (a.learning_stage_info as Record<string, unknown> | undefined)?.status;
    if (learning === 'FAIL') addFor('warn', scope, 'learning', 'Learning limited: too few results to exit learning.');
    else if (learning === 'LEARNING') addFor('warn', scope, 'learning', 'In the learning phase; avoid significant edits.');
    for (const issue of (a.issues_info as Array<Record<string, unknown>>) || []) {
      addFor('fail', scope, 'delivery_issue', String(issue.error_summary || issue.error_message || JSON.stringify(issue)));
    }
  }

  // Ads
  for (const a of adsets) {
    const adsetAds = ads.filter(ad => String(ad.adset_id) === String(a.id));
    const active = deliverableAdsets.has(String(a.id));
    if (!adsetAds.length) add(active ? 'fail' : 'warn', `adset ${a.id} (${a.name})`, 'ads', 'Ad set has no ads.');
    else if (!adsetAds.some(ad => ad.status === 'ACTIVE')) add('warn', `adset ${a.id} (${a.name})`, 'ads', 'No ACTIVE ads in this ad set.');
  }
  for (const ad of ads) {
    const scope = `ad ${ad.id} (${ad.name})`;
    // Only ads that are ACTIVE in an ACTIVE ad set can block delivery.
    const live = ad.status === 'ACTIVE' && deliverableAdsets.has(String(ad.adset_id));
    const addAd = (st: PreflightCheck['status'], check: string, detail: string) => add(st === 'fail' && !live ? 'warn' : st, scope, check, detail);
    if (!(ad.creative as Record<string, unknown> | undefined)?.id) addAd('fail', 'creative', 'Ad has no creative.');
    const eff = String(ad.effective_status || '');
    if (eff === 'DISAPPROVED') addAd('fail', 'review', `Disapproved: ${JSON.stringify(ad.ad_review_feedback || {})}`);
    else if (eff === 'PENDING_REVIEW' || eff === 'IN_PROCESS') addAd('warn', 'review', `Ad is ${eff}.`);
    else if (eff === 'WITH_ISSUES') addAd('fail', 'review', 'Ad has issues; see issues_info.');
    for (const issue of (ad.issues_info as Array<Record<string, unknown>>) || []) {
      addAd('fail', 'delivery_issue', String(issue.error_summary || issue.error_message || JSON.stringify(issue)));
    }
  }
  if (deliverableAdsets.size === 0 && adsets.length) add('fail', 'campaign', 'adsets', 'No ACTIVE ad sets, so nothing can deliver.');

  if (!checks.some(c => c.status !== 'ok')) add('ok', 'campaign', 'overall', 'No blocking issues found.');
  return checks;
}
