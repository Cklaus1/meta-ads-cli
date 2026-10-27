import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export interface StoryUpdate {
  caption?: string;
  message?: string;
  headline?: string;
  description?: string;
  linkUrl?: string;
  cta?: string;
}

/**
 * Merge text/link/CTA changes into an existing creative's spec, returning the
 * body fields for a new creative. Handles link ads (link_data), video ads
 * (video_data), photo posts (photo_data), catalog ads (template_data) and
 * dynamic creative (asset_feed_spec, where each change replaces that asset list).
 */
export function mergeStoryUpdate(current: Record<string, unknown>, upd: StoryUpdate): Record<string, string> {
  const spec = { ...((current.object_story_spec as Record<string, unknown>) || {}) };
  const out: Record<string, string> = {};

  const feed = current.asset_feed_spec as Record<string, unknown> | undefined;
  if (feed) {
    const next: Record<string, unknown> = { ...feed };
    if (upd.message) next.bodies = [{ text: upd.message }];
    if (upd.headline) next.titles = [{ text: upd.headline }];
    if (upd.description) next.descriptions = [{ text: upd.description }];
    if (upd.linkUrl || upd.caption) {
      const prev = ((feed.link_urls as Record<string, unknown>[]) || [])[0] || {};
      next.link_urls = [{
        ...prev,
        ...(upd.linkUrl ? { website_url: upd.linkUrl } : {}),
        ...(upd.caption ? { display_url: upd.caption } : {}),
      }];
    }
    if (upd.cta) next.call_to_action_types = [upd.cta];
    out.asset_feed_spec = JSON.stringify(next);
    if (Object.keys(spec).length) out.object_story_spec = JSON.stringify(spec);
    return out;
  }

  if (spec.video_data) {
    const video: Record<string, unknown> = { ...(spec.video_data as Record<string, unknown>) };
    if (upd.message) video.message = upd.message;
    if (upd.headline) video.title = upd.headline;
    if (upd.description) video.link_description = upd.description;
    if (upd.caption) throw new Error('--caption is not supported for video creatives');
    if (upd.cta || upd.linkUrl) {
      const prev = (video.call_to_action || {}) as Record<string, unknown>;
      const prevValue = (prev.value || {}) as Record<string, unknown>;
      const type = upd.cta || prev.type;
      if (!type) throw new Error('Video creatives need a call to action for a link. Pass --cta too.');
      video.call_to_action = { type, value: { ...prevValue, ...(upd.linkUrl ? { link: upd.linkUrl } : {}) } };
    }
    spec.video_data = video;
  } else if (spec.photo_data) {
    if (upd.headline || upd.description || upd.linkUrl || upd.cta) {
      throw new Error('Photo post creatives only support --message (and --caption)');
    }
    const photo: Record<string, unknown> = { ...(spec.photo_data as Record<string, unknown>) };
    if (upd.message || upd.caption) photo.caption = upd.message || upd.caption;
    spec.photo_data = photo;
  } else {
    // link_data, or template_data for catalog ads (same field names).
    const key = spec.template_data ? 'template_data' : 'link_data';
    const link: Record<string, unknown> = { ...((spec[key] as Record<string, unknown>) || {}) };
    if (upd.caption) link.caption = upd.caption;
    if (upd.message) link.message = upd.message;
    if (upd.headline) link.name = upd.headline;
    if (upd.description) link.description = upd.description;
    if (upd.linkUrl) link.link = upd.linkUrl;
    if (upd.cta) {
      const prev = (link.call_to_action || {}) as Record<string, unknown>;
      link.call_to_action = { ...prev, type: upd.cta };
    }
    spec[key] = link;
  }
  out.object_story_spec = JSON.stringify(spec);
  return out;
}

/**
 * Since v26.0, eligible creatives default to destination_type WEBSITE_AND_SHOP
 * when the advertiser has a shop; WEBSITE_AND_SHOP_OPT_OUT keeps them website-only.
 */
