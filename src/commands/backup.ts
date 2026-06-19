import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'fs';
import { MetaClient, API_VERSION } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const SNAPSHOT_VERSION = 1;

// ── Field allowlists captured per entity. These mirror the create-paths in
//    campaigns.ts / adsets.ts / ads.ts / creatives.ts so a snapshot round-trips.

const CAMPAIGN_FIELDS = 'id,name,objective,status,buying_type,daily_budget,lifetime_budget,'
  + 'spend_cap,bid_strategy,special_ad_categories,special_ad_category_country,pacing_type,'
  + 'promoted_object,is_budget_schedule_enabled,smart_promotion_type';

const ADSET_FIELDS = 'id,name,campaign_id,status,daily_budget,lifetime_budget,'
  + 'daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,'
  + 'targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,'
  + 'adset_schedule,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type,'
  + 'attribution_spec,pacing_type,dsa_beneficiary,dsa_payor';

const AD_FIELDS = 'id,name,adset_id,campaign_id,status,creative,bid_amount,tracking_specs,'
  + 'conversion_domain';

const CREATIVE_FIELDS = 'id,name,object_story_spec,asset_feed_spec,url_tags,'
  + 'call_to_action_type,image_hash,image_url';

// Fields accepted by each create endpoint (everything else in a snapshot is metadata).
const CAMPAIGN_CREATE = new Set([
  'name', 'objective', 'status', 'buying_type', 'daily_budget', 'lifetime_budget',
  'spend_cap', 'bid_strategy', 'special_ad_categories', 'special_ad_category_country',
  'pacing_type', 'promoted_object', 'smart_promotion_type',
]);
const ADSET_CREATE = new Set([
  'name', 'status', 'daily_budget', 'lifetime_budget', 'daily_min_spend_target',
  'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap', 'targeting',
  'bid_amount', 'bid_strategy', 'optimization_goal', 'billing_event', 'start_time',
  'end_time', 'adset_schedule', 'is_dynamic_creative', 'frequency_control_specs',
  'promoted_object', 'destination_type', 'attribution_spec', 'pacing_type',
  'dsa_beneficiary', 'dsa_payor',
]);
const AD_CREATE = new Set(['name', 'status', 'bid_amount', 'tracking_specs', 'conversion_domain']);
const CREATIVE_CREATE = new Set([
  'name', 'object_story_spec', 'asset_feed_spec', 'url_tags', 'call_to_action_type',
]);

interface CreativeSnap { id: string; [k: string]: unknown }
// Ad reads return creative as { id }, but the create endpoint expects
// { creative_id }. Capture both shapes.
interface AdSnap { id: string; adset_id?: string; creative?: { id?: string; creative_id?: string }; [k: string]: unknown }
interface AdSetSnap { id: string; campaign_id?: string; [k: string]: unknown }
interface CampaignSnap { id: string; [k: string]: unknown }

interface Snapshot {
  snapshot_version: number;
  exported_at: string;
  api_version: string;
  account_id: string;
  campaigns: CampaignSnap[];
  adsets: AdSetSnap[];
  ads: AdSnap[];
  creatives: CreativeSnap[];
}

