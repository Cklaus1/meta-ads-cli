import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { resolveTimeRange } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerInstagramCommands(program: Command, getClient: () => MetaClient): void {
  const instagram = program.command('instagram').alias('ig').description('Instagram Shopping and business profile management');

  instagram
    .command('sync-catalog')
    .description('Sync a product catalog to Instagram Business account')
    .requiredOption('--instagram-id <id>', 'Instagram Business account ID')
    .requiredOption('--catalog-id <id>', 'Product catalog ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      const igParams: Record<string, string> = {
        fields: 'id,username,name,followers_count,is_business_account',
      };
      const igResponse = await client.request(opts.instagramId, { params: igParams });

      const catParams: Record<string, string> = {
        fields: 'id,name,product_count,vertical',
      };
      const catResponse = await client.request(opts.catalogId, { params: catParams });

      const response = await client.request(`${opts.instagramId}/product_catalogs`, {
        method: 'POST',
        body: { catalog_id: opts.catalogId },
      });

      console.log(formatOutput({
        instagram_account: igResponse.data,
        catalog: catResponse.data,
        sync_result: response.data,
      }, opts.output as OutputFormat));
    }));

  instagram
    .command('create-shopping-ad')
    .description('Create an Instagram Shopping ad')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--product-set-id <id>', 'Product set ID')
    .requiredOption('--instagram-id <id>', 'Instagram account ID')
    .option('--name <name>', 'Ad name')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();

      const creativeBody: Record<string, string> = {
        name: opts.name ? `${opts.name} - Creative` : 'Shopping Creative',
        object_story_spec: JSON.stringify({
          instagram_actor_id: opts.instagramId,
          template_data: {
            product_set_id: opts.productSetId,
            call_to_action: { type: 'SHOP_NOW' },
          },
        }),
      };

      const creativeResponse = await client.request(`${opts.accountId}/adcreatives`, { method: 'POST', body: creativeBody });
      const creativeId = (creativeResponse.data as Record<string, unknown>).id as string;

      const adBody: Record<string, string> = {
        name: opts.name || 'Instagram Shopping Ad',
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: opts.status,
      };

      const adResponse = await client.request(`${opts.accountId}/ads`, { method: 'POST', body: adBody });

      console.log(formatOutput({
        creative: creativeResponse.data,
        ad: adResponse.data,
      }, opts.output as OutputFormat));
    }));

  instagram
    .command('profile <instagramId>')
    .description('Get/manage Instagram Business profile')
    .option('--update-bio <text>', 'Update biography')
    .option('--update-website <url>', 'Update website URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();

      if (opts.updateBio || opts.updateWebsite) {
        const body: Record<string, string> = {};
        if (opts.updateBio) body.biography = opts.updateBio;
        if (opts.updateWebsite) body.website = opts.updateWebsite;
        const response = await client.request(instagramId, { method: 'POST', body });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        const params: Record<string, string> = {
          fields: 'id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,is_business_account',
        };
        const response = await client.request(instagramId, { params });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  // ── Content Publishing ─────────────────────────────────

  instagram
    .command('publish <instagramId>')
    .description('Publish a photo or video post to Instagram')
    .option('--image-url <url>', 'Public image URL to publish')
    .option('--video-url <url>', 'Public video URL to publish (Reels)')
    .option('--caption <text>', 'Post caption')
    .option('--location-id <id>', 'Facebook Page location ID')
    .option('--user-tags <json>', 'User tags as JSON array [{username, x, y}]')
    .option('--cover-url <url>', 'Cover image URL for Reels')
    .option('--share-to-feed', 'Share Reel to feed (default: true)')
    .option('--collaborators <usernames>', 'Comma-separated collaborator usernames')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      if (!opts.imageUrl && !opts.videoUrl) {
        throw new Error('Either --image-url or --video-url is required');
      }
      const client = getClient();

      // Step 1: Create media container
      const containerBody: Record<string, string> = {};
      if (opts.imageUrl) {
        containerBody.image_url = opts.imageUrl;
      }
      if (opts.videoUrl) {
        containerBody.video_url = opts.videoUrl;
        containerBody.media_type = 'REELS';
      }
      if (opts.caption) containerBody.caption = opts.caption;
      if (opts.locationId) containerBody.location_id = opts.locationId;
      if (opts.userTags) containerBody.user_tags = opts.userTags;
      if (opts.coverUrl) containerBody.cover_url = opts.coverUrl;
      if (opts.shareToFeed !== undefined) containerBody.share_to_feed = String(opts.shareToFeed);
      if (opts.collaborators) containerBody.collaborators = JSON.stringify(opts.collaborators.split(','));

      const containerResponse = await client.request(`${instagramId}/media`, {
        method: 'POST',
        body: containerBody,
      });

      const containerId = (containerResponse.data as Record<string, unknown>).id as string;

      // Step 2: For videos, wait for processing
      if (opts.videoUrl) {
        console.error('Video uploaded, waiting for processing...');
        let status = 'IN_PROGRESS';
        let attempts = 0;
        while (status === 'IN_PROGRESS' && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const statusResponse = await client.request(containerId, {
            params: { fields: 'status_code' },
          });
          status = (statusResponse.data as Record<string, unknown>).status_code as string;
          attempts++;
          if (status === 'ERROR') {
            throw new Error('Video processing failed');
          }
        }
      }

      // Step 3: Publish
      const publishResponse = await client.request(`${instagramId}/media_publish`, {
        method: 'POST',
        body: { creation_id: containerId },
      });

      console.log(formatOutput(publishResponse.data, opts.output as OutputFormat));
    }));

  instagram
    .command('publish-carousel <instagramId>')
    .description('Publish a carousel (multi-image/video) post to Instagram')
    .requiredOption('--items <json>', 'JSON array of items: [{"image_url":"..."}, {"video_url":"..."}]')
    .option('--caption <text>', 'Post caption')
    .option('--location-id <id>', 'Facebook Page location ID')
    .option('--collaborators <usernames>', 'Comma-separated collaborator usernames')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const items = JSON.parse(opts.items) as Array<Record<string, string>>;

      if (items.length < 2 || items.length > 10) {
        throw new Error('Carousel requires 2-10 items');
      }

      // Step 1: Create child containers
      const childIds: string[] = [];
      for (const item of items) {
        const childBody: Record<string, string> = {
          is_carousel_item: 'true',
        };
        if (item.image_url) childBody.image_url = item.image_url;
        if (item.video_url) {
          childBody.video_url = item.video_url;
          childBody.media_type = 'VIDEO';
        }

        const childResponse = await client.request(`${instagramId}/media`, {
          method: 'POST',
          body: childBody,
        });
        childIds.push((childResponse.data as Record<string, unknown>).id as string);
      }

      // Step 2: Create carousel container
      const carouselBody: Record<string, string> = {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
      };
      if (opts.caption) carouselBody.caption = opts.caption;
      if (opts.locationId) carouselBody.location_id = opts.locationId;
      if (opts.collaborators) carouselBody.collaborators = JSON.stringify(opts.collaborators.split(','));

      const carouselResponse = await client.request(`${instagramId}/media`, {
        method: 'POST',
        body: carouselBody,
      });

      const carouselId = (carouselResponse.data as Record<string, unknown>).id as string;

      // Step 3: Publish
      const publishResponse = await client.request(`${instagramId}/media_publish`, {
        method: 'POST',
        body: { creation_id: carouselId },
      });

      console.log(formatOutput(publishResponse.data, opts.output as OutputFormat));
    }));

  instagram
    .command('publish-story <instagramId>')
    .description('Publish a story to Instagram')
    .option('--image-url <url>', 'Public image URL')
    .option('--video-url <url>', 'Public video URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      if (!opts.imageUrl && !opts.videoUrl) {
        throw new Error('Either --image-url or --video-url is required');
      }
      const client = getClient();

      const containerBody: Record<string, string> = {
        media_type: 'STORIES',
      };
      if (opts.imageUrl) containerBody.image_url = opts.imageUrl;
      if (opts.videoUrl) containerBody.video_url = opts.videoUrl;

      const containerResponse = await client.request(`${instagramId}/media`, {
        method: 'POST',
        body: containerBody,
      });

      const containerId = (containerResponse.data as Record<string, unknown>).id as string;

      // Wait briefly for processing
      if (opts.videoUrl) {
        console.error('Video uploaded, waiting for processing...');
        let status = 'IN_PROGRESS';
        let attempts = 0;
        while (status === 'IN_PROGRESS' && attempts < 30) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const statusResponse = await client.request(containerId, {
            params: { fields: 'status_code' },
          });
          status = (statusResponse.data as Record<string, unknown>).status_code as string;
          attempts++;
        }
      }

      const publishResponse = await client.request(`${instagramId}/media_publish`, {
        method: 'POST',
        body: { creation_id: containerId },
      });

      console.log(formatOutput(publishResponse.data, opts.output as OutputFormat));
    }));

  // ── Media ─────────────────────────────────────────────

  instagram
    .command('media <instagramId>')
    .description('List media (posts, reels, stories) for an Instagram account')
    .option('--limit <n>', 'Maximum media items', '25')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,is_shared_to_feed',
        limit: opts.limit,
      };

      const endpoint = `${instagramId}/media`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('media-get <mediaId>')
    .description('Get detailed info for a specific media item')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (mediaId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,is_shared_to_feed,children{id,media_type,media_url}',
      };

      const response = await client.request(mediaId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('media-insights <mediaId>')
    .description('Get insights for a specific media item')
    .option('--metrics <list>', 'Comma-separated metrics (defaults vary by media type)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (mediaId: string, opts) => {
      const client = getClient();
      const defaultMetrics = 'impressions,reach,engagement,saved,video_views,likes,comments,shares';
      const params: Record<string, string> = {
        metric: opts.metrics || defaultMetrics,
      };

      const response = await client.request(`${mediaId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('stories <instagramId>')
    .description('List active stories for an Instagram account')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,caption,media_type,media_url,permalink,timestamp',
      };

      const response = await client.request(`${instagramId}/stories`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('story-insights <storyId>')
    .description('Get insights for a specific story')
    .option('--metrics <list>', 'Comma-separated metrics', 'impressions,reach,replies,exits,taps_forward,taps_back')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (storyId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
      };

      const response = await client.request(`${storyId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Comments ──────────────────────────────────────────

  instagram
    .command('comments <mediaId>')
    .description('List comments on an Instagram media item')
    .option('--limit <n>', 'Maximum comments', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (mediaId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}',
        limit: opts.limit,
      };

      const endpoint = `${mediaId}/comments`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('reply-comment <commentId>')
    .description('Reply to an Instagram comment')
    .requiredOption('--message <text>', 'Reply message')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (commentId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${commentId}/replies`, {
        method: 'POST',
        body: { message: opts.message },
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('delete-comment <commentId>')
    .description('Delete an Instagram comment')
    .option('--hide', 'Hide instead of delete')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (commentId: string, opts) => {
      const client = getClient();
      if (opts.hide) {
        const response = await client.request(commentId, {
          method: 'POST',
          body: { hide: 'true' },
        });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        const response = await client.request(commentId, { method: 'DELETE' });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  // ── Account Insights ──────────────────────────────────

  instagram
    .command('insights <instagramId>')
    .description('Get account-level Instagram insights')
    .option('--metrics <list>', 'Comma-separated metrics', 'impressions,reach,profile_views,website_clicks,follower_count,email_contacts,phone_call_clicks,text_message_clicks,get_directions_clicks')
    .option('--period <period>', 'Aggregation period: day, week, days_28, month, lifetime', 'day')
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
        period: opts.period,
      };

      const resolved = resolveTimeRange(opts.timeRange);
      if (resolved) {
        const range = JSON.parse(resolved);
        params.since = range.since;
        params.until = range.until;
      }

      const response = await client.request(`${instagramId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  instagram
    .command('shopping-insights <instagramId>')
    .description('Get Instagram Shopping performance insights')
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (instagramId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'impressions,reach,profile_views,website_clicks',
        period: 'day',
        metric: 'impressions,reach,profile_views,website_clicks',
      };

      const resolved = resolveTimeRange(opts.timeRange);
      if (resolved) params.time_range = resolved;

      const response = await client.request(`${instagramId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