export function applyShopDestination(body: Record<string, string>, mode: string | undefined): void {
  if (mode === undefined || mode === 'default') return;
  if (mode !== 'opt-out') throw new Error(`--shop-destination must be "default" or "opt-out", got: "${mode}"`);
  body.destination_spec = JSON.stringify({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' });
}

/**
 * Advantage+ creative features that can be opted in or out one by one under
 * degrees_of_freedom_spec.creative_features_spec. From the AdCreativeFeaturesSpec
 * reference (checked 2026-10-27). The standard_enhancements bundle was retired
 * in v22, so it is rejected here.
 */
export const CREATIVE_FEATURES = [
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'biz_ai', 'creative_stickers',
  'customize_product_recommendation', 'description_automation', 'fb_feed_tag', 'fb_reels_tag', 'fb_story_tag',
  'generate_cta', 'hide_price', 'ig_feed_tag', 'ig_reels_tag', 'ig_stream_tag', 'image_animation',
  'image_background_gen', 'image_templates', 'image_touchups', 'inline_comment', 'local_store_extension',
  'media_order', 'media_type_automation', 'multi_photo_to_video', 'music_generation', 'pac_relaxation',
  'product_extensions', 'profile_card', 'profile_extension', 'replace_media_text', 'reveal_details_over_time',
  'show_destination_blurbs', 'show_summary', 'site_extensions', 'standard_enhancements_catalog',
  'text_extraction_for_headline', 'text_extraction_for_tap_target', 'text_optimizations',
  'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_highlights', 'video_to_image',
  'wa_mm_image_filtering', 'wa_mm_text_truncation_length',
];

function splitList(value: unknown): string[] {
  return String(value ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

/**
 * Build degrees_of_freedom_spec from --enhancements (opt in) and
 * --disable-enhancements (opt out). Returns undefined when neither is given,
 * leaving Meta's defaults in place.
 */
export function buildDegreesOfFreedom(optIn?: string, optOut?: string): string | undefined {
  const spec: Record<string, { enroll_status: string }> = {};
  const add = (names: string[], status: string) => {
    for (const name of names) {
      if (name === 'standard_enhancements') {
        throw new Error('standard_enhancements was retired in Marketing API v22. Opt in or out of individual features instead (e.g. image_touchups,text_optimizations).');
      }
      if (!CREATIVE_FEATURES.includes(name)) {
        console.error(`Warning: "${name}" is not a known Advantage+ creative feature; sending it anyway. Known: ${CREATIVE_FEATURES.join(', ')}`);
      }
      if (spec[name] && spec[name].enroll_status !== status) {
        throw new Error(`"${name}" is in both --enhancements and --disable-enhancements`);
      }
      spec[name] = { enroll_status: status };
    }
  };
  add(splitList(optIn), 'OPT_IN');
  add(splitList(optOut), 'OPT_OUT');
  if (Object.keys(spec).length === 0) return undefined;
  return JSON.stringify({ creative_features_spec: spec });
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export interface AssetFeedOptions {
  imageHashes?: string[];
  videoIds?: string[];
  bodies?: string[];
  titles?: string[];
  descriptions?: string[];
  linkUrls?: string[];
  displayUrl?: string;
  ctas?: string[];
  adFormat?: string;
  customizationRules?: unknown;
}

const AD_FORMATS = ['SINGLE_IMAGE', 'SINGLE_VIDEO', 'CAROUSEL', 'AUTOMATIC_FORMAT'];

/**
 * Build an asset_feed_spec for Dynamic Creative / flexible format: several
 * bodies, titles, descriptions, images and videos that Meta combines per
 * placement. With customizationRules it becomes a placement asset
 * customization feed instead (Meta requires at least two rules).
 */
export function buildAssetFeedSpec(o: AssetFeedOptions): Record<string, unknown> {
  const images = o.imageHashes ?? [];
  const videos = o.videoIds ?? [];
  if (images.length === 0 && videos.length === 0) {
    throw new Error('Give at least one --image-hash or --video-id');
  }
  if (!o.linkUrls?.length) throw new Error('Give at least one --link-url');
  const adFormat = (o.adFormat || (images.length && videos.length ? 'AUTOMATIC_FORMAT' : images.length ? 'SINGLE_IMAGE' : 'SINGLE_VIDEO')).toUpperCase();
  if (!AD_FORMATS.includes(adFormat)) {
    throw new Error(`--ad-format must be one of ${AD_FORMATS.join(', ')}, got: "${o.adFormat}"`);
  }
  if (adFormat === 'SINGLE_IMAGE' && videos.length) throw new Error('SINGLE_IMAGE can\'t include videos; use AUTOMATIC_FORMAT to mix images and videos');
  if (adFormat === 'SINGLE_VIDEO' && images.length) throw new Error('SINGLE_VIDEO can\'t include images; use AUTOMATIC_FORMAT to mix images and videos');

  const spec: Record<string, unknown> = {
    ad_formats: [adFormat],
    link_urls: o.linkUrls.map(url => ({ website_url: url, ...(o.displayUrl ? { display_url: o.displayUrl } : {}) })),
  };
  if (images.length) spec.images = images.map(hash => ({ hash }));
  if (videos.length) spec.videos = videos.map(video_id => ({ video_id }));
  if (o.bodies?.length) spec.bodies = o.bodies.map(text => ({ text }));
  if (o.titles?.length) spec.titles = o.titles.map(text => ({ text }));
  if (o.descriptions?.length) spec.descriptions = o.descriptions.map(text => ({ text }));
  if (o.ctas?.length) spec.call_to_action_types = o.ctas.map(c => c.toUpperCase());
  if (o.customizationRules !== undefined) {
    if (!Array.isArray(o.customizationRules) || o.customizationRules.length < 2) {
      throw new Error('--customization-rules must be a JSON array with at least two rules (Meta requires two or more for placement asset customization)');
    }
    spec.asset_customization_rules = o.customizationRules;
  }
  return spec;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);

/** Upload a local image via the base64 `bytes` param and return its hash. */
async function uploadImageFile(client: MetaClient, accountId: string, file: string): Promise<{ hash?: string; data: unknown }> {
  const fs = await import('fs');
  const path = await import('path');
  const bytes = fs.readFileSync(file).toString('base64');
  const response = await client.request(`${accountId}/adimages`, {
    method: 'POST',
    body: { bytes, name: path.basename(file) },
  });
  // Response shape: { images: { "<filename>": { hash, url } } }
  const images = (response.data as { images?: Record<string, { hash?: string }> }).images;
  const hash = images ? Object.values(images)[0]?.hash : undefined;
  return { hash, data: response.data };
}

/** Poll a video until Meta finishes processing it. */
export async function waitForVideo(client: MetaClient, videoId: string, timeoutMs = 600_000, intervalMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.request(videoId, { params: { fields: 'id,status' } });
    const data = response.data as Record<string, unknown>;
    const status = (data.status as Record<string, unknown> | undefined)?.video_status;
    if (data.dryRun || status === 'ready') return data;
    if (status === 'error') throw new Error(`Video ${videoId} failed processing: ${JSON.stringify(data.status)}`);
    if (Date.now() >= deadline) throw new Error(`Video ${videoId} still processing after ${Math.round(timeoutMs / 1000)}s`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function registerCreativeExtras(creatives: Command, getClient: () => MetaClient): void {
  creatives
    .command('create-dynamic')
    .description('Create a Dynamic Creative / flexible format creative from several bodies, titles, images and videos (asset_feed_spec). Use it in an ad set created with is_dynamic_creative=true for Dynamic Creative')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .option('--name <name>', 'Creative name')
    .option('--instagram-actor-id <id>', 'Instagram account ID')
    .option('--image-hash <hash>', 'Image hash (repeatable)', collect)
    .option('--video-id <id>', 'Video ID (repeatable)', collect)
    .option('--body <text>', 'Primary text variation (repeatable)', collect)
    .option('--title <text>', 'Headline variation (repeatable)', collect)
    .option('--description <text>', 'Description variation (repeatable)', collect)
    .option('--link-url <url>', 'Destination URL (repeatable)', collect)
    .option('--display-url <url>', 'Display URL shown on the ad')
    .option('--cta <type>', 'Call to action type (repeatable), e.g. SHOP_NOW', collect)
    .option('--ad-format <format>', 'SINGLE_IMAGE, SINGLE_VIDEO, CAROUSEL or AUTOMATIC_FORMAT (default: from the media given)')
    .option('--customization-rules <json>', 'asset_customization_rules for placement asset customization (JSON, @file or -)')
    .option('--asset-feed-spec <json>', 'Full asset_feed_spec to send as-is instead of the flags above (JSON, @file or -)')
    .option('--enhancements <features>', 'Advantage+ creative features to opt in (comma-separated)')
    .option('--disable-enhancements <features>', 'Advantage+ creative features to opt out (comma-separated)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const feed = opts.assetFeedSpec
        ? parseJsonInput<Record<string, unknown>>(opts.assetFeedSpec, '--asset-feed-spec')
        : buildAssetFeedSpec({
          imageHashes: opts.imageHash,
          videoIds: opts.videoId,
          bodies: opts.body,
          titles: opts.title,
          descriptions: opts.description,
          linkUrls: opts.linkUrl,
          displayUrl: opts.displayUrl,
          ctas: opts.cta,
          adFormat: opts.adFormat,
          customizationRules: opts.customizationRules ? parseJsonInput(opts.customizationRules, '--customization-rules') : undefined,
        });
      const storySpec: Record<string, unknown> = { page_id: opts.pageId };
      if (opts.instagramActorId) storySpec.instagram_user_id = opts.instagramActorId;
      const body: Record<string, string> = {
        object_story_spec: JSON.stringify(storySpec),
        asset_feed_spec: JSON.stringify(feed),
      };
      if (opts.name) body.name = opts.name;
      const dof = buildDegreesOfFreedom(opts.enhancements, opts.disableEnhancements);
      if (dof) body.degrees_of_freedom_spec = dof;

      const response = await getClient().request(`${opts.accountId}/adcreatives`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('create-from-post')
    .description('Create a creative from an existing Facebook Page post or Instagram post, keeping its likes and comments')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--post-id <id>', 'Facebook Page post ID (<pageId>_<postId>), sent as object_story_id')
    .option('--instagram-media-id <id>', 'Instagram media ID, sent as source_instagram_media_id')
    .option('--instagram-user-id <id>', 'Instagram account that owns the media (needed with --instagram-media-id)')
    .option('--name <name>', 'Creative name')
    .option('--enhancements <features>', 'Advantage+ creative features to opt in (comma-separated)')
    .option('--disable-enhancements <features>', 'Advantage+ creative features to opt out (comma-separated)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      if (!!opts.postId === !!opts.instagramMediaId) {
        throw new Error('Give exactly one of --post-id or --instagram-media-id');
      }
      const body: Record<string, string> = {};
      if (opts.postId) {
        if (!/^\d+_\d+$/.test(opts.postId)) throw new Error(`--post-id must look like <pageId>_<postId>, got: "${opts.postId}"`);
        body.object_story_id = opts.postId;
      } else {
        if (!opts.instagramUserId) throw new Error('--instagram-user-id is required with --instagram-media-id');
        body.source_instagram_media_id = opts.instagramMediaId;
        body.instagram_user_id = opts.instagramUserId;
      }
      if (opts.name) body.name = opts.name;
      const dof = buildDegreesOfFreedom(opts.enhancements, opts.disableEnhancements);
      if (dof) body.degrees_of_freedom_spec = dof;
      const response = await getClient().request(`${opts.accountId}/adcreatives`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('preview <id>')
    .description('Render ad previews (HTML iframes) of a creative or ad for one or more placements')
    .option('--format <formats>', 'Comma-separated ad_format values, e.g. MOBILE_FEED_STANDARD,DESKTOP_FEED_STANDARD,INSTAGRAM_STANDARD,INSTAGRAM_STORY,INSTAGRAM_REELS', 'MOBILE_FEED_STANDARD')
    .option('--spec <json>', 'Preview an unsaved creative spec instead (JSON, @file or -); <id> is then the ad account ID')
    .option('--save-html <dir>', 'Also write each preview to <dir>/<id>-<format>.html')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (id: string, opts) => {
      const client = getClient();
      const formats = splitList(opts.format).map(f => f.toUpperCase());
      if (formats.length === 0) throw new Error('--format needs at least one ad_format');
      // Parse once: a stdin spec ('-') can only be read a single time.
      const spec = opts.spec ? JSON.stringify(parseJsonInput(opts.spec, '--spec')) : undefined;
      const previews: Array<{ format: string; body?: string }> = [];
      for (const format of formats) {
        const response = spec
          ? await client.request(`${id}/generatepreviews`, {
            params: { ad_format: format, creative: spec },
          })
          : await client.request(`${id}/previews`, { params: { ad_format: format } });
        const first = ((response.data as { data?: Array<{ body?: string }> }).data || [])[0];
        previews.push({ format, body: first?.body });
      }
      if (opts.saveHtml) {
        const fs = await import('fs');
        const path = await import('path');
        fs.mkdirSync(opts.saveHtml, { recursive: true });
        for (const p of previews) {
          if (p.body) fs.writeFileSync(path.join(opts.saveHtml, `${id}-${p.format}.html`), p.body);
        }
      }
      console.log(formatOutput(previews, opts.output as OutputFormat));
    }));

  creatives
    .command('images')
    .description('List images in the account\'s asset library')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum number of images', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const client = getClient();
      const params = { fields: 'id,hash,name,url,permalink_url,width,height,status,created_time', limit: opts.limit };
      const endpoint = `${opts.accountId}/adimages`;
      const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('videos')
    .description('List videos in the account\'s asset library, with processing status')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum number of videos', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const client = getClient();
      const params = { fields: 'id,title,length,status,picture,created_time', limit: opts.limit };
      const endpoint = `${opts.accountId}/advideos`;
      const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('video-status <videoId>')
    .description('Show a video\'s processing status (ready, processing, error)')
    .option('--wait', 'Poll until processing finishes')
    .option('--timeout <seconds>', 'Max wait with --wait', '600')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (videoId: string, opts) => {
      const client = getClient();
      const data = opts.wait
        ? await waitForVideo(client, videoId, Number(opts.timeout) * 1000)
        : (await client.request(videoId, { params: { fields: 'id,status' } })).data;
      console.log(formatOutput(data, opts.output as OutputFormat));
    }));

  creatives
    .command('bulk-create')
    .description('Upload every image and video in a folder and create one creative per file')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--folder <dir>', 'Folder of images (.jpg .png .gif .webp ...) and videos (.mp4 .mov ...)')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .requiredOption('--link-url <url>', 'Destination URL')
    .option('--instagram-actor-id <id>', 'Instagram account ID')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline')
    .option('--description <text>', 'Ad description')
    .option('--cta <type>', 'Call to action type', 'LEARN_MORE')
    .option('--name-prefix <prefix>', 'Creative name prefix (file name is appended)', '')
    .option('--enhancements <features>', 'Advantage+ creative features to opt in (comma-separated)')
    .option('--disable-enhancements <features>', 'Advantage+ creative features to opt out (comma-separated)')
    .option('--video-timeout <seconds>', 'Max wait per video for processing', '600')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const fs = await import('fs');
      const path = await import('path');
      const client = getClient();
      const dof = buildDegreesOfFreedom(opts.enhancements, opts.disableEnhancements);
      const files = fs.readdirSync(opts.folder)
        .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()) || VIDEO_EXTS.has(path.extname(f).toLowerCase()))
        .sort();
      if (files.length === 0) throw new Error(`No image or video files found in ${opts.folder}`);

      const created: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];
      for (const file of files) {
        const full = path.join(opts.folder, file);
        const isVideo = VIDEO_EXTS.has(path.extname(file).toLowerCase());
        try {
          const storySpec: Record<string, unknown> = { page_id: opts.pageId };
          if (opts.instagramActorId) storySpec.instagram_user_id = opts.instagramActorId;
          if (isVideo) {
            const upload = await client.uploadFile(`${opts.accountId}/advideos`, full, { title: file });
            const videoId = (upload.data as { id?: string }).id || '<video-id>';
            await waitForVideo(client, videoId, Number(opts.videoTimeout) * 1000);
            // A video creative needs a thumbnail; use Meta's preferred one.
            const thumbs = client.isDryRun() ? undefined
              : (await client.request(`${videoId}/thumbnails`, { params: { fields: 'uri,is_preferred' } })).data as { data?: Array<{ uri: string; is_preferred?: boolean }> };
            const thumb = thumbs?.data?.find(t => t.is_preferred) || thumbs?.data?.[0];
            storySpec.video_data = {
              video_id: videoId,
              ...(thumb ? { image_url: thumb.uri } : {}),
              ...(opts.message ? { message: opts.message } : {}),
              ...(opts.headline ? { title: opts.headline } : {}),
              ...(opts.description ? { link_description: opts.description } : {}),
              call_to_action: { type: opts.cta, value: { link: opts.linkUrl } },
            };
          } else {
            const { hash } = await uploadImageFile(client, opts.accountId, full);
            storySpec.link_data = {
              image_hash: hash || '<image-hash>',
              link: opts.linkUrl,
              ...(opts.message ? { message: opts.message } : {}),
              ...(opts.headline ? { name: opts.headline } : {}),
              ...(opts.description ? { description: opts.description } : {}),
              call_to_action: { type: opts.cta },
            };
          }
          const body: Record<string, string> = {
            name: `${opts.namePrefix}${file}`,
            object_story_spec: JSON.stringify(storySpec),
          };
          if (dof) body.degrees_of_freedom_spec = dof;
          const response = await client.request(`${opts.accountId}/adcreatives`, { method: 'POST', body });
          created.push({ file, type: isVideo ? 'video' : 'image', creative_id: (response.data as { id?: string }).id });
        } catch (err) {
          failed.push({ file, error: (err as Error).message });
        }
      }
      console.log(formatOutput({ created, failed, total: files.length }, opts.output as OutputFormat));
      if (failed.length) process.exitCode = 1;
    }));
}

