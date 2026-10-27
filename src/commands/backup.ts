import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { MetaClient, API_VERSION, isPlaceholderId, PLACEHOLDER_PREFIX } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, PolicyError } from '../errors.js';
import { applyAdsetBudgetSharing, BLOCKED_SMART_PROMOTION_TYPES } from './campaigns.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

const SNAPSHOT_VERSION = 1;

// ── Field allowlists captured per entity. These mirror the create-paths in
//    campaigns.ts / adsets.ts / ads.ts / creatives.ts so a snapshot round-trips.

const CAMPAIGN_FIELDS = 'id,name,objective,status,buying_type,daily_budget,lifetime_budget,'
  + 'spend_cap,bid_strategy,special_ad_categories,special_ad_category_country,pacing_type,'
  + 'promoted_object,is_budget_schedule_enabled,is_adset_budget_sharing_enabled,smart_promotion_type';

const ADSET_FIELDS = 'id,name,campaign_id,status,daily_budget,lifetime_budget,'
  + 'daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,'
  + 'targeting,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,'
  + 'adset_schedule,is_dynamic_creative,frequency_control_specs,promoted_object,destination_type,'
  + 'attribution_spec,pacing_type,dsa_beneficiary,dsa_payor,regional_regulated_categories,regional_regulated_identities';

const AD_FIELDS = 'id,name,adset_id,campaign_id,status,effective_status,ad_review_feedback,creative,'
  + 'bid_amount,tracking_specs,conversion_domain';

const CREATIVE_FIELDS = 'id,name,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags,'
  + 'call_to_action_type,image_hash,image_url';

// Fields accepted by each create endpoint (everything else in a snapshot is metadata).
const CAMPAIGN_CREATE = new Set([
  'name', 'objective', 'status', 'buying_type', 'daily_budget', 'lifetime_budget',
  'spend_cap', 'bid_strategy', 'special_ad_categories', 'special_ad_category_country',
  'pacing_type', 'promoted_object', 'is_adset_budget_sharing_enabled',
]);
// smart_promotion_type is snapshotted (to detect Advantage+ Shopping/App
// campaigns) but never sent: Meta blocks creating those via the API.
const ADSET_CREATE = new Set([
  'name', 'status', 'daily_budget', 'lifetime_budget', 'daily_min_spend_target',
  'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap', 'targeting',
  'bid_amount', 'bid_strategy', 'optimization_goal', 'billing_event', 'start_time',
  'end_time', 'adset_schedule', 'is_dynamic_creative', 'frequency_control_specs',
  'promoted_object', 'destination_type', 'attribution_spec', 'pacing_type',
  'dsa_beneficiary', 'dsa_payor', 'regional_regulated_categories', 'regional_regulated_identities',
]);
const AD_CREATE = new Set(['name', 'status', 'bid_amount', 'tracking_specs', 'conversion_domain']);
// call_to_action_type is read-only metadata (the CTA lives in the story
// spec); sending it back makes Meta refuse the create with error #3.
const CREATIVE_CREATE = new Set([
  'name', 'object_story_spec', 'asset_feed_spec', 'degrees_of_freedom_spec', 'url_tags',
]);

interface CreativeSnap { id: string; [k: string]: unknown }
// Ad reads return creative as { id }, but the create endpoint expects
// { creative_id }. Capture both shapes.
interface AdSnap { id: string; adset_id?: string; creative?: { id?: string; creative_id?: string }; [k: string]: unknown }
interface AdSetSnap { id: string; campaign_id?: string; [k: string]: unknown }
interface CampaignSnap { id: string; [k: string]: unknown }

/** Creative media saved next to a snapshot (paths relative to the snapshot file). */
export interface MediaManifest {
  dir: string;
  images: Record<string, { file?: string; name?: string; url?: string; error?: string }>;
  videos: Record<string, { file?: string; title?: string; error?: string }>;
}