function pick(obj: Record<string, unknown>, allow: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!allow.has(k) || v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

export function registerBackupCommands(program: Command, getClient: () => MetaClient): void {
  const backup = program.command('backup').description('Export, restore, and diff full account structure');

  // ── export ────────────────────────────────────────────────────────────────
  backup
    .command('export')
    .description('Export the full campaign → ad set → ad → creative structure to a JSON snapshot')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--file <path>', 'Write snapshot to this file (default: stdout)')
    .option('--status <status>', 'Only export entities with this effective status (e.g. ACTIVE)')
    .option('--page-limit <n>', 'Max pages per entity type', '50')
    .option('--creative-page-size <n>', 'Page size for creatives (heavy specs — keep low to avoid API 500s)', '25')
    .option('-o, --output <format>', 'Output format when writing to stdout', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required (--account-id or META_ADS_CLI_ACCOUNT_ID)');
      const client = getClient();
      const pageLimit = parseInt(opts.pageLimit, 10);

      const filter: Record<string, string> = {};
      if (opts.status) filter.effective_status = JSON.stringify([opts.status]);

      // Campaigns
      const campResp = await client.requestAllPages(`${opts.accountId}/campaigns`, {
        params: { fields: CAMPAIGN_FIELDS, limit: '100', ...filter },
      }, pageLimit);
      const campaigns = ((campResp.data as Record<string, unknown>).data as CampaignSnap[]) || [];

      // Ad sets
      const adsetResp = await client.requestAllPages(`${opts.accountId}/adsets`, {
        params: { fields: ADSET_FIELDS, limit: '100', ...filter },
      }, pageLimit);
      const adsets = ((adsetResp.data as Record<string, unknown>).data as AdSetSnap[]) || [];

      // Ads
      const adResp = await client.requestAllPages(`${opts.accountId}/ads`, {
        params: { fields: AD_FIELDS, limit: '100', ...filter },
      }, pageLimit);
      const ads = ((adResp.data as Record<string, unknown>).data as AdSnap[]) || [];

      // Creatives (only those referenced by exported ads, to keep snapshots lean).
      // object_story_spec / asset_feed_spec are heavy — Meta returns a 500
      // ("reduce the amount of data") at large page sizes, so request a smaller
      // page (overridable via --creative-page-size).
      const referenced = new Set(
        ads.map((a) => a.creative?.id || a.creative?.creative_id).filter((x): x is string => !!x),
      );
      const creaResp = await client.requestAllPages(`${opts.accountId}/adcreatives`, {
        params: { fields: CREATIVE_FIELDS, limit: opts.creativePageSize },
      }, pageLimit);
      const allCreatives = ((creaResp.data as Record<string, unknown>).data as CreativeSnap[]) || [];
      const creatives = referenced.size > 0
        ? allCreatives.filter((c) => referenced.has(c.id))
        : allCreatives;

      const snapshot: Snapshot = {
        snapshot_version: SNAPSHOT_VERSION,
        exported_at: new Date().toISOString(),
        api_version: process.env.META_ADS_CLI_API_VERSION || API_VERSION,
        account_id: opts.accountId,
        campaigns,
        adsets,
        ads,
        creatives,
      };

      const json = JSON.stringify(snapshot, null, 2);
      if (opts.file) {
        writeFileSync(opts.file, json);
        console.error(
          `Exported ${campaigns.length} campaigns, ${adsets.length} ad sets, `
          + `${ads.length} ads, ${creatives.length} creatives → ${opts.file}`,
        );
      } else {
        console.log(formatOutput(snapshot, opts.output as OutputFormat));
      }
    }));

  // ── diff ──────────────────────────────────────────────────────────────────
  backup
    .command('diff')
    .description('Compare a snapshot file against the current live account structure')
    .requiredOption('--file <path>', 'Snapshot file to compare')
    .option('--account-id <id>', 'Ad account to compare against (default: snapshot account)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const snap = JSON.parse(readFileSync(opts.file, 'utf8')) as Snapshot;
      const accountId = opts.accountId || snap.account_id;
      const client = getClient();

      const liveCampaigns = ((await client.requestAllPages(`${accountId}/campaigns`, {
        params: { fields: 'id,name', limit: '100' },
      }, 50).then((r) => (r.data as Record<string, unknown>).data)) as Array<{ id: string; name: string }>) || [];
      const liveAdsets = ((await client.requestAllPages(`${accountId}/adsets`, {
        params: { fields: 'id,name', limit: '100' },
      }, 50).then((r) => (r.data as Record<string, unknown>).data)) as Array<{ id: string; name: string }>) || [];
      const liveAds = ((await client.requestAllPages(`${accountId}/ads`, {
        params: { fields: 'id,name', limit: '100' },
      }, 50).then((r) => (r.data as Record<string, unknown>).data)) as Array<{ id: string; name: string }>) || [];

      const liveCampIds = new Set(liveCampaigns.map((c) => c.id));
      const liveAdsetIds = new Set(liveAdsets.map((a) => a.id));
      const liveAdIds = new Set(liveAds.map((a) => a.id));

      const result = {
        account_id: accountId,
        snapshot_exported_at: snap.exported_at,
        campaigns: {
          in_snapshot: snap.campaigns.length,
          live: liveCampaigns.length,
          missing_from_live: snap.campaigns.filter((c) => !liveCampIds.has(c.id)).map((c) => ({ id: c.id, name: c.name })),
        },
        adsets: {
          in_snapshot: snap.adsets.length,
          live: liveAdsets.length,
          missing_from_live: snap.adsets.filter((a) => !liveAdsetIds.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
        },
        ads: {
          in_snapshot: snap.ads.length,
          live: liveAds.length,
          missing_from_live: snap.ads.filter((a) => !liveAdIds.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
        },
      };
      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  // ── restore ─────────────────────────────────────────────────────────────────
  backup
    .command('restore')
    .description('Recreate campaigns/ad sets/ads/creatives from a snapshot into an account (paused by default)')
    .requiredOption('--file <path>', 'Snapshot file to restore from')
    .option('--account-id <id>', 'Target account (default: snapshot account)', getDefaultAccountId())
    .option('--status <status>', 'Status for restored entities', 'PAUSED')
    .option('--yes', 'Confirm the restore (required for live writes)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const snap = JSON.parse(readFileSync(opts.file, 'utf8')) as Snapshot;
      if (snap.snapshot_version !== SNAPSHOT_VERSION) {
        throw new Error(`Unsupported snapshot_version ${snap.snapshot_version} (expected ${SNAPSHOT_VERSION}).`);
      }
      const accountId = opts.accountId || snap.account_id;
      const client = getClient();
      const status = opts.status;

      // Safety gate: require --yes for any live (non-dry-run) restore.
      // The MetaClient still enforces --read-only / --dry-run independently.
      const dryRun = process.argv.includes('--dry-run');
      if (!opts.yes && !dryRun) {
        throw new Error(
          'Restore creates live objects. Re-run with --yes to confirm, or add --dry-run to preview. '
          + `This would recreate ${snap.campaigns.length} campaigns, ${snap.adsets.length} ad sets, `
          + `${snap.ads.length} ads, ${snap.creatives.length} creatives into ${accountId}.`,
        );
      }

      // ID remapping: old snapshot ID → newly created ID.
      const campaignMap: Record<string, string> = {};
      const adsetMap: Record<string, string> = {};
      const creativeMap: Record<string, string> = {};
      const warnings: string[] = [];
      let created = 0;

      let synthSeq = 0;
      async function create(endpoint: string, body: Record<string, string>): Promise<string | null> {
        const resp = await client.request(endpoint, { method: 'POST', body });
        const data = resp.data as { id?: string };
        if (data.id) {
          created++;
          return data.id;
        }
        // In dry-run the mock response has no id; synthesize one so the full
        // parent→child cascade still previews (IDs are remapped end-to-end).
        if (dryRun) {
          created++;
          return `dryrun_${++synthSeq}`;
        }
        return null;
      }

      // 1. Creatives first (ads reference them).
      for (const c of snap.creatives) {
        const body = pick(c, CREATIVE_CREATE);
        if (!body.name) body.name = `Restored creative ${c.id}`;
        const newId = await create(`${accountId}/adcreatives`, body);
        if (newId) creativeMap[c.id] = newId;
        else warnings.push(`Creative ${c.id} did not return an ID.`);
      }

      // 2. Campaigns.
      for (const camp of snap.campaigns) {
        const body = pick(camp, CAMPAIGN_CREATE);
        body.status = status;
        if (!body.special_ad_categories) body.special_ad_categories = JSON.stringify(['NONE']);
        const newId = await create(`${accountId}/campaigns`, body);
        if (newId) campaignMap[camp.id] = newId;
        else warnings.push(`Campaign ${camp.id} (${String(camp.name)}) did not return an ID.`);
      }

      // 3. Ad sets — remap campaign_id.
      for (const adset of snap.adsets) {
        const body = pick(adset, ADSET_CREATE);
        body.status = status;
        const oldCamp = String(adset.campaign_id || '');
        const newCamp = campaignMap[oldCamp];
        if (!newCamp) {
          warnings.push(`Ad set ${adset.id} skipped — parent campaign ${oldCamp} not restored.`);
          continue;
        }
        body.campaign_id = newCamp;
        const newId = await create(`${accountId}/adsets`, body);
        if (newId) adsetMap[adset.id] = newId;
        else warnings.push(`Ad set ${adset.id} (${String(adset.name)}) did not return an ID.`);
      }

      // 4. Ads — remap adset_id + creative.
      for (const ad of snap.ads) {
        const body = pick(ad, AD_CREATE);
        body.status = status;
        const oldAdset = String(ad.adset_id || '');
        const newAdset = adsetMap[oldAdset];
        if (!newAdset) {
          warnings.push(`Ad ${ad.id} skipped — parent ad set ${oldAdset} not restored.`);
          continue;
        }
        body.adset_id = newAdset;
        const oldCreative = ad.creative?.id || ad.creative?.creative_id;
        const newCreative = oldCreative ? creativeMap[oldCreative] : undefined;
        if (newCreative) {
          body.creative = JSON.stringify({ creative_id: newCreative });
        } else if (oldCreative) {
          // Fall back to referencing the original creative ID (may still be valid).
          body.creative = JSON.stringify({ creative_id: oldCreative });
          warnings.push(`Ad ${ad.id}: creative ${oldCreative} not in snapshot — referencing original ID.`);
        }
        const newId = await create(`${accountId}/ads`, body);
        if (!newId) warnings.push(`Ad ${ad.id} (${String(ad.name)}) did not return an ID.`);
      }

      console.log(formatOutput({
        account_id: accountId,
        dry_run: dryRun,
        restored_status: status,
        created_objects: created,
        id_map: {
          campaigns: campaignMap,
          adsets: adsetMap,
          creatives: creativeMap,
        },
        warnings,
      }, opts.output as OutputFormat));
    }));
}