export function registerCreativeCommands(program: Command, getClient: () => MetaClient): void {
  const creatives = program.command('creatives').description('Ad creative management');

  creatives
    .command('list')
    .description('List ad creatives for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum number of creatives', '10')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,status,thumbnail_url,image_url,object_story_spec,asset_feed_spec',
        limit: opts.limit,
      };

      const endpoint = `${opts.accountId}/adcreatives`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('get <creativeId>')
    .description('Get detailed info for a specific creative')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,status,thumbnail_url,image_url,image_hash,object_story_spec,asset_feed_spec,call_to_action_type,effective_object_story_id',
      };

      const response = await client.request(creativeId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('get-for-ad <adId>')
    .description('Get creatives for a specific ad')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,status,thumbnail_url,image_url,object_story_spec',
      };

      const response = await client.request(`${adId}/adcreatives`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('create-image')
    .description('Create an image ad creative')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--image-hash <hash>', 'Image hash (from upload-image)')
    .option('--name <name>', 'Creative name')
    .option('--page-id <id>', 'Facebook Page ID')
    .option('--instagram-actor-id <id>', 'Instagram account ID')
    .option('--link-url <url>', 'Destination URL')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline')
    .option('--description <text>', 'Ad description')
    .option('--caption <text>', 'Link caption (display URL)')
    .option('--cta <type>', 'Call to action type (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)')
    .option('--url-tags <tags>', 'URL tracking tags appended to link')
    .option('--child-attachments <json>', 'JSON array for carousel ads')
    .option('--multi-share-optimized', 'Optimize carousel card order')
    .option('--shop-destination <mode>', 'Shops ads destination: default (Meta sends eligible creatives to WEBSITE_AND_SHOP when you have a shop) or opt-out')
    .option('--enhancements <features>', 'Advantage+ creative features to opt in, e.g. image_touchups,text_optimizations,image_animation')
    .option('--disable-enhancements <features>', 'Advantage+ creative features to opt out (comma-separated)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.urlTags) body.url_tags = opts.urlTags;

      const linkData: Record<string, unknown> = {
        image_hash: opts.imageHash,
      };
      if (opts.linkUrl) linkData.link = opts.linkUrl;
      if (opts.message) linkData.message = opts.message;
      if (opts.headline) linkData.name = opts.headline;
      if (opts.description) linkData.description = opts.description;
      if (opts.caption) linkData.caption = opts.caption;
      if (opts.cta) linkData.call_to_action = { type: opts.cta };
      if (opts.childAttachments) linkData.child_attachments = parseJsonInput(opts.childAttachments, '--child-attachments');
      if (opts.multiShareOptimized) linkData.multi_share_optimized = true;

      const objectStorySpec: Record<string, unknown> = { link_data: linkData };
      if (opts.pageId) objectStorySpec.page_id = opts.pageId;
      if (opts.instagramActorId) objectStorySpec.instagram_user_id = opts.instagramActorId;

      body.object_story_spec = JSON.stringify(objectStorySpec);
      applyShopDestination(body, opts.shopDestination);
      const dof = buildDegreesOfFreedom(opts.enhancements, opts.disableEnhancements);
      if (dof) body.degrees_of_freedom_spec = dof;

      const response = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('create-video')
    .description('Create a video ad creative')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--video-id <id>', 'Video ID (from upload-video)')
    .requiredOption('--page-id <id>', 'Facebook Page ID')
    .option('--name <name>', 'Creative name')
    .option('--instagram-actor-id <id>', 'Instagram account ID')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline (video title)')
    .option('--description <text>', 'Ad description')
    .option('--link-url <url>', 'Destination URL')
    .option('--caption <text>', 'Link caption (display URL)')
    .option('--cta <type>', 'Call to action type', 'LEARN_MORE')
    .option('--thumbnail <hash>', 'Image hash for video thumbnail')
    .option('--url-tags <tags>', 'URL tracking tags appended to link')
    .option('--shop-destination <mode>', 'Shops ads destination: default (Meta sends eligible creatives to WEBSITE_AND_SHOP when you have a shop) or opt-out')
    .option('--enhancements <features>', 'Advantage+ creative features to opt in, e.g. image_touchups,text_optimizations,image_animation')
    .option('--disable-enhancements <features>', 'Advantage+ creative features to opt out (comma-separated)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.urlTags) body.url_tags = opts.urlTags;

      const videoData: Record<string, unknown> = {
        video_id: opts.videoId,
      };
      if (opts.message) videoData.message = opts.message;
      if (opts.headline) videoData.title = opts.headline;
      if (opts.description) videoData.link_description = opts.description;
      if (opts.thumbnail) videoData.image_hash = opts.thumbnail;
      const ctaValue: Record<string, unknown> = {};
      if (opts.linkUrl) ctaValue.link = opts.linkUrl;
      if (opts.caption) ctaValue.link_caption = opts.caption;
      videoData.call_to_action = {
        type: opts.cta,
        ...(Object.keys(ctaValue).length > 0 ? { value: ctaValue } : {}),
      };

      const objectStorySpec: Record<string, unknown> = {
        page_id: opts.pageId,
        video_data: videoData,
      };
      if (opts.instagramActorId) objectStorySpec.instagram_user_id = opts.instagramActorId;

      body.object_story_spec = JSON.stringify(objectStorySpec);
      applyShopDestination(body, opts.shopDestination);
      const dof = buildDegreesOfFreedom(opts.enhancements, opts.disableEnhancements);
      if (dof) body.degrees_of_freedom_spec = dof;

      const response = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('clone <creativeId>')
    .description('Clone an existing creative with field overrides')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--name <name>', 'New creative name')
    .option('--message <text>', 'Override ad body text')
    .option('--headline <text>', 'Override ad headline')
    .option('--description <text>', 'Override ad description')
    .option('--caption <text>', 'Override link caption (display URL)')
    .option('--link-url <url>', 'Override destination URL')
    .option('--cta <type>', 'Override call to action type')
    .option('--image-hash <hash>', 'Override image hash')
    .option('--url-tags <tags>', 'Override URL tracking tags')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();

      // Fetch the source creative
      const source = await client.request(creativeId, {
        params: { fields: 'name,object_story_spec' },
      });
      const sourceData = source.data as Record<string, unknown>;
      const sourceSpec = sourceData.object_story_spec as Record<string, unknown> || {};
      const sourceLinkData = (sourceSpec.link_data || {}) as Record<string, unknown>;
      const sourceVideoData = (sourceSpec.video_data || {}) as Record<string, unknown>;

      const body: Record<string, string> = {};
      body.name = opts.name || `${sourceData.name || 'Creative'} - copy`;
      if (opts.urlTags) body.url_tags = opts.urlTags;

      if (sourceLinkData.image_hash || sourceLinkData.link) {
        // Image creative — clone link_data with overrides
        const linkData: Record<string, unknown> = { ...sourceLinkData };
        if (opts.message) linkData.message = opts.message;
        if (opts.headline) linkData.name = opts.headline;
        if (opts.description) linkData.description = opts.description;
        if (opts.caption) linkData.caption = opts.caption;
        if (opts.linkUrl) linkData.link = opts.linkUrl;
        if (opts.imageHash) linkData.image_hash = opts.imageHash;
        if (opts.cta) linkData.call_to_action = { type: opts.cta };

        body.object_story_spec = JSON.stringify({
          ...sourceSpec,
          link_data: linkData,
        });
      } else if (sourceVideoData.video_id) {
        // Video creative — clone video_data with overrides
        const videoData: Record<string, unknown> = { ...sourceVideoData };
        if (opts.message) videoData.message = opts.message;
        if (opts.headline) videoData.title = opts.headline;
        if (opts.description) videoData.link_description = opts.description;
        if (opts.imageHash) videoData.image_hash = opts.imageHash;
        if (opts.cta || opts.linkUrl || opts.caption) {
          const existingCta = (videoData.call_to_action || {}) as Record<string, unknown>;
          const existingValue = (existingCta.value || {}) as Record<string, unknown>;
          const ctaValue: Record<string, unknown> = { ...existingValue };
          if (opts.linkUrl) ctaValue.link = opts.linkUrl;
          if (opts.caption) ctaValue.link_caption = opts.caption;
          videoData.call_to_action = {
            type: opts.cta || existingCta.type || 'LEARN_MORE',
            ...(Object.keys(ctaValue).length > 0 ? { value: ctaValue } : {}),
          };
        }

        body.object_story_spec = JSON.stringify({
          ...sourceSpec,
          video_data: videoData,
        });
      } else {
        throw new Error('Unsupported creative type. Only image and video creatives can be cloned.');
      }

      const response = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('update <creativeId>')
    .description('Update a creative. Story fields (text, link, CTA) create a new creative, since Meta creatives are immutable')
    .option('--name <name>', 'New creative name')
    .option('--caption <text>', 'Link caption (display URL)')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline')
    .option('--description <text>', 'Ad description')
    .option('--link-url <url>', 'Destination URL')
    .option('--cta <type>', 'Call to action type (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)')
    .option('--account-id <id>', 'Ad account for the new creative (defaults to the original creative\'s account)')
    .option('--ad-id <id>', 'Point this ad at the new creative')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;

      // Build object_story_spec update if any link_data fields are provided
      const hasStoryUpdate = opts.caption || opts.message || opts.headline
        || opts.description || opts.linkUrl || opts.cta;

      if (hasStoryUpdate) {
        // object_story_spec can't be edited on an existing creative, so build
        // a new creative from the merged spec.
        const current = await client.request(creativeId, {
          params: { fields: 'name,account_id,object_story_spec,asset_feed_spec' },
        });
        const currentData = current.data as Record<string, unknown>;
        Object.assign(body, mergeStoryUpdate(currentData, opts));

        const accountId = opts.accountId || (currentData.account_id ? `act_${currentData.account_id}` : '');
        if (!accountId) {
          throw new Error('Could not determine the ad account for the new creative. Use --account-id');
        }
        body.name = opts.name || String(currentData.name || `Copy of ${creativeId}`);

        const created = await client.request(`${accountId}/adcreatives`, { method: 'POST', body });
        const newId = (created.data as { id?: string }).id;
        const result: Record<string, unknown> = {
          previous_creative_id: creativeId,
          new_creative_id: newId,
          ...(created.data as Record<string, unknown>),
        };

        if (opts.adId && newId) {
          const repointed = await client.request(opts.adId, {
            method: 'POST',
            body: { creative: JSON.stringify({ creative_id: newId }) },
          });
          result.ad_id = opts.adId;
          result.ad_update = repointed.data;
        } else if (!opts.adId) {
          result.note = 'Ads still use the previous creative. Re-run with --ad-id, or: meta-ads ads update <adId> --creative-id <new id>';
        }

        console.log(formatOutput(result, opts.output as OutputFormat));
        return;
      }

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided. Use --name, --caption, --message, --headline, --description, --link-url, or --cta');
      }

      const response = await client.request(creativeId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('upload-image')
    .description('Upload an image to the ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--url <url>', 'Image URL to upload')
    .option('--file <path>', 'Local image file to upload')
    .option('--name <name>', 'Image name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      if (!opts.url === !opts.file) {
        throw new Error('Give exactly one of --url or --file');
      }
      const client = getClient();
      if (opts.file) {
        const { data } = await uploadImageFile(client, opts.accountId, opts.file);
        console.log(formatOutput(data, opts.output as OutputFormat));
        return;
      }
      const body: Record<string, string> = {
        url: opts.url,
      };
      if (opts.name) body.name = opts.name;

      const response = await client.request(`${opts.accountId}/adimages`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('upload-video')
    .description('Upload a video file or URL to the ad account')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--file <path>', 'Local video file path')
    .option('--url <url>', 'Video URL to upload')
    .option('--title <title>', 'Video title')
    .option('--description <desc>', 'Video description')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      if (!opts.file && !opts.url) {
        throw new Error('Either --file or --url is required');
      }
      const client = getClient();

      if (opts.file) {
        // Upload from local file using multipart
        const fields: Record<string, string> = {};
        if (opts.title) fields.title = opts.title;
        if (opts.description) fields.description = opts.description;
        const response = await client.uploadFile(`${opts.accountId}/advideos`, opts.file, fields);
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        // Upload from URL
        const body: Record<string, string> = {
          file_url: opts.url,
        };
        if (opts.title) body.title = opts.title;
        if (opts.description) body.description = opts.description;

        const response = await client.request(`${opts.accountId}/advideos`, {
          method: 'POST',
          body,
        });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  creatives
    .command('save-image <adId>')
    .description('Download and save an ad image locally')
    .option('--output-path <path>', 'Output file path', './ad-image.jpg')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,creative',
      };
      const adResponse = await client.request(adId, { params });
      const ad = adResponse.data as Record<string, unknown>;
      const creative = ad.creative as Record<string, unknown>;

      if (creative?.id) {
        const creativeParams: Record<string, string> = {
          fields: 'id,image_url,thumbnail_url',
        };
        const creativeResponse = await client.request(String(creative.id), { params: creativeParams });
        const creativeData = creativeResponse.data as Record<string, unknown>;
        const imageUrl = creativeData.image_url || creativeData.thumbnail_url;

        if (imageUrl) {
          const { writeFileSync } = await import('fs');
          const imgResponse = await fetch(String(imageUrl), { signal: AbortSignal.timeout(60_000) });
          if (!imgResponse.ok) {
            throw new Error(`Image download failed (${imgResponse.status} ${imgResponse.statusText}). The image URL may have expired.`);
          }
          const buffer = Buffer.from(await imgResponse.arrayBuffer());
          writeFileSync(opts.outputPath, buffer);
          console.log(formatOutput({
            ad_id: adId,
            image_url: imageUrl,
            saved_to: opts.outputPath,
            size_bytes: buffer.byteLength,
          }, opts.output as OutputFormat));
        } else {
          console.log(formatOutput({ error: 'No image URL found for this ad' }, opts.output as OutputFormat));
        }
      } else {
        console.log(formatOutput({ error: 'No creative found for this ad' }, opts.output as OutputFormat));
      }
    }));

  registerCreativeExtras(creatives, getClient);
}