interface Snapshot {
  snapshot_version: number;
  exported_at: string;
  api_version: string;
  account_id: string;
  campaigns: CampaignSnap[];
  adsets: AdSetSnap[];
  ads: AdSnap[];
  creatives: CreativeSnap[];
  media?: MediaManifest;
}

/** Image hashes and video IDs a creative uses, wherever they sit in its specs. */
export function collectMedia(creatives: CreativeSnap[]): { images: Set<string>; videos: Set<string> } {
  const images = new Set<string>();
  const videos = new Set<string>();
  const walk = (v: unknown, parentKey = ''): void => {
    if (Array.isArray(v)) { v.forEach(x => walk(x, parentKey)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'image_hash' && typeof val === 'string' && val) images.add(val);
      else if (k === 'hash' && parentKey === 'images' && typeof val === 'string' && val) images.add(val);
      else if (k === 'video_id' && (typeof val === 'string' || typeof val === 'number') && val) videos.add(String(val));
      else walk(val, k);
    }
  };
  for (const c of creatives) walk({ image_hash: c.image_hash, object_story_spec: c.object_story_spec, asset_feed_spec: c.asset_feed_spec });
  return { images, videos };
}

/** Copy of a creative with image hashes and video IDs replaced per the maps. */
export function remapCreativeMedia<T>(creative: T, imageMap: Record<string, string>, videoMap: Record<string, string>): T {
  const walk = (v: unknown, parentKey = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, parentKey));
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'image_hash' || (k === 'hash' && parentKey === 'images')) && typeof val === 'string') out[k] = imageMap[val] ?? val;
      else if (k === 'video_id' && val !== undefined && val !== null) out[k] = videoMap[String(val)] ?? val;
      // Image URLs point at the source account's CDN copy; the hash is what counts.
      else if ((k === 'image_url' || k === 'picture') && parentKey !== '' && typeof val === 'string' && v && (v as Record<string, unknown>).image_hash) continue;
      else out[k] = walk(val, k);
    }
    return out;
  };
  return walk(creative) as T;
}

