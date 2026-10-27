import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { MetaClient, isPlaceholderId, PLACEHOLDER_PREFIX } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { applyAdsetBudgetSharing, specialCategoryTargetingIssues } from './campaigns.js';
import { DEFAULT_GOAL_BY_OBJECTIVE, validateBidConfig, roasFloor } from './bidding.js';
import { validateAccountId } from '../validate.js';

/**
 * Launch spec: one campaign with its ad sets and ads, applied idempotently by
 * name. Money is in cents, like the rest of the CLI.
 *
 * {
 *   "account": "act_123",
 *   "campaign": { "name": "Fall Sale", "objective": "OUTCOME_SALES", "daily_budget": 5000 },
 *   "adsets": [{
 *     "name": "US 25-44",
 *     "optimization_goal": "OFFSITE_CONVERSIONS",
 *     "promoted_object": { "pixel_id": "1", "custom_event_type": "PURCHASE" },
 *     "targeting": { "geo_locations": { "countries": ["US"] }, "age_min": 25, "age_max": 44 },
 *     "ads": [{
 *       "name": "Hero",
 *       "creative": { "page_id": "2", "image": "./hero.jpg", "message": "...", "headline": "...", "link": "https://...", "cta": "SHOP_NOW" }
 *     }]
 *   }]
 * }
 */
export interface LaunchSpec {
  account: string;
  campaign: CampaignSpec;
  adsets?: AdSetSpec[];
}

export interface CampaignSpec {
  name: string;
  objective: string;
  status?: string;
  daily_budget?: number | string;
  lifetime_budget?: number | string;
  bid_strategy?: string;
  spend_cap?: number | string;
  special_ad_categories?: string[];
  special_ad_category_country?: string[];
  start_time?: string;
  stop_time?: string;
  is_adset_budget_sharing_enabled?: boolean;
}

export interface AdSetSpec {
  name: string;
  status?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  bid_amount?: number | string;
  roas_goal?: number | string;
  daily_budget?: number | string;
  lifetime_budget?: number | string;
  promoted_object?: Record<string, unknown>;
  targeting: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
  destination_type?: string;
  ads?: AdSpec[];
}

export interface AdSpec {
  name: string;
  status?: string;
  creative_id?: string;
  creative?: CreativeSpec;
}

export interface CreativeSpec {
  page_id: string;
  instagram_user_id?: string;
  name?: string;
  image?: string;
  image_hash?: string;
  video?: string;
  video_id?: string;
  thumbnail_url?: string;
  message?: string;
  headline?: string;
  description?: string;
  link: string;
  cta?: string;
}

export interface PlanAction {
  action: 'create' | 'update' | 'noop';
  type: 'campaign' | 'adset' | 'ad';
  name: string;
  id?: string;
  parent?: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  body?: Record<string, string>;
}

