import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { resolveTimeRange } from '../time-range.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerPageCommands(program: Command, getClient: () => MetaClient): void {
  const pages = program.command('pages').description('Facebook Page management');

  pages
    .command('list')
    .description('List pages for the authenticated user')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,category,fan_count,link,picture,verification_status,followers_count,new_like_count,talking_about_count',
      };

      const response = await client.request('me/accounts', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('get <pageId>')
    .description('Get detailed info for a page')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,category,about,description,fan_count,followers_count,link,picture,cover,website,phone,emails,location,hours,verification_status,talking_about_count,new_like_count,were_here_count',
      };

      const response = await client.request(pageId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('search <term>')
    .description('Search pages by name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (term: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        type: 'page',
        q: term,
        fields: 'id,name,category,fan_count,link,verification_status',
      };

      const response = await client.request('search', { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Posts ──────────────────────────────────────────────

  pages
    .command('posts <pageId>')
    .description('List posts for a page')
    .option('--limit <n>', 'Maximum posts', '25')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,message,created_time,updated_time,type,status_type,permalink_url,shares,is_published,is_hidden,likes.summary(true),comments.summary(true)',
        limit: opts.limit,
      };

      const endpoint = `${pageId}/posts`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('create-post <pageId>')
    .description('Create a new page post')
    .option('--message <text>', 'Post message text')
    .option('--link <url>', 'Link URL to share')
    .option('--photo-url <url>', 'Photo URL to include')
    .option('--scheduled-time <timestamp>', 'Unix timestamp for scheduled publishing')
    .option('--published', 'Publish immediately (default: true)', true)
    .option('--unpublished', 'Create as unpublished/draft')
    .option('--targeting <json>', 'Feed targeting as JSON (e.g., {"geo_locations":{"countries":["US"]}})')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.message) body.message = opts.message;
      if (opts.link) body.link = opts.link;
      if (opts.scheduledTime) {
        body.scheduled_publish_time = opts.scheduledTime;
        body.published = 'false';
      }
      if (opts.unpublished) body.published = 'false';
      if (opts.targeting) body.feed_targeting = opts.targeting;

      if (!body.message && !body.link) {
        throw new Error('Either --message or --link is required');
      }

      let endpoint = `${pageId}/feed`;
      if (opts.photoUrl) {
        body.url = opts.photoUrl;
        endpoint = `${pageId}/photos`;
      }

      const response = await client.request(endpoint, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('update-post <postId>')
    .description('Update an existing page post')
    .option('--message <text>', 'New message text')
    .option('--is-hidden', 'Hide the post')
    .option('--is-published', 'Publish a draft post')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (postId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.message) body.message = opts.message;
      if (opts.isHidden) body.is_hidden = 'true';
      if (opts.isPublished) body.is_published = 'true';

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(postId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('delete-post <postId>')
    .description('Delete a page post')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (postId: string, opts) => {
      const client = getClient();
      const response = await client.request(postId, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Comments ──────────────────────────────────────────

  pages
    .command('comments <objectId>')
    .description('List comments on a post, photo, or video')
    .option('--limit <n>', 'Maximum comments', '25')
    .option('--all', 'Fetch all pages')
    .option('--filter <filter>', 'Filter: toplevel, stream', 'toplevel')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (objectId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,message,from,created_time,like_count,comment_count,is_hidden,attachment',
        limit: opts.limit,
        filter: opts.filter,
      };

      const endpoint = `${objectId}/comments`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('reply <commentId>')
    .description('Reply to a comment')
    .requiredOption('--message <text>', 'Reply message')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (commentId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${commentId}/comments`, {
        method: 'POST',
        body: { message: opts.message },
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('delete-comment <commentId>')
    .description('Delete or hide a comment')
    .option('--hide', 'Hide instead of delete')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (commentId: string, opts) => {
      const client = getClient();
      if (opts.hide) {
        const response = await client.request(commentId, {
          method: 'POST',
          body: { is_hidden: 'true' },
        });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        const response = await client.request(commentId, { method: 'DELETE' });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  // ── Page Insights ─────────────────────────────────────

  pages
    .command('insights <pageId>')
    .description('Get page-level insights and metrics')
    .option('--metrics <list>', 'Comma-separated metrics', 'page_fans,page_fan_adds,page_views_total,page_engaged_users,page_post_engagements,page_impressions,page_actions_post_reactions_total')
    .option('--period <period>', 'Aggregation period: day, week, days_28, month, lifetime', 'day')
    .option('--time-range <range>', 'Time range', 'last_30d')
    .option('--date-start <date>', 'Start date (YYYY-MM-DD)')
    .option('--date-end <date>', 'End date (YYYY-MM-DD)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
        period: opts.period,
      };

      if (opts.dateStart && opts.dateEnd) {
        params.since = opts.dateStart;
        params.until = opts.dateEnd;
      } else {
        const resolved = resolveTimeRange(opts.timeRange);
        if (resolved) {
          const range = JSON.parse(resolved);
          params.since = range.since;
          params.until = range.until;
        }
      }

      const response = await client.request(`${pageId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pages
    .command('post-insights <postId>')
    .description('Get insights for a specific post')
    .option('--metrics <list>', 'Comma-separated metrics', 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (postId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        metric: opts.metrics,
      };

      const response = await client.request(`${postId}/insights`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
