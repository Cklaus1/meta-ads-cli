import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { insightsExpansion, attachPerformance, assertSortable } from './adsets.js';

const REVIEW_STATUSES = ['DISAPPROVED', 'WITH_ISSUES'];
const ACCOUNT_QUALITY_URL = 'https://www.facebook.com/accountquality/';

/** Parse a JSON option (inline, @file or -) and re-serialise it for the request body. */
function jsonOption(value: string, flag: string): string {
  return JSON.stringify(parseJsonInput(value, flag));
}

/**
 * Summarise why an ad was rejected or limited, from ad_review_feedback
 * ({global: {reason: text}, placement_specific: {...}}) and issues_info.
 */
export function reviewReasons(ad: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const feedback = (ad.ad_review_feedback || {}) as Record<string, unknown>;
  for (const [scope, entries] of Object.entries(feedback)) {
    if (entries && typeof entries === 'object') {
      for (const [key, text] of Object.entries(entries as Record<string, unknown>)) {
        if (text && typeof text === 'object') {
          for (const [k, t] of Object.entries(text as Record<string, unknown>)) reasons.push(`${scope}/${key}: ${k} ${String(t)}`.trim());
        } else {
          reasons.push(`${scope === 'global' ? '' : `${scope}: `}${key}${text ? ` — ${String(text)}` : ''}`);
        }
      }
    }
  }
  const issues = Array.isArray(ad.issues_info) ? ad.issues_info as Array<Record<string, unknown>> : [];
  for (const issue of issues) {
    reasons.push(String(issue.error_summary || issue.error_message || issue.error_code || 'issue'));
  }
  return reasons;
}

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerAdCommands(program: Command, getClient: () => MetaClient): void {
  const ads = program.command('ads').description('Ad management');

  ads
    .command('list')
    .description('List ads for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Filter by campaign ID')
    .option('--adset-id <id>', 'Filter by ad set ID')
    .option('--limit <n>', 'Maximum number of ads', '10')
    .option('--status <status>', 'Filter by effective status')
    .option('--all', 'Fetch all pages')
    .option('--page-limit <n>', 'Max pages when using --all')
    .option('--with-insights <range>', 'Add performance (spend, results, cost per result, revenue, ROAS) for a date preset, e.g. last_7d')
    .option('--sort-by <metric>', 'With --with-insights: sort by spend, results, cost_per_result, revenue, roas, ctr, cpc, cpm, impressions or frequency')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      assertSortable(opts.sortBy);
      if (opts.sortBy && !opts.withInsights) throw new Error('--sort-by needs --with-insights');
      const client = getClient();
      let fields = 'id,name,adset_id,campaign_id,status,effective_status,configured_status,creative,bid_amount,created_time,updated_time,issues_info,preview_shareable_link';
      // The ad set's optimisation event decides what counts as a "result".
      if (opts.withInsights) fields += `,adset{optimization_goal,promoted_object},${insightsExpansion(opts.withInsights)}`;
      const params: Record<string, string> = {
        fields,
        limit: opts.limit,
      };
      if (opts.status) {
        params.effective_status = JSON.stringify([opts.status]);
      }

      let endpoint: string;
      if (opts.adsetId) {
        endpoint = `${opts.adsetId}/ads`;
      } else if (opts.campaignId) {
        endpoint = `${opts.campaignId}/ads`;
      } else {
        endpoint = `${opts.accountId}/ads`;
      }

      const response = opts.all
        ? await client.requestAllPages(endpoint, { params },
            opts.pageLimit ? parseInt(opts.pageLimit) : undefined)
        : await client.request(endpoint, { params });

      const rows = (response.data as { data?: Array<Record<string, unknown>> }).data;
      if (opts.withInsights && Array.isArray(rows)) attachPerformance(rows, opts.sortBy);

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('disapproved')
    .description('List disapproved ads and ads delivering with issues, with Meta\'s review feedback')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Only ads in this campaign')
    .option('--disapproved-only', 'Leave out ads delivering with issues (WITH_ISSUES)')
    .option('--page-limit <n>', 'Max pages to fetch')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId && !opts.campaignId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const statuses = opts.disapprovedOnly ? ['DISAPPROVED'] : REVIEW_STATUSES;
      const endpoint = opts.campaignId ? `${opts.campaignId}/ads` : `${opts.accountId}/ads`;
      const response = await client.requestAllPages(endpoint, {
        params: {
          fields: 'id,name,adset_id,campaign_id,effective_status,ad_review_feedback,issues_info,creative{id,name},updated_time',
          effective_status: JSON.stringify(statuses),
          limit: '100',
        },
      }, opts.pageLimit ? parseInt(opts.pageLimit) : undefined);
      const ads = ((response.data as { data?: Array<Record<string, unknown>> }).data || []).map(ad => ({
        id: ad.id,
        name: ad.name,
        effective_status: ad.effective_status,
        campaign_id: ad.campaign_id,
        adset_id: ad.adset_id,
        creative_id: (ad.creative as { id?: string } | undefined)?.id,
        reasons: reviewReasons(ad),
        updated_time: ad.updated_time,
      }));
      console.log(formatOutput({
        total: ads.length,
        disapproved: ads.filter(a => a.effective_status === 'DISAPPROVED').length,
        with_issues: ads.filter(a => a.effective_status === 'WITH_ISSUES').length,
        data: ads,
        next_steps: ads.length
          ? `Fix the ad and re-save it (meta-ads ads update / ads request-review), or appeal in Account Quality: ${ACCOUNT_QUALITY_URL}`
          : undefined,
      }, opts.output as OutputFormat));
    }));

  ads
    .command('request-review <adId>')
    .description('Show why an ad was rejected and, with --resubmit, re-save it so Meta reviews it again')
    .option('--resubmit', 'Re-save the ad unchanged. Meta normally re-reviews edited ads; a formal appeal goes through Account Quality')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const ad = (await client.request(adId, {
        params: { fields: 'id,name,effective_status,ad_review_feedback,issues_info' },
      })).data as Record<string, unknown>;
      const status = String(ad.effective_status || '');
      const result: Record<string, unknown> = {
        id: adId,
        name: ad.name,
        effective_status: ad.effective_status,
        reasons: reviewReasons(ad),
        appeal_url: ACCOUNT_QUALITY_URL,
      };
      if (!client.isDryRun() && !REVIEW_STATUSES.includes(status)) {
        result.note = `Ad is ${status || 'not rejected'}; there is nothing to review.`;
        console.log(formatOutput(result, opts.output as OutputFormat));
        return;
      }
      if (opts.resubmit) {
        const saved = await client.request(adId, { method: 'POST', body: { name: String(ad.name ?? '') } });
        result.resubmitted = true;
        result.response = saved.data;
        result.note = 'Ad re-saved. If Meta doesn\'t re-review it, edit the creative or appeal in Account Quality.';
      } else {
        result.note = 'Fix the issue (e.g. meta-ads ads update --creative-id), then re-run with --resubmit, or appeal in Account Quality.';
      }
      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  ads
    .command('get <adId>')
    .description('Get detailed info for a specific ad')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,adset_id,campaign_id,status,effective_status,configured_status,creative,bid_amount,tracking_specs,conversion_domain,ad_review_feedback,issues_info,preview_shareable_link,ad_active_time,ad_schedule_start_time,ad_schedule_end_time,adlabels,source_ad_id,created_time,updated_time',
      };

      const response = await client.request(adId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('create')
    .description('Create a new ad')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Ad name')
    .requiredOption('--adset-id <id>', 'Ad set ID')
    .requiredOption('--creative-id <id>', 'Creative ID')
    .option('--status <status>', 'Initial status', 'PAUSED')
    .option('--bid-amount <cents>', 'Bid amount in cents')
    .option('--tracking-specs <json>', 'Tracking specs as JSON string')
    .option('--conversion-domain <domain>', 'Conversion domain for pixel events')
    .option('--ad-schedule-start-time <time>', 'Ad start time (ISO 8601, sales/app campaigns)')
    .option('--ad-schedule-end-time <time>', 'Ad end time (ISO 8601, sales/app campaigns)')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('--engagement-audience', 'Create engagement-based custom audience')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        adset_id: opts.adsetId,
        creative: JSON.stringify({ creative_id: opts.creativeId }),
        status: opts.status,
      };

      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.trackingSpecs) body.tracking_specs = jsonOption(opts.trackingSpecs, '--tracking-specs');
      if (opts.conversionDomain) body.conversion_domain = opts.conversionDomain;
      if (opts.adScheduleStartTime) body.ad_schedule_start_time = opts.adScheduleStartTime;
      if (opts.adScheduleEndTime) body.ad_schedule_end_time = opts.adScheduleEndTime;
      if (opts.adlabels) body.adlabels = jsonOption(opts.adlabels, '--adlabels');
      if (opts.engagementAudience) body.engagement_audience = 'true';

      const response = await client.request(`${opts.accountId}/ads`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('update <adId>')
    .description('Update an existing ad')
    .option('--name <name>', 'New ad name')
    .option('--status <status>', 'New status (ACTIVE, PAUSED)')
    .option('--bid-amount <cents>', 'New bid amount')
    .option('--creative-id <id>', 'New creative ID')
    .option('--tracking-specs <json>', 'New tracking specs as JSON')
    .option('--conversion-domain <domain>', 'Conversion domain for pixel events')
    .option('--ad-schedule-start-time <time>', 'Ad start time (ISO 8601)')
    .option('--ad-schedule-end-time <time>', 'Ad end time (ISO 8601)')
    .option('--adlabels <json>', 'Ad labels as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;
      if (opts.bidAmount) body.bid_amount = opts.bidAmount;
      if (opts.creativeId) body.creative = JSON.stringify({ creative_id: opts.creativeId });
      if (opts.trackingSpecs) body.tracking_specs = jsonOption(opts.trackingSpecs, '--tracking-specs');
      if (opts.conversionDomain) body.conversion_domain = opts.conversionDomain;
      if (opts.adScheduleStartTime) body.ad_schedule_start_time = opts.adScheduleStartTime;
      if (opts.adScheduleEndTime) body.ad_schedule_end_time = opts.adScheduleEndTime;
      if (opts.adlabels) body.adlabels = jsonOption(opts.adlabels, '--adlabels');

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(adId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  ads
    .command('delete <adId>')
    .description('Delete an ad')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (adId: string, opts) => {
      const client = getClient();
      const response = await client.request(adId, {
        method: 'POST',
        body: { status: 'DELETED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
