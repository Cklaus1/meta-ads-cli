import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

/**
 * Threads API uses a separate base URL: https://graph.threads.net
 * We use the MetaClient's request method but override the endpoint with full URL.
 */

export function registerThreadsCommands(program: Command, getClient: () => MetaClient): void {
  const threads = program.command('threads').description('Threads content publishing, insights, and management');

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

      const response = await client.request(`${opts.userId}`, { params });
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
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      // Step 1: Create media container
      const containerBody: Record<string, string> = {
        text: opts.text,
        media_type: opts.mediaType,
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
        body: containerBody,
      });

      const containerId = (containerResponse.data as Record<string, unknown>).id as string;

      // Step 2: Publish the container
      const publishResponse = await client.request(`${opts.userId}/threads_publish`, {
        method: 'POST',
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
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

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

      const response = await client.request(threadId, { params });
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
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

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
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Manage ────────────────────────────────────────────

  threads
    .command('delete <threadId>')
    .description('Delete a Threads post')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const response = await client.request(threadId, { method: 'DELETE' });
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
        body: { hide: opts.unhide ? 'false' : 'true' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Insights ──────────────────────────────────────────

  threads
    .command('insights')
    .description('Get Threads account-level insights')
    .option('--user-id <id>', 'Threads user ID (default: me)', 'me')
    .option('--metrics <list>', 'Comma-separated metrics', 'views,likes,replies,reposts,quotes,followers_count')
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

      const response = await client.request(`${opts.userId}/threads_insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  threads
    .command('post-insights <threadId>')
    .description('Get insights for a specific Threads post')
    .option('--metrics <list>', 'Comma-separated metrics', 'views,likes,replies,reposts,quotes')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (threadId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
      };

      const response = await client.request(`${threadId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Search ────────────────────────────────────────────

  threads
    .command('search <query>')
    .description('Search Threads posts by keyword')
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (query: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        q: query,
        fields: 'id,text,username,permalink,timestamp,media_type',
        limit: opts.limit,
      };

      const response = await client.request('threads/search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
