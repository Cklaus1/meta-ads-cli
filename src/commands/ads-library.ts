import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerAdsLibraryCommands(program: Command, getClient: () => MetaClient): void {
  const library = program.command('library').description('Meta Ads Library search and analysis');

  library
    .command('search')
    .description('Search the Meta Ads Library')
    .requiredOption('--query <query>', 'Search query')
    .option('--country <code>', 'Country code (e.g., US, GB)', 'US')
    .option('--ad-type <type>', 'Ad type: ALL, POLITICAL_AND_ISSUE_ADS, HOUSING_ADS, etc.', 'ALL')
    .option('--platform <platform>', 'Platform: FACEBOOK, INSTAGRAM, AUDIENCE_NETWORK, MESSENGER')
    .option('--active-status <status>', 'Status: ALL, ACTIVE, INACTIVE', 'ALL')
    .option('--page-id <id>', 'Filter by specific page ID')
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        search_terms: opts.query,
        ad_reached_countries: JSON.stringify([opts.country]),
        ad_type: opts.adType,
        ad_active_status: opts.activeStatus,
        fields: 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,currency_lower_bound,currency_upper_bound,impressions,page_id,page_name,publisher_platforms,spend',
        limit: opts.limit,
      };
      if (opts.platform) {
        params.publisher_platform = opts.platform;
      }
      if (opts.pageId) {
        params.search_page_ids = JSON.stringify([opts.pageId]);
      }

      const endpoint = 'ads_archive';
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  library
    .command('page-ads <pageId>')
    .description('Get all ads for a specific page')
    .option('--country <code>', 'Country code', 'US')
    .option('--active-status <status>', 'Status: ALL, ACTIVE, INACTIVE', 'ACTIVE')
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        search_page_ids: JSON.stringify([pageId]),
        ad_reached_countries: JSON.stringify([opts.country]),
        ad_type: 'ALL',
        ad_active_status: opts.activeStatus,
        fields: 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_snapshot_url,page_name,publisher_platforms,spend',
        limit: opts.limit,
      };

      const endpoint = 'ads_archive';
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  library
    .command('batch-search')
    .description('Search Ads Library for multiple brands in parallel')
    .requiredOption('--brands <json>', 'JSON array of {query, page_id?} objects')
    .option('--country <code>', 'Country code', 'US')
    .option('--limit <n>', 'Max results per brand', '10')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const brands = JSON.parse(opts.brands) as Array<{ query: string; page_id?: string }>;
      const results: unknown[] = [];

      for (const brand of brands) {
        const params: Record<string, string> = {
          ad_reached_countries: JSON.stringify([opts.country]),
          ad_type: 'ALL',
          ad_active_status: 'ACTIVE',
          fields: 'id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,page_name,publisher_platforms,spend',
          limit: opts.limit,
        };
        if (brand.page_id) {
          params.search_page_ids = JSON.stringify([brand.page_id]);
        } else {
          params.search_terms = brand.query;
        }

        const response = await client.request('ads_archive', { params });
        const ads = (response.data as Record<string, unknown>).data as unknown[] || [];
        results.push({
          brand: brand.query || brand.page_id,
          ads_found: ads.length,
          ads: ads.slice(0, parseInt(opts.limit)),
        });
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));
}