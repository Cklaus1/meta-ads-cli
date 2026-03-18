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
    .option('--link-url <url>', 'Destination URL')
    .option('--message <text>', 'Ad body text')
    .option('--headline <text>', 'Ad headline')
    .option('--description <text>', 'Ad description')
    .option('--cta <type>', 'Call to action type (LEARN_MORE, SHOP_NOW, SIGN_UP, etc.)')
    .option('--instagram-actor-id <id>', 'Instagram account ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;

      // Build object_story_spec
      const linkData: Record<string, unknown> = {
        image_hash: opts.imageHash,
      };
      if (opts.linkUrl) linkData.link = opts.linkUrl;
      if (opts.message) linkData.message = opts.message;
      if (opts.headline) linkData.name = opts.headline;
      if (opts.description) linkData.description = opts.description;
      if (opts.cta) {
        linkData.call_to_action = { type: opts.cta };
      }

      const objectStorySpec: Record<string, unknown> = {
        link_data: linkData,
      };
      if (opts.pageId) objectStorySpec.page_id = opts.pageId;
      if (opts.instagramActorId) objectStorySpec.instagram_actor_id = opts.instagramActorId;

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
    .option('--message <text>', 'Ad body text')
    .option('--link-url <url>', 'Destination URL')
    .option('--cta <type>', 'Call to action type', 'LEARN_MORE')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;

      const videoData: Record<string, unknown> = {
        video_id: opts.videoId,
        message: opts.message || '',
        call_to_action: {
          type: opts.cta,
          value: opts.linkUrl ? { link: opts.linkUrl } : undefined,
        },
      };

      body.object_story_spec = JSON.stringify({
        page_id: opts.pageId,
        video_data: videoData,
      });

      const response = await client.request(`${opts.accountId}/adcreatives`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  creatives
    .command('update <creativeId>')
    .description('Update a creative')
    .option('--name <name>', 'New creative name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (creativeId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
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
