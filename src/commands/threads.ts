import { Command } from 'commander';
import { MetaClient, THREADS_BASE_URL, type MetaRequestOptions } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

/**
 * Threads API lives on a separate host (graph.threads.com) and needs a Threads
 * user token. Set META_ADS_CLI_THREADS_ACCESS_TOKEN to one; otherwise the
 * normal access token is sent.
 */
function threadsApi(): Pick<MetaRequestOptions, 'baseUrl' | 'accessToken'> {
  return {
    baseUrl: THREADS_BASE_URL,
    accessToken: process.env.META_ADS_CLI_THREADS_ACCESS_TOKEN || undefined,
  };
}

const REPLY_CONTROLS = ['everyone', 'accounts_you_follow', 'mentioned_only', 'parent_post_author_only', 'followers_only'];
const MAX_LINKS = 5;
const MAX_TEXT_LENGTH = 500;

/**
 * Build and validate the optional Threads post fields (polls, GIFs, spoilers,
 * reply controls, ...) from command options. Limits come from the Threads docs.
 */
export function buildThreadsPostFields(opts: Record<string, any>): Record<string, string> {
  const body: Record<string, string> = {};
  const text: string = opts.text ?? '';
  const isMedia = Boolean(opts.imageUrl || opts.videoUrl) || (opts.mediaType && opts.mediaType !== 'TEXT');

  // (Meta counts emojis by UTF-8 bytes, so this check is a lower bound.)
  if ([...text].length > MAX_TEXT_LENGTH) {
    throw new Error(`Threads posts are limited to ${MAX_TEXT_LENGTH} characters`);
  }
  const links = text.match(/https?:\/\/\S+/gi) || [];
  if (links.length > MAX_LINKS) {
    throw new Error(`Threads posts can contain at most ${MAX_LINKS} links (found ${links.length})`);
  }

  if (opts.topicTag) {
    if (/[.&]/.test(opts.topicTag)) throw new Error('--topic-tag cannot contain "." or "&"');
    body.topic_tag = opts.topicTag;
  }
  if (opts.poll) {
    if (isMedia) throw new Error('Polls can only be attached to text posts');
    const options = String(opts.poll).split(',').map(o => o.trim());
    if (options.length < 2 || options.length > 4) throw new Error('--poll needs 2 to 4 options');
    if (options.some(o => o.length < 1 || o.length > 25)) throw new Error('Each poll option must be 1-25 characters');
    const keys = ['option_a', 'option_b', 'option_c', 'option_d'];
    body.poll_attachment = JSON.stringify(Object.fromEntries(options.map((o, i) => [keys[i], o])));
  }
  if (opts.gifId) {
    if (isMedia) throw new Error('GIFs can only be attached to text posts');
    body.gif_attachment = JSON.stringify({ gif_id: opts.gifId, provider: 'GIPHY' });
  }
  if (opts.spoilerText) {
    const entities = String(opts.spoilerText).split(',').map(r => {
      const m = r.trim().match(/^(\d+):(\d+)$/);
      if (!m || Number(m[2]) < 1) throw new Error(`--spoiler-text ranges must be "offset:length", got: "${r}"`);
      return { entity_type: 'SPOILER', offset: Number(m[1]), length: Number(m[2]) };
    });
    if (entities.length > 10) throw new Error('A post can have at most 10 text spoilers');
    body.text_entities = JSON.stringify(entities);
  }
  if (opts.spoilerMedia) {
    if (!isMedia) throw new Error('--spoiler-media needs an image, video or carousel');
    body.is_spoiler_media = 'true';
  }
  if (opts.replyControl) {
    if (!REPLY_CONTROLS.includes(opts.replyControl)) {
      throw new Error(`--reply-control must be one of: ${REPLY_CONTROLS.join(', ')}`);
    }
    body.reply_control = opts.replyControl;
  }
  if (opts.replyApprovals) body.enable_reply_approvals = 'true';
  if (opts.locationId) body.location_id = opts.locationId;
  if (opts.quotePostId) body.quote_post_id = opts.quotePostId;
  if (opts.shareToIgStory) body.crossreshare_to_ig = 'true';
  if (opts.countries) {
    body.allowlisted_country_codes = JSON.stringify(String(opts.countries).split(',').map(c => c.trim().toUpperCase()).filter(Boolean));
  }
  if (opts.altText) {
    if (String(opts.altText).length > 1000) throw new Error('--alt-text is limited to 1000 characters');
    body.alt_text = opts.altText;
  }
  return body;
}