/** True when an ad was rejected or flagged in review. */
export function isRejectedAd(ad: AdSnap): boolean {
  const eff = String(ad.effective_status || '');
  const fb = ad.ad_review_feedback as Record<string, unknown> | undefined;
  return eff === 'DISAPPROVED' || eff === 'WITH_ISSUES' || Boolean(fb && (fb.global || fb.placement_specific));
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function extFromUrl(url: string, fallback: string): string {
  const m = /\.(jpe?g|png|gif|webp|mp4|mov)(?:\?|$)/i.exec(new URL(url).pathname);
  return m ? `.${m[1].toLowerCase()}` : fallback;
}

// Meta reports the unused budget as "0"; sending it back alongside the other
// budget gets the create rejected.
const ZERO_OMITTED = new Set(['daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount',
  'daily_min_spend_target', 'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap']);

/**
 * Tracking specs that reference the source account's posts or pages can't
 * be reused elsewhere; keep only pixel/app tracking (Meta adds the rest).
 */
export function portableTrackingSpecs(specs: unknown): unknown[] | undefined {
  if (!Array.isArray(specs)) return undefined;
  const kept = specs.filter(s => s && typeof s === 'object'
    && !('post' in s) && !('post.wall' in s) && !('page' in s)
    && ('fb_pixel' in s || 'application' in s || 'dataset' in s));
  return kept.length ? kept : undefined;
}

function pick(obj: Record<string, unknown>, allow: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!allow.has(k) || v === undefined || v === null) continue;
    if (ZERO_OMITTED.has(k) && Number(v) === 0) continue;
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
    .option('--campaign-ids <ids>', 'Only export these campaigns (comma-separated) and their ad sets, ads and creatives')
    .option('--adset-status <status>', 'Only keep ad sets with this configured status (ACTIVE, PAUSED)')
    .option('--ad-status <status>', 'Only keep ads with this configured status (ACTIVE, PAUSED)')
    .option('--skip-rejected', 'Leave out ads that are disapproved or flagged in review')
    .option('--with-media <dir>', 'Also download every image and video the creatives use into this folder, so the snapshot can be restored into another account')
    .option('-o, --output <format>', 'Output format when writing to stdout', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required (--account-id or META_ADS_CLI_ACCOUNT_ID)');
      const client = getClient();
      const pageLimit = parseInt(opts.pageLimit, 10);

      const filter: Record<string, string> = {};
      if (opts.status) filter.effective_status = JSON.stringify([opts.status]);
      const campaignIds = opts.campaignIds
        ? String(opts.campaignIds).split(',').map((x: string) => x.trim()).filter(Boolean)
        : undefined;
      const list = async <T>(endpoint: string, fields: string): Promise<T[]> => {
        const resp = await client.requestAllPages(endpoint, { params: { fields, limit: '100', ...filter } }, pageLimit);
        return ((resp.data as Record<string, unknown>).data as T[]) || [];
      };

      let campaigns: CampaignSnap[] = [];
      let adsets: AdSetSnap[] = [];
      let ads: AdSnap[] = [];
      if (campaignIds) {
        for (const id of campaignIds) {
          const camp = (await client.request(id, { params: { fields: CAMPAIGN_FIELDS } })).data as CampaignSnap;
          campaigns.push(camp);
          adsets.push(...await list<AdSetSnap>(`${id}/adsets`, ADSET_FIELDS));
          ads.push(...await list<AdSnap>(`${id}/ads`, AD_FIELDS));
        }
      } else {
        campaigns = await list<CampaignSnap>(`${opts.accountId}/campaigns`, CAMPAIGN_FIELDS);
        adsets = await list<AdSetSnap>(`${opts.accountId}/adsets`, ADSET_FIELDS);
        ads = await list<AdSnap>(`${opts.accountId}/ads`, AD_FIELDS);
      }

      const excluded: Record<string, number> = {};
      if (opts.adsetStatus) {
        const before = adsets.length;
        adsets = adsets.filter(a => String(a.status) === String(opts.adsetStatus).toUpperCase());
        excluded.adsets_by_status = before - adsets.length;
      }
      const keptAdsets = new Set(adsets.map(a => a.id));
      const beforeAds = ads.length;
      ads = ads.filter(a => keptAdsets.has(String(a.adset_id)));
      if (opts.adStatus) ads = ads.filter(a => String(a.status) === String(opts.adStatus).toUpperCase());
      if (opts.skipRejected) {
        const rejected = ads.filter(isRejectedAd);
        excluded.rejected_ads = rejected.length;
        ads = ads.filter(a => !isRejectedAd(a));
      }
      if (beforeAds !== ads.length) excluded.ads_total = beforeAds - ads.length;

      // Creatives (only those referenced by exported ads, to keep snapshots lean).
      // object_story_spec / asset_feed_spec are heavy — Meta returns a 500
      // ("reduce the amount of data") at large page sizes, so request a smaller
      // page (overridable via --creative-page-size).
      const referenced = new Set(
        ads.map((a) => a.creative?.id || a.creative?.creative_id).filter((x): x is string => !!x),
      );
      let creatives: CreativeSnap[] = [];
      if (!campaignIds || referenced.size > 100) {
        const creaResp = await client.requestAllPages(`${opts.accountId}/adcreatives`, {
          params: { fields: CREATIVE_FIELDS, limit: opts.creativePageSize },
        }, pageLimit);
        const allCreatives = ((creaResp.data as Record<string, unknown>).data as CreativeSnap[]) || [];
        creatives = referenced.size > 0 ? allCreatives.filter((c) => referenced.has(c.id)) : allCreatives;
      }
      // Fetch any referenced creative the listing missed (page limits, filters).
      const have = new Set(creatives.map(c => c.id));
      for (const id of referenced) {
        if (have.has(id)) continue;
        try {
          creatives.push((await client.request(id, { params: { fields: CREATIVE_FIELDS } })).data as CreativeSnap);
        } catch (err) {
          console.error(`Warning: creative ${id} could not be read (${(err as Error).message})`);
        }
      }

      let media: MediaManifest | undefined;
      if (opts.withMedia) {
        if (!opts.file) throw new Error('--with-media needs --file, so media paths can be stored relative to the snapshot');
        media = await exportMedia(client, opts.accountId, creatives, opts.withMedia, path.dirname(path.resolve(opts.file)));
      }

      const snapshot: Snapshot = {
        snapshot_version: SNAPSHOT_VERSION,
        exported_at: new Date().toISOString(),
        api_version: process.env.META_ADS_CLI_API_VERSION || API_VERSION,
        account_id: opts.accountId,
        campaigns,
        adsets,
        ads,
        creatives,
        ...(media ? { media } : {}),
      };

      const json = JSON.stringify(snapshot, null, 2);
      if (opts.file) {
        writeFileSync(opts.file, json);
        const mediaNote = media
          ? `, ${Object.keys(media.images).length} images, ${Object.keys(media.videos).length} videos`
          : '';
        console.error(
          `Exported ${campaigns.length} campaigns, ${adsets.length} ad sets, `
          + `${ads.length} ads, ${creatives.length} creatives${mediaNote} → ${opts.file}`
          + (Object.keys(excluded).length ? ` (excluded: ${JSON.stringify(excluded)})` : ''),
        );
        const failedMedia = media ? [...Object.entries(media.images), ...Object.entries(media.videos)].filter(([, m]) => m.error) : [];
        for (const [id, m] of failedMedia) console.error(`Warning: media ${id} not downloaded (${m.error})`);
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
    .option('--account-id <id>', 'Target account (default: the snapshot\'s account)')
    .option('--status <status>', 'Status for restored entities', 'PAUSED')
    .option('--name-suffix <text>', 'Append this to restored campaign, ad set and ad names')
    .option('--campaign-map <pairs>', 'Reuse existing campaigns instead of creating them: oldId=newId[,oldId=newId] (e.g. to finish a partial restore)')
    .option('--adset-map <pairs>', 'Reuse existing ad sets: oldId=newId[,...]')
    .option('--creative-map <pairs>', 'Reuse existing creatives: oldId=newId[,...]')
    .option('--exclude-countries <codes>', 'Add these countries (comma-separated, e.g. TW) to every restored ad set\'s excluded locations')
    .option('--yes', 'Confirm the restore (required for live writes)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const snap = JSON.parse(readFileSync(opts.file, 'utf8')) as Snapshot;
      if (snap.snapshot_version !== SNAPSHOT_VERSION) {
        throw new Error(`Unsupported snapshot_version ${snap.snapshot_version} (expected ${SNAPSHOT_VERSION}).`);
      }
      const accountId = opts.accountId || snap.account_id;
      const crossAccount = accountId !== snap.account_id;
      const client = getClient();
      const status = opts.status;
      const suffix = opts.nameSuffix ? String(opts.nameSuffix) : '';
      const named = (body: Record<string, string>) => { if (suffix && body.name) body.name = `${body.name}${suffix}`; };
      const reusedCampaigns = parseIdMap(opts.campaignMap);
      const reusedAdsets = parseIdMap(opts.adsetMap);
      const reusedCreatives = parseIdMap(opts.creativeMap);
      const excludeCountries = opts.excludeCountries
        ? String(opts.excludeCountries).split(',').map((c: string) => c.trim().toUpperCase()).filter(Boolean)
        : [];

      // Safety gate: require --yes for any live (non-dry-run) restore.
      // The MetaClient still enforces --read-only / --dry-run independently.
      // --dry-run, --plan and --validate create nothing live.
      const dryRun = client.isPreviewMode();
      const validating = client.isValidateMode();
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
      // Objects whose create call threw; their children are skipped.
      const failures: Array<{ type: string; id: string; error: string }> = [];
      const failedCreatives = new Set<string>();
      const skippedCampaigns: Array<{ id: string; name: string; smart_promotion_type: string }> = [];
      let created = 0;

      let synthSeq = 0;
      async function create(endpoint: string, body: Record<string, string>, type: string, oldId: string): Promise<string | null> {
        let resp;
        try {
          resp = await client.request(endpoint, { method: 'POST', body });
        } catch (err) {
          // A spend cap, read-only or policy block applies to every object, so stop
          // (exit 7) instead of recording it as an ordinary failure and going on.
          if (err instanceof PolicyError) throw err;
          // Keep going: one bad object shouldn't hide what was already created.
          failures.push({ type, id: oldId, error: (err as Error).message });
          return null;
        }
        const data = resp.data as { id?: string };
        if (data.id) {
          created++;
          return data.id;
        }
        // In dry-run the mock response has no id; synthesize one so the full
        // parent→child cascade still previews (IDs are remapped end-to-end).
        if (dryRun) {
          created++;
          return `${PLACEHOLDER_PREFIX}restore_${++synthSeq}`;
        }
        return null;
      }

      const report = (): void => {
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
          failed_objects: failures.length,
          failures,
          ...(crossAccount ? { source_account_id: snap.account_id, media: { ...mediaReport, image_map: imageMap, video_map: videoMap } } : {}),
          skipped_campaigns: skippedCampaigns,
          warnings,
        }, opts.output as OutputFormat));
      };
      // Under --validate, parents were only validated, so their children can't be checked.
      const notValidated = (what: string, parentId: string): boolean => {
        if (validating && isPlaceholderId(parentId)) {
          warnings.push(`${what} not validated — its parent was only validated, not created.`);
          return true;
        }
        return false;
      };

      // Media first: image hashes and video IDs belong to an ad account, so a
      // cross-account restore needs them copied before creatives can use them.
      const imageMap: Record<string, string> = {};
      const videoMap: Record<string, string> = {};
      const mediaReport: { images_copied: number; images_uploaded: number; videos_uploaded: number; failed: Array<{ id: string; error: string }> } = {
        images_copied: 0, images_uploaded: 0, videos_uploaded: 0, failed: [],
      };
      const creativesToCreate = snap.creatives.filter(c => !reusedCreatives[c.id]);
      if (crossAccount && creativesToCreate.length) {
        const baseDir = path.dirname(path.resolve(opts.file));
        await restoreMedia(client, snap, accountId, baseDir, imageMap, videoMap, mediaReport, dryRun);
        if (mediaReport.failed.length) {
          warnings.push(`${mediaReport.failed.length} media item(s) could not be copied; creatives using them will fail.`);
        }
      }

      try {
        // 1. Creatives first (ads reference them).
        for (const original of snap.creatives) {
          if (reusedCreatives[original.id]) {
            creativeMap[original.id] = reusedCreatives[original.id];
            continue;
          }
          const c = crossAccount ? remapCreativeMedia(original, imageMap, videoMap) : original;
          const body = pick(c, CREATIVE_CREATE);
          if (!body.name) body.name = `Restored creative ${c.id}`;
          const failedBefore = failures.length;
          const newId = await create(`${accountId}/adcreatives`, body, 'creative', c.id);
          if (newId) creativeMap[c.id] = newId;
          else if (failures.length > failedBefore) failedCreatives.add(c.id);
          else warnings.push(`Creative ${c.id} did not return an ID.`);
        }

        // 2. Campaigns.
        for (const camp of snap.campaigns) {
          if (reusedCampaigns[String(camp.id)]) {
            campaignMap[camp.id] = reusedCampaigns[String(camp.id)];
            continue;
          }
          const promoType = String(camp.smart_promotion_type || '');
          if (BLOCKED_SMART_PROMOTION_TYPES.has(promoType)) {
            // Children are skipped below because the campaign has no new ID.
            skippedCampaigns.push({ id: String(camp.id), name: String(camp.name ?? ''), smart_promotion_type: promoType });
            warnings.push(
              `Campaign ${camp.id} (${String(camp.name)}) skipped — it is an Advantage+ ${promoType === 'SMART_APP_PROMOTION' ? 'App' : 'Shopping'} `
              + `campaign (${promoType}), which Meta no longer allows creating via the API. Recreate it as a standard campaign.`,
            );
            continue;
          }
          const body = pick(camp, CAMPAIGN_CREATE);
          body.status = status;
          named(body);
          if (!body.special_ad_categories) body.special_ad_categories = JSON.stringify(['NONE']);
          applyAdsetBudgetSharing(body);
          const failedBefore = failures.length;
          const newId = await create(`${accountId}/campaigns`, body, 'campaign', camp.id);
          if (newId) campaignMap[camp.id] = newId;
          else if (failures.length === failedBefore) warnings.push(`Campaign ${camp.id} (${String(camp.name)}) did not return an ID.`);
        }

        // 3. Ad sets — remap campaign_id.
        for (const adset of snap.adsets) {
          if (reusedAdsets[adset.id]) {
            adsetMap[adset.id] = reusedAdsets[adset.id];
            continue;
          }
          const body = pick(adset, ADSET_CREATE);
          body.status = status;
          named(body);
          const oldCamp = String(adset.campaign_id || '');
          const newCamp = campaignMap[oldCamp];
          if (!newCamp) {
            warnings.push(`Ad set ${adset.id} skipped — parent campaign ${oldCamp} not restored.`);
            continue;
          }
          if (notValidated(`Ad set ${adset.id}`, newCamp)) continue;
          body.campaign_id = newCamp;
          if (excludeCountries.length && body.targeting) body.targeting = JSON.stringify(excludeFromTargeting(JSON.parse(body.targeting), excludeCountries));
          const failedBefore = failures.length;
          const newId = await create(`${accountId}/adsets`, body, 'adset', adset.id);
          if (newId) adsetMap[adset.id] = newId;
          else if (failures.length === failedBefore) warnings.push(`Ad set ${adset.id} (${String(adset.name)}) did not return an ID.`);
        }

        // 4. Ads — remap adset_id + creative.
        for (const ad of snap.ads) {
          const body = pick(ad, AD_CREATE);
          body.status = status;
          named(body);
          if (crossAccount) {
            const tracking = portableTrackingSpecs(ad.tracking_specs);
            if (tracking) body.tracking_specs = JSON.stringify(tracking);
            else delete body.tracking_specs;
          }
          const oldAdset = String(ad.adset_id || '');
          const newAdset = adsetMap[oldAdset];
          if (!newAdset) {
            warnings.push(`Ad ${ad.id} skipped — parent ad set ${oldAdset} not restored.`);
            continue;
          }
          if (notValidated(`Ad ${ad.id}`, newAdset)) continue;
          body.adset_id = newAdset;
          const oldCreative = ad.creative?.id || ad.creative?.creative_id;
          const newCreative = oldCreative ? creativeMap[oldCreative] : undefined;
          if (newCreative && notValidated(`Ad ${ad.id}`, newCreative)) continue;
          if (newCreative) {
            body.creative = JSON.stringify({ creative_id: newCreative });
          } else if (oldCreative && crossAccount) {
            // A creative from another account can't be used here.
            warnings.push(`Ad ${ad.id} skipped — its creative ${oldCreative} was not restored into ${accountId}.`);
            continue;
          } else if (oldCreative) {
            // Fall back to referencing the original creative ID (may still be valid).
            body.creative = JSON.stringify({ creative_id: oldCreative });
            warnings.push(failedCreatives.has(oldCreative)
              ? `Ad ${ad.id}: creative ${oldCreative} failed to restore — referencing original ID.`
              : `Ad ${ad.id}: creative ${oldCreative} not in snapshot — referencing original ID.`);
          }
          const failedBefore = failures.length;
          const newId = await create(`${accountId}/ads`, body, 'ad', ad.id);
          if (!newId && failures.length === failedBefore) warnings.push(`Ad ${ad.id} (${String(ad.name)}) did not return an ID.`);
        }

      } catch (err) {
        if (err instanceof PolicyError) {
          // Show what was created before the block, then exit with the policy code.
          report();
          console.error('Restore stopped: blocked by a spend cap, read-only mode or policy. Objects in id_map were created.');
        }
        throw err;
      }

      report();
      if (failures.length > 0) {
        console.error(`Restore finished with ${failures.length} failure(s); see "failures". Objects in id_map were created.`);
        process.exitCode = 1;
      }
    }));
}