/** Load a spec from JSON, or YAML when the optional `yaml` package is installed. */
export async function loadSpec(file: string): Promise<LaunchSpec> {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    let yaml: { parse: (s: string) => unknown };
    try {
      const mod = 'yaml';
      yaml = await import(mod) as { parse: (s: string) => unknown };
    } catch {
      throw new Error('YAML specs need the "yaml" package (npm install yaml). Or write the spec as JSON.');
    }
    return yaml.parse(text) as LaunchSpec;
  }
  try {
    return JSON.parse(text) as LaunchSpec;
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

/** Local validation of a spec: the checks Meta would reject a launch for. */
export function validateSpec(spec: LaunchSpec): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== 'object') return ['Spec must be an object.'];
  try { validateAccountId(String(spec.account || '')); } catch (err) { errors.push((err as Error).message); }
  const c = spec.campaign;
  if (!c?.name) errors.push('campaign.name is required.');
  if (!c?.objective || !DEFAULT_GOAL_BY_OBJECTIVE[c.objective]) {
    errors.push(`campaign.objective must be one of: ${Object.keys(DEFAULT_GOAL_BY_OBJECTIVE).join(', ')}`);
  }
  if (c?.bid_strategy === 'TARGET_COST') errors.push('TARGET_COST is deprecated; use COST_CAP.');
  const campaignBudget = Boolean(c?.daily_budget || c?.lifetime_budget);
  const names = new Set<string>();
  for (const [i, a] of (spec.adsets || []).entries()) {
    const where = `adsets[${i}] "${a?.name ?? ''}"`;
    if (!a?.name) errors.push(`adsets[${i}].name is required.`);
    if (names.has(a?.name)) errors.push(`${where}: ad set names must be unique (they are the idempotency key).`);
    names.add(a?.name);
    const adsetBudget = Boolean(a?.daily_budget || a?.lifetime_budget);
    if (campaignBudget && adsetBudget) errors.push(`${where}: budget is on the campaign, so ad sets can't have their own budget.`);
    if (!campaignBudget && !adsetBudget) errors.push(`${where}: needs a budget (or put one on the campaign).`);
    const geo = (a?.targeting as Record<string, unknown> | undefined)?.geo_locations as Record<string, unknown> | undefined;
    if (!geo || !Object.keys(geo).length) errors.push(`${where}: targeting.geo_locations is required.`);
    const goal = a?.optimization_goal || (c?.objective ? DEFAULT_GOAL_BY_OBJECTIVE[c.objective] : undefined);
    if (goal) {
      const { errors: bidErrors } = validateBidConfig({
        objective: c?.objective,
        optimizationGoal: goal,
        billingEvent: a.billing_event || 'IMPRESSIONS',
        bidStrategy: a.bid_strategy || c?.bid_strategy,
        bidAmount: a.bid_amount,
        roasGoal: a.roas_goal,
        promotedObject: a.promoted_object,
      });
      for (const e of bidErrors) errors.push(`${where}: ${e}`);
    }
    for (const issue of specialCategoryTargetingIssues(a?.targeting, c?.special_ad_categories || [])) errors.push(`${where}: ${issue}`);
    const adNames = new Set<string>();
    for (const [j, ad] of (a?.ads || []).entries()) {
      const adWhere = `${where} ads[${j}] "${ad?.name ?? ''}"`;
      if (!ad?.name) errors.push(`${adWhere}: name is required.`);
      if (adNames.has(ad?.name)) errors.push(`${adWhere}: ad names must be unique within an ad set.`);
      adNames.add(ad?.name);
      if (!ad?.creative_id && !ad?.creative) errors.push(`${adWhere}: needs creative_id or creative.`);
      const cr = ad?.creative;
      if (cr) {
        if (!cr.page_id) errors.push(`${adWhere}: creative.page_id is required.`);
        if (!cr.link) errors.push(`${adWhere}: creative.link is required.`);
        const media = [cr.image, cr.image_hash, cr.video, cr.video_id].filter(Boolean).length;
        if (media !== 1) errors.push(`${adWhere}: creative needs exactly one of image, image_hash, video, video_id.`);
        if ((cr.video || cr.video_id) && !cr.thumbnail_url && !cr.image_hash) {
          errors.push(`${adWhere}: video creatives need thumbnail_url (or image_hash) for the thumbnail.`);
        }
        if (cr.image && !cr.image.startsWith('http') && !fs.existsSync(cr.image)) errors.push(`${adWhere}: image file not found: ${cr.image}`);
        if (cr.video && !fs.existsSync(cr.video)) errors.push(`${adWhere}: video file not found: ${cr.video}`);
      }
    }
  }
  return errors;
}

export function campaignBody(c: CampaignSpec, activate: boolean): Record<string, string> {
  const body: Record<string, string> = {
    name: c.name,
    objective: c.objective,
    status: activate && c.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
    special_ad_categories: JSON.stringify(c.special_ad_categories || []),
  };
  if (c.daily_budget) body.daily_budget = String(c.daily_budget);
  if (c.lifetime_budget) body.lifetime_budget = String(c.lifetime_budget);
  if (c.bid_strategy) body.bid_strategy = c.bid_strategy;
  if (c.spend_cap) body.spend_cap = String(c.spend_cap);
  if (c.special_ad_category_country) body.special_ad_category_country = JSON.stringify(c.special_ad_category_country);
  if (c.start_time) body.start_time = c.start_time;
  if (c.stop_time) body.stop_time = c.stop_time;
  applyAdsetBudgetSharing(body, c.is_adset_budget_sharing_enabled);
  return body;
}

