import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
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
      if (opts.childAttachments) linkData.child_attachments = JSON.parse(opts.childAttachments);
      if (opts.multiShareOptimized) linkData.multi_share_optimized = true;

      const objectStorySpec: Record<string, unknown> = { link_data: linkData };
      if (opts.pageId) objectStorySpec.page_id = opts.pageId;
      if (opts.instagramActorId) objectStorySpec.instagram_user_id = opts.instagramActorId;

      body.object_story_spec = JSON.stringify(objectStorySpec);

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
    .description('Update a creative (name or object_story_spec fields)')
    .option('--name <name>', 'New creative name')
    .option('--caption <text>', 'Link caption (display URL)')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline')
    .option('--description <text>', 'Ad description')
    .option('--link-url <url>', 'Destination URL')
    .option('--cta <type>', 'Call to action type (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;

      // Build object_story_spec update if any link_data fields are provided
      const hasStoryUpdate = opts.caption || opts.message || opts.headline
        || opts.description || opts.linkUrl || opts.cta;

      if (hasStoryUpdate) {
        // Fetch current creative to merge updates
        const current = await client.request(creativeId, {
          params: { fields: 'object_story_spec' },
        });
        const currentSpec = (current.data as Record<string, unknown>).object_story_spec as Record<string, unknown> || {};
        const currentLinkData = (currentSpec.link_data || {}) as Record<string, unknown>;

        const linkData: Record<string, unknown> = { ...currentLinkData };
        if (opts.caption) linkData.caption = opts.caption;
        if (opts.message) linkData.message = opts.message;
        if (opts.headline) linkData.name = opts.headline;
        if (opts.description) linkData.description = opts.description;
        if (opts.linkUrl) linkData.link = opts.linkUrl;
        if (opts.cta) linkData.call_to_action = { type: opts.cta };

        body.object_story_spec = JSON.stringify({
          ...currentSpec,
          link_data: linkData,
        });
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
    .option('--name <name>', 'Image name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      if (!opts.url) {
        throw new Error('Image URL required. Use --url');
      }
      const client = getClient();
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
        const response = await client.uploadFile(`${opts.accountId}/advideos`, opts.file);
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
          const imgResponse = await fetch(String(imageUrl));
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
}