/** Download every image and video the creatives use, and record them in a manifest. */
async function exportMedia(client: MetaClient, accountId: string, creatives: CreativeSnap[], dir: string, snapshotDir: string): Promise<MediaManifest> {
  const { images, videos } = collectMedia(creatives);
  const absDir = path.resolve(dir);
  mkdirSync(path.join(absDir, 'images'), { recursive: true });
  mkdirSync(path.join(absDir, 'videos'), { recursive: true });
  const manifest: MediaManifest = { dir: path.relative(snapshotDir, absDir) || '.', images: {}, videos: {} };

  const hashes = [...images];
  for (let i = 0; i < hashes.length; i += 50) {
    const batch = hashes.slice(i, i + 50);
    const resp = await client.request(`${accountId}/adimages`, {
      params: { hashes: JSON.stringify(batch), fields: 'hash,name,url,width,height' },
    });
    const found = ((resp.data as { data?: Array<{ hash: string; name?: string; url?: string }> }).data) || [];
    for (const hash of batch) {
      const img = found.find(f => f.hash === hash);
      if (!img?.url) { manifest.images[hash] = { error: 'not found in the ad account image library' }; continue; }
      const file = path.join('images', `${hash}${extFromUrl(img.url, '.jpg')}`);
      try {
        if (!client.isDryRun()) await download(img.url, path.join(absDir, file));
        manifest.images[hash] = { file, name: img.name, url: img.url };
      } catch (err) {
        manifest.images[hash] = { name: img.name, url: img.url, error: (err as Error).message };
      }
    }
  }

  for (const id of videos) {
    try {
      const v = (await client.request(id, { params: { fields: 'source,title' } })).data as { source?: string; title?: string };
      if (!v.source) { manifest.videos[id] = { title: v.title, error: 'no downloadable source' }; continue; }
      const file = path.join('videos', `${id}${extFromUrl(v.source, '.mp4')}`);
      if (!client.isDryRun()) await download(v.source, path.join(absDir, file));
      manifest.videos[id] = { file, title: v.title };
    } catch (err) {
      manifest.videos[id] = { error: (err as Error).message };
    }
  }
  return manifest;
}