export function adsetBody(a: AdSetSpec, objective: string, activate: boolean): Record<string, string> {
  const body: Record<string, string> = {
    name: a.name,
    status: activate && a.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
    optimization_goal: a.optimization_goal || DEFAULT_GOAL_BY_OBJECTIVE[objective],
    billing_event: a.billing_event || 'IMPRESSIONS',
    targeting: JSON.stringify(a.targeting),
  };
  if (a.bid_strategy) body.bid_strategy = a.bid_strategy;
  if (a.bid_amount) body.bid_amount = String(a.bid_amount);
  if (a.roas_goal !== undefined) {
    body.bid_strategy = a.bid_strategy || 'LOWEST_COST_WITH_MIN_ROAS';
    body.bid_constraints = JSON.stringify({ roas_average_floor: roasFloor(a.roas_goal) });
  }
  if (a.daily_budget) body.daily_budget = String(a.daily_budget);
  if (a.lifetime_budget) body.lifetime_budget = String(a.lifetime_budget);
  if (a.promoted_object) body.promoted_object = JSON.stringify(a.promoted_object);
  if (a.start_time) body.start_time = a.start_time;
  if (a.end_time) body.end_time = a.end_time;
  if (a.destination_type) body.destination_type = a.destination_type;
  return body;
}

/** Fields compared to decide whether an existing object needs an update. */
const CAMPAIGN_DIFF_FIELDS = ['daily_budget', 'lifetime_budget', 'bid_strategy', 'spend_cap', 'status', 'stop_time'];
const ADSET_DIFF_FIELDS = ['daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount', 'bid_constraints', 'targeting', 'end_time', 'status'];

function normalize(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (field === 'targeting' || field === 'bid_constraints') {
    const obj = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.stringify(sortKeys(obj));
  }
  if (field.endsWith('_time')) {
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? String(ms) : String(value);
  }
  return String(value);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * True when every key the spec sets in `desired` has the same value in
 * `live`. Meta adds its own keys to targeting (e.g. location_types,
 * targeting_automation), so live may be a superset. Arrays must match.
 */
export function isSubsetOf(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || desired.length !== live.length) return false;
    return desired.every((d, i) => isSubsetOf(d, live[i]));
  }
  if (desired && typeof desired === 'object') {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return false;
    return Object.entries(desired as Record<string, unknown>)
      .every(([k, v]) => isSubsetOf(v, (live as Record<string, unknown>)[k]));
  }
  // Meta returns numbers as strings in some places (and vice versa).
  return String(desired) === String(live);
}

function parseMaybeJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Fields in `desired` that differ from `live`, ignoring fields the spec doesn't set. */
export function diffFields(desired: Record<string, string>, live: Record<string, unknown>, fields: string[]): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (desired[f] === undefined) continue;
    // Never pause a live object just because the spec says PAUSED by default.
    if (f === 'status' && desired[f] === 'PAUSED') continue;
    if ((f === 'targeting' || f === 'bid_constraints') && live[f] !== undefined && live[f] !== null) {
      try {
        if (!isSubsetOf(sortKeys(parseMaybeJson(desired[f])), sortKeys(parseMaybeJson(live[f])))) {
          changes[f] = { from: live[f], to: desired[f] };
        }
        continue;
      } catch {
        // fall through to the plain comparison
      }
    }
    let a: string | undefined;
    let b: string | undefined;
    try {
      a = normalize(f, desired[f]);
      b = normalize(f, live[f]);
    } catch {
      a = String(desired[f]);
      b = String(live[f]);
    }
    if (a !== b) changes[f] = { from: live[f] ?? null, to: desired[f] };
  }
  return changes;
}