export function registerThreadsCommands(program: Command, getClient: () => MetaClient): void {
  const threads = program.command('threads').description('Threads content publishing, insights, and management (uses META_ADS_CLI_THREADS_ACCESS_TOKEN if set)');

  threads
    .command('profile')
    .description('Get Threads profile for the authenticated user')
    .option('--user-id <id>', 'Threads user ID (default: me)', 'me')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,username,name,threads_profile_picture_url,threads_biography',
      };

      const response = await client.request(`${opts.userId}`, { params, ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Publishing ────────────────────────────────────────

  threads
    .command('create')
    .description('Create a Threads post (text, image, video, or carousel)')
    .option('--user-id <id>', 'Threads user ID (default: me)', 'me')
    .requiredOption('--text <text>', 'Post text content')
    .option('--image-url <url>', 'Image URL to attach')
    .option('--video-url <url>', 'Video URL to attach')
    .option('--media-type <type>', 'Media type: TEXT, IMAGE, VIDEO, CAROUSEL', 'TEXT')
    .option('--reply-to <id>', 'Thread ID to reply to')
    .option('--link-attachment <url>', 'URL to attach as link preview')
    .option('--topic-tag <tag>', 'Topic tag for the post (no "." or "&")')
    .option('--poll <options>', 'Poll options, comma-separated (2-4, each 1-25 chars; text posts only)')
    .option('--gif-id <id>', 'GIPHY GIF ID to attach (text posts only)')
    .option('--spoiler-text <ranges>', 'Mark text as spoiler: "offset:length[,offset:length...]" (max 10)')
    .option('--spoiler-media', 'Blur attached image/video/carousel media as a spoiler')
    .option('--reply-control <who>', 'Who can reply: everyone, accounts_you_follow, mentioned_only, parent_post_author_only, followers_only')
    .option('--reply-approvals', 'Require approval for replies')
    .option('--location-id <id>', 'Location ID to tag (find one with GET /location_search)')
    .option('--quote-post-id <id>', 'Quote another post')
    .option('--share-to-ig-story', 'Also share to the linked Instagram account as a Story (needs threads_share_to_instagram)')
    .option('--countries <codes>', 'Only show in these countries (comma-separated ISO codes)')
    .option('--alt-text <text>', 'Alt text for an image or video (max 1000 chars)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      // Step 1: Create media container
      const containerBody: Record<string, string> = {
        text: opts.text,
        media_type: opts.mediaType,
        ...buildThreadsPostFields(opts),
      };
      if (opts.imageUrl) {
        containerBody.image_url = opts.imageUrl;
        containerBody.media_type = 'IMAGE';
      }
      if (opts.videoUrl) {
        containerBody.video_url = opts.videoUrl;
        containerBody.media_type = 'VIDEO';
      }
      if (opts.replyTo) containerBody.reply_to_id = opts.replyTo;
      if (opts.linkAttachment) containerBody.link_attachment = opts.linkAttachment;

      const containerResponse = await client.request(`${opts.userId}/threads`, {
        method: 'POST',
        ...threadsApi(),
        body: containerBody,
      });

      const containerId = (containerResponse.data as Record<string, unknown>).id as string;

      // Step 2: Publish the container
      const publishResponse = await client.request(`${opts.userId}/threads_publish`, {
        method: 'POST',
        ...threadsApi(),
        body: { creation_id: containerId },
      });

      console.log(formatOutput(publishResponse.data, opts.output as OutputFormat));
    }));

  // ── Reading ───────────────────────────────────────────

  threads
    .command('list')
    .description('List Threads posts for a user')
    .option('--user-id <id>', 'Threads user ID (default: me)', 'me')
    .option('--limit <n>', 'Maximum posts', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,text,username,permalink,timestamp,media_type,media_url,thumbnail_url,shortcode,is_quote_post',
        limit: opts.limit,
      };

      const endpoint = `${opts.userId}/threads`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params, ...threadsApi() })
        : await client.request(endpoint, { params, ...threadsApi() });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('get <threadId>')
    .description('Get a specific Threads post')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,text,username,permalink,timestamp,media_type,media_url,thumbnail_url,shortcode,is_quote_post,has_replies,root_post,replied_to,is_reply,hide_status',
      };

      const response = await client.request(threadId, { params, ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('replies <threadId>')
    .description('Get replies to a Threads post')
    .option('--limit <n>', 'Maximum replies', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,text,username,permalink,timestamp,media_type,hide_status,has_replies',
        limit: opts.limit,
      };

      const endpoint = `${threadId}/replies`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params, ...threadsApi() })
        : await client.request(endpoint, { params, ...threadsApi() });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('conversation <threadId>')
    .description('Get full conversation thread')
    .option('--limit <n>', 'Maximum items', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,text,username,permalink,timestamp,media_type,hide_status,has_replies',
        limit: opts.limit,
      };

      const endpoint = `${threadId}/conversation`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params, ...threadsApi() })
        : await client.request(endpoint, { params, ...threadsApi() });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Manage ────────────────────────────────────────────

  threads
    .command('delete <threadId>')
    .description('Delete a Threads post')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const response = await client.request(threadId, { method: 'DELETE', ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('hide-reply <replyId>')
    .description('Hide or unhide a reply')
    .option('--unhide', 'Unhide instead of hide')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (replyId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${replyId}/manage_reply`, {
        method: 'POST',
        ...threadsApi(),
        body: { hide: opts.unhide ? 'false' : 'true' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Insights ──────────────────────────────────────────

  threads
    .command('insights')
    .description('Get Threads account-level insights')
    .option('--user-id <id>', 'Threads user ID (default: me)', 'me')
    .option('--metrics <list>', 'Comma-separated metrics', 'views,likes,replies,reposts,quotes,clicks,followers_count')
    .option('--since <timestamp>', 'Unix timestamp start')
    .option('--until <timestamp>', 'Unix timestamp end')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
      };
      if (opts.since) params.since = opts.since;
      if (opts.until) params.until = opts.until;

      const response = await client.request(`${opts.userId}/threads_insights`, { params, ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('post-insights <threadId>')
    .description('Get insights for a specific Threads post')
    .option('--metrics <list>', 'Comma-separated metrics', 'views,likes,replies,reposts,quotes,shares')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
      };

      const response = await client.request(`${threadId}/insights`, { params, ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Search ────────────────────────────────────────────

  threads
    .command('search <query>')
    .description('Search public Threads posts by keyword (needs threads_keyword_search approval; otherwise only your own posts)')
    .option('--limit <n>', 'Maximum results', '25')
    .option('--search-type <type>', 'TOP or RECENT')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        q: query,
        ...(opts.searchType ? { search_type: String(opts.searchType).toUpperCase() } : {}),
        fields: 'id,text,username,permalink,timestamp,media_type',
        limit: opts.limit,
      };

      const response = await client.request('keyword_search', { params, ...threadsApi() });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