/** The hash Meta returns for an adimages upload or copy ({images: {key: {hash}}}). */
function returnedHash(data: unknown): string | undefined {
  const images = (data as { images?: Record<string, { hash?: string }> }).images;
  return images ? Object.values(images).find(i => i.hash)?.hash : undefined;
}

/**
 * Put the snapshot's media into the target account: images are copied
 * server-side (copy_from), falling back to uploading the exported file;
 * videos are uploaded from the exported file. Fills imageMap/videoMap.
 */
async function restoreMedia(
  client: MetaClient, snap: Snapshot, accountId: string, baseDir: string,
  imageMap: Record<string, string>, videoMap: Record<string, string>,
  report: { images_copied: number; images_uploaded: number; videos_uploaded: number; failed: Array<{ id: string; error: string }> },
  preview: boolean,
): Promise<void> {
  const { images, videos } = collectMedia(snap.creatives);
  const mediaDir = snap.media ? path.resolve(baseDir, snap.media.dir) : undefined;
  const sourceAccount = snap.account_id.replace(/^act_/, '');

  for (const hash of images) {
    try {
      const copied = await client.request(`${accountId}/adimages`, {
        method: 'POST',
        body: { copy_from: JSON.stringify({ source_account_id: sourceAccount, hash }) },
      });
      imageMap[hash] = returnedHash(copied.data) || (preview ? hash : '');
      if (!imageMap[hash]) throw new Error('copy returned no hash');
      report.images_copied++;
      continue;
    } catch (err) {
      const entry = snap.media?.images[hash];
      const file = entry?.file && mediaDir ? path.join(mediaDir, entry.file) : undefined;
      if (!file || !existsSync(file)) {
        report.failed.push({ id: hash, error: `copy failed (${(err as Error).message}) and no exported file (export with --with-media)` });
        continue;
      }
      try {
        const uploaded = await client.request(`${accountId}/adimages`, {
          method: 'POST',
          body: { bytes: readFileSync(file).toString('base64'), name: entry?.name || path.basename(file) },
        });
        const newHash = returnedHash(uploaded.data) || (preview ? hash : undefined);
        if (!newHash) throw new Error('upload returned no hash');
        imageMap[hash] = newHash;
        report.images_uploaded++;
      } catch (uploadErr) {
        if (uploadErr instanceof PolicyError) throw uploadErr;
        report.failed.push({ id: hash, error: (uploadErr as Error).message });
      }
    }
  }

  for (const id of videos) {
    const entry = snap.media?.videos[id];
    const file = entry?.file && mediaDir ? path.join(mediaDir, entry.file) : undefined;
    if (!file || !existsSync(file)) {
      report.failed.push({ id, error: 'video file not exported (export with --with-media)' });
      continue;
    }
    try {
      const uploaded = await client.uploadFile(`${accountId}/advideos`, file, entry?.title ? { title: entry.title } : {});
      const newId = (uploaded.data as { id?: string }).id;
      if (!newId) throw new Error('upload returned no id');
      videoMap[id] = newId;
      report.videos_uploaded++;
      if (!preview && !isPlaceholderId(newId)) await waitForVideo(client, newId);
    } catch (err) {
      if (err instanceof PolicyError) throw err;
      report.failed.push({ id, error: (err as Error).message });
    }
  }
}