async function findByName(client: MetaClient, edge: string, name: string, fields: string): Promise<Record<string, unknown> | undefined> {
  if (client.isDryRun()) return undefined;
  const res = await client.requestAllPages(edge, {
    params: {
      fields,
      filtering: JSON.stringify([{ field: 'name', operator: 'EQUAL', value: name }]),
      limit: '50',
    },
  });
  const matches = (((res.data as Record<string, unknown>).data as Array<Record<string, unknown>>) || [])
    .filter(o => o.name === name && o.effective_status !== 'DELETED' && o.status !== 'DELETED');
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} objects named "${name}" under ${edge}; names must be unique for plan/apply.`);
  }
  return matches[0];
}

/** Compare the spec with live state and list what apply would do. */
export async function buildPlan(client: MetaClient, spec: LaunchSpec, activate = false): Promise<PlanAction[]> {
  const account = validateAccountId(spec.account);
  const actions: PlanAction[] = [];
  const cBody = campaignBody(spec.campaign, activate);
  const liveCampaign = await findByName(client, `${account}/campaigns`, spec.campaign.name, `id,name,status,effective_status,${CAMPAIGN_DIFF_FIELDS.join(',')}`);
  if (liveCampaign) {
    const changes = diffFields(cBody, liveCampaign, CAMPAIGN_DIFF_FIELDS);
    actions.push({ action: Object.keys(changes).length ? 'update' : 'noop', type: 'campaign', name: spec.campaign.name, id: String(liveCampaign.id), changes });
  } else {
    actions.push({ action: 'create', type: 'campaign', name: spec.campaign.name, body: cBody });
  }

  for (const a of spec.adsets || []) {
    const aBody = adsetBody(a, spec.campaign.objective, activate);
    const liveAdset = liveCampaign
      ? await findByName(client, `${liveCampaign.id}/adsets`, a.name, `id,name,status,effective_status,${ADSET_DIFF_FIELDS.join(',')}`)
      : undefined;
    if (liveAdset) {
      const changes = diffFields(aBody, liveAdset, ADSET_DIFF_FIELDS);
      actions.push({ action: Object.keys(changes).length ? 'update' : 'noop', type: 'adset', name: a.name, id: String(liveAdset.id), parent: spec.campaign.name, changes });
    } else {
      actions.push({ action: 'create', type: 'adset', name: a.name, parent: spec.campaign.name, body: aBody });
    }
    for (const ad of a.ads || []) {
      const liveAd = liveAdset ? await findByName(client, `${liveAdset.id}/ads`, ad.name, 'id,name,status,effective_status') : undefined;
      actions.push(liveAd
        ? { action: 'noop', type: 'ad', name: ad.name, id: String(liveAd.id), parent: a.name }
        : { action: 'create', type: 'ad', name: ad.name, parent: a.name });
    }
  }
  return actions;
}

async function uploadImage(client: MetaClient, account: string, file: string): Promise<string> {
  const bytes = fs.readFileSync(file).toString('base64');
  const res = await client.request(`${account}/adimages`, { method: 'POST', body: { bytes, name: path.basename(file) } });
  const images = (res.data as { images?: Record<string, { hash?: string }> }).images;
  const hash = images ? Object.values(images)[0]?.hash : undefined;
  if (hash) return hash;
  if (client.isPreviewMode()) return `${PLACEHOLDER_PREFIX}image_hash`;
  throw new Error(`Image upload for ${file} returned no hash.`);
}

async function uploadVideo(client: MetaClient, account: string, file: string): Promise<string> {
  const res = await client.uploadFile(`${account}/advideos`, file);
  const id = (res.data as { id?: string }).id;
  // Nothing was uploaded in preview modes, so there is nothing to poll.
  if (client.isPreviewMode() || isPlaceholderId(id)) return id || `${PLACEHOLDER_PREFIX}video_id`;
  if (!id) throw new Error(`Video upload for ${file} returned no id.`);
  const deadline = Date.now() + 600_000;
  for (;;) {
    const status = ((await client.request(id, { params: { fields: 'status' } })).data as Record<string, Record<string, string>>).status?.video_status;
    if (status === 'ready') return id;
    if (status === 'error') throw new Error(`Video ${id} failed processing.`);
    if (Date.now() > deadline) throw new Error(`Video ${id} still processing after 10 minutes.`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

/** Build object_story_spec for a creative spec, uploading local media first. */
export async function creativeBody(client: MetaClient, account: string, cr: CreativeSpec, adName: string): Promise<Record<string, string>> {
  const cta = cr.cta ? { type: cr.cta, value: { link: cr.link } } : undefined;
  const story: Record<string, unknown> = { page_id: cr.page_id };
  if (cr.instagram_user_id) story.instagram_user_id = cr.instagram_user_id;
  if (cr.video || cr.video_id) {
    const videoId = cr.video_id || await uploadVideo(client, account, cr.video!);
    story.video_data = {
      video_id: videoId,
      ...(cr.image_hash ? { image_hash: cr.image_hash } : { image_url: cr.thumbnail_url }),
      ...(cr.message ? { message: cr.message } : {}),
      ...(cr.headline ? { title: cr.headline } : {}),
      ...(cr.description ? { link_description: cr.description } : {}),
      call_to_action: cta || { type: 'LEARN_MORE', value: { link: cr.link } },
    };
  } else {
    let imageHash = cr.image_hash;
    let picture: string | undefined;
    if (cr.image?.startsWith('http')) picture = cr.image;
    else if (cr.image) imageHash = await uploadImage(client, account, cr.image);
    story.link_data = {
      link: cr.link,
      ...(imageHash ? { image_hash: imageHash } : {}),
      ...(picture ? { picture } : {}),
      ...(cr.message ? { message: cr.message } : {}),
      ...(cr.headline ? { name: cr.headline } : {}),
      ...(cr.description ? { description: cr.description } : {}),
      ...(cta ? { call_to_action: cta } : {}),
    };
  }
  return { name: cr.name || `${adName} creative`, object_story_spec: JSON.stringify(story) };
}

function idOf(data: unknown): string | undefined {
  return (data as { id?: string })?.id;
}

/**
 * Id of an object apply just created. In preview modes a placeholder stands
 * in (dry-run responses have none); otherwise a missing id is an error, so a
 * child is never sent with a made-up parent id.
 */
export function stepId(client: MetaClient, data: unknown, label: string): string {
  const id = idOf(data);
  if (id) return id;
  if (client.isPreviewMode()) return `${PLACEHOLDER_PREFIX}${label.replace(/\W+/g, '_')}`;
  throw new Error(`Creating the ${label} returned no id.`);
}

/** Under --validate, children of objects that were only validated can't be checked. */
function skippedChild(client: MetaClient, parentId: string | undefined): boolean {
  return client.isValidateMode() && (!parentId || isPlaceholderId(parentId));
}

const VALIDATE_SKIP = 'Not validated: it depends on an object that was only validated, not created.';

export function registerPlanCommands(program: Command, getClient: () => MetaClient): void {
  program
    .command('plan <spec>')
    .description('Validate a launch spec (JSON, or YAML with the yaml package) and show what apply would create or change')
    .option('--activate', 'Plan with status ACTIVE where the spec asks for it (otherwise everything is PAUSED)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (specFile: string, opts) => {
      const spec = await loadSpec(specFile);
      const errors = validateSpec(spec);
      if (errors.length) {
        console.log(formatOutput({ valid: false, errors }, opts.output as OutputFormat));
        process.exitCode = 1;
        return;
      }
      const actions = await buildPlan(getClient(), spec, Boolean(opts.activate));
      console.log(formatOutput({
        valid: true,
        summary: {
          create: actions.filter(a => a.action === 'create').length,
          update: actions.filter(a => a.action === 'update').length,
          unchanged: actions.filter(a => a.action === 'noop').length,
        },
        actions,
      }, opts.output as OutputFormat));
    }));

  program
    .command('apply <spec>')
    .description('Create or update a campaign, its ad sets, creatives and ads from a spec. Idempotent by name; new objects are PAUSED unless --activate')
    .option('--activate', 'Allow status ACTIVE where the spec sets it')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (specFile: string, opts) => {
      const client = getClient();
      const spec = await loadSpec(specFile);
      const errors = validateSpec(spec);
      if (errors.length) throw new Error(`Spec is invalid:\n- ${errors.join('\n- ')}`);
      const account = validateAccountId(spec.account);
      const activate = Boolean(opts.activate);
      const actions = await buildPlan(client, spec, activate);
      const created: Record<string, string> = {};
      const results: unknown[] = [];
      const ids = new Map<string, string>();
      for (const a of actions) if (a.id) ids.set(`${a.type}:${a.name}`, a.id);

      try {
        for (const step of actions) {
          if (step.type === 'campaign') {
            if (step.action === 'create') {
              const res = await client.request(`${account}/campaigns`, { method: 'POST', body: step.body! });
              const id = stepId(client, res.data, `campaign_${step.name}`);
              ids.set(`campaign:${step.name}`, id);
              created[`campaign "${step.name}"`] = id;
              results.push({ ...step, id, result: res.data });
            } else if (step.action === 'update') {
              const body = Object.fromEntries(Object.entries(step.changes!).map(([k, v]) => [k, String(v.to)]));
              results.push({ ...step, result: (await client.request(step.id!, { method: 'POST', body })).data });
            } else {
              results.push(step);
            }
          } else if (step.type === 'adset') {
            if (step.action === 'create') {
              const campaignId = ids.get(`campaign:${step.parent}`);
              if (skippedChild(client, campaignId)) {
                results.push({ ...step, skipped: true, reason: VALIDATE_SKIP });
                continue;
              }
              if (!campaignId) throw new Error(`No campaign id for ad set "${step.name}".`);
              const res = await client.request(`${account}/adsets`, { method: 'POST', body: { ...step.body!, campaign_id: campaignId } });
              const id = stepId(client, res.data, `adset_${step.name}`);
              ids.set(`adset:${step.name}`, id);
              created[`ad set "${step.name}"`] = id;
              results.push({ ...step, id, result: res.data });
            } else if (step.action === 'update') {
              const body = Object.fromEntries(Object.entries(step.changes!).map(([k, v]) => [k, String(v.to)]));
              results.push({ ...step, result: (await client.request(step.id!, { method: 'POST', body })).data });
            } else {
              results.push(step);
            }
          } else if (step.action === 'create') {
            const adset = (spec.adsets || []).find(a => a.name === step.parent)!;
            const ad = (adset.ads || []).find(x => x.name === step.name)!;
            const adsetId = ids.get(`adset:${step.parent}`);
            let creativeId = ad.creative_id;
            if (!creativeId) {
              const body = await creativeBody(client, account, ad.creative!, ad.name);
              if (client.isValidateMode() && body.object_story_spec.includes(PLACEHOLDER_PREFIX)) {
                // The media upload was only validated, so the creative can't be checked.
                results.push({ ...step, skipped: true, reason: 'Not validated: its image or video was not uploaded.' });
                continue;
              }
              const res = await client.request(`${account}/adcreatives`, { method: 'POST', body });
              creativeId = stepId(client, res.data, `creative_${ad.name}`);
              created[`creative for "${ad.name}"`] = creativeId;
            }
            if (skippedChild(client, adsetId) || (client.isValidateMode() && isPlaceholderId(creativeId))) {
              results.push({ ...step, creative_id: creativeId, skipped: true, reason: VALIDATE_SKIP });
              continue;
            }
            if (!adsetId) throw new Error(`No ad set id for ad "${ad.name}".`);
            const res = await client.request(`${account}/ads`, {
              method: 'POST',
              body: {
                name: ad.name,
                adset_id: adsetId,
                creative: JSON.stringify({ creative_id: creativeId }),
                status: activate && ad.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
              },
            });
            const id = stepId(client, res.data, `ad_${ad.name}`);
            created[`ad "${ad.name}"`] = id;
            results.push({ ...step, id, creative_id: creativeId, result: res.data });
          } else {
            results.push(step);
          }
        }
      } catch (err) {
        const message = (err as Error).message || String(err);
        const list = Object.entries(created).map(([k, v]) => `${k}=${v}`).join(', ');
        throw new Error(list
          ? `${message}\nCreated before the failure: ${list}. Fix the spec and re-run apply; existing objects are matched by name and won't be duplicated.`
          : message);
      }

      console.log(formatOutput({
        applied: true,
        created,
        steps: results,
        note: activate ? undefined : 'New objects were created PAUSED. Re-run with --activate (and status: ACTIVE in the spec) to go live.',
      }, opts.output as OutputFormat));
    }));
}