/** Creatives can't use a video until Meta has processed it. */
async function waitForVideo(client: MetaClient, id: string, timeoutMs = 600_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = (await client.request(id, { params: { fields: 'status' } })).data as { status?: { video_status?: string } };
    const st = v.status?.video_status;
    if (st === 'ready') return;
    if (st === 'error') throw new Error(`video ${id} failed processing`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`video ${id} was still processing after ${Math.round(timeoutMs / 60000)} minutes`);
}

/** Parse "old=new,old=new" into a map. */
export function parseIdMap(value: unknown): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const pair of String(value).split(',').map(p => p.trim()).filter(Boolean)) {
    const [from, to] = pair.split('=').map(x => x?.trim());
    if (!from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to)) throw new Error(`Invalid map entry "${pair}". Use oldId=newId.`);
    out[from] = to;
  }
  return out;
}

/** Targeting with these countries added to excluded_geo_locations. */
export function excludeFromTargeting(targeting: Record<string, unknown>, countries: string[]): Record<string, unknown> {
  const excluded = { ...((targeting.excluded_geo_locations as Record<string, unknown>) || {}) };
  const current = Array.isArray(excluded.countries) ? (excluded.countries as string[]) : [];
  excluded.countries = [...new Set([...current, ...countries])];
  return { ...targeting, excluded_geo_locations: excluded };
}
