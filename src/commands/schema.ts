import { Command } from 'commander';
import { formatOutput, type OutputFormat } from '../formatter.js';

interface EndpointSchema {
  method: string;
  path: string;
  description: string;
  params: string[];
}

const ENDPOINTS: Record<string, Record<string, EndpointSchema>> = {
  accounts: {
    list: { method: 'GET', path: '{user_id}/adaccounts', description: 'List ad accounts', params: ['fields', 'limit'] },
    get: { method: 'GET', path: '{account_id}', description: 'Get account details', params: ['fields'] },
  },
  campaigns: {
    list: { method: 'GET', path: '{account_id}/campaigns', description: 'List campaigns', params: ['fields', 'limit', 'effective_status', 'after'] },
    get: { method: 'GET', path: '{campaign_id}', description: 'Get campaign details', params: ['fields'] },
    create: { method: 'POST', path: '{account_id}/campaigns', description: 'Create campaign', params: ['name', 'objective', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'special_ad_categories'] },
    update: { method: 'POST', path: '{campaign_id}', description: 'Update campaign', params: ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy'] },
    delete: { method: 'POST', path: '{campaign_id}', description: 'Delete campaign', params: ['status=DELETED'] },
    duplicate: { method: 'POST', path: '{campaign_id}/copies', description: 'Duplicate campaign', params: ['status_option', 'deep_copy'] },
  },
  adsets: {
    list: { method: 'GET', path: '{account_id}/adsets', description: 'List ad sets', params: ['fields', 'limit', 'effective_status'] },
    get: { method: 'GET', path: '{adset_id}', description: 'Get ad set details', params: ['fields'] },
    create: { method: 'POST', path: '{account_id}/adsets', description: 'Create ad set', params: ['campaign_id', 'name', 'optimization_goal', 'billing_event', 'targeting', 'daily_budget'] },
    update: { method: 'POST', path: '{adset_id}', description: 'Update ad set', params: ['name', 'status', 'daily_budget', 'targeting', 'bid_amount'] },
    delete: { method: 'POST', path: '{adset_id}', description: 'Delete ad set', params: ['status=DELETED'] },
  },
  ads: {
    list: { method: 'GET', path: '{account_id}/ads', description: 'List ads', params: ['fields', 'limit', 'effective_status'] },
    get: { method: 'GET', path: '{ad_id}', description: 'Get ad details', params: ['fields'] },
    create: { method: 'POST', path: '{account_id}/ads', description: 'Create ad', params: ['name', 'adset_id', 'creative', 'status'] },
    update: { method: 'POST', path: '{ad_id}', description: 'Update ad', params: ['name', 'status', 'creative'] },
  },
  creatives: {
    list: { method: 'GET', path: '{account_id}/adcreatives', description: 'List creatives', params: ['fields', 'limit'] },
    get: { method: 'GET', path: '{creative_id}', description: 'Get creative details', params: ['fields'] },
    create: { method: 'POST', path: '{account_id}/adcreatives', description: 'Create creative', params: ['name', 'object_story_spec', 'asset_feed_spec'] },
  },
  insights: {
    get: { method: 'GET', path: '{object_id}/insights', description: 'Get performance insights', params: ['fields', 'time_range', 'breakdowns', 'level', 'limit'] },
  },
  targeting: {
    'search-interests': { method: 'GET', path: 'search', description: 'Search interests', params: ['type=adinterest', 'q', 'limit'] },
    'search-geo': { method: 'GET', path: 'search', description: 'Search locations', params: ['type=adgeolocation', 'q', 'location_types'] },
    'search-behaviors': { method: 'GET', path: 'search', description: 'Search behaviors', params: ['type=adTargetingCategory', 'class=behaviors'] },
    'estimate-audience': { method: 'GET', path: '{account_id}/delivery_estimate', description: 'Estimate audience size', params: ['targeting_spec', 'optimization_goal'] },
  },
  audiences: {
    list: { method: 'GET', path: '{account_id}/customaudiences', description: 'List custom audiences', params: ['fields', 'limit'] },
    create: { method: 'POST', path: '{account_id}/customaudiences', description: 'Create audience', params: ['name', 'subtype', 'rule'] },
    delete: { method: 'DELETE', path: '{audience_id}', description: 'Delete audience', params: [] },
  },
  pixels: {
    list: { method: 'GET', path: '{account_id}/adspixels', description: 'List pixels', params: ['fields'] },
    create: { method: 'POST', path: '{account_id}/adspixels', description: 'Create pixel', params: ['name'] },
  },
  library: {
    search: { method: 'GET', path: 'ads_archive', description: 'Search Ads Library', params: ['search_terms', 'ad_reached_countries', 'ad_type', 'fields'] },
  },
};

export function registerSchemaCommands(program: Command): void {
  program
    .command('schema [service] [operation]')
    .description('Show API schema for services and operations')
    .option('-o, --output <format>', 'Output format', 'json')
    .action((service: string | undefined, operation: string | undefined, opts: { output: string }) => {
      if (!service) {
        // List all services
        const services = Object.keys(ENDPOINTS).map(name => ({
          service: name,
          operations: Object.keys(ENDPOINTS[name]).join(', '),
        }));
        console.log(formatOutput(services, opts.output as OutputFormat));
        return;
      }

      const svc = ENDPOINTS[service];
      if (!svc) {
        console.error(`Unknown service: ${service}. Available: ${Object.keys(ENDPOINTS).join(', ')}`);
        process.exit(1);
      }

      if (!operation) {
        // List operations for service
        const ops = Object.entries(svc).map(([name, schema]) => ({
          operation: name,
          method: schema.method,
          path: schema.path,
          description: schema.description,
        }));
        console.log(formatOutput(ops, opts.output as OutputFormat));
        return;
      }

      const op = svc[operation];
      if (!op) {
        console.error(`Unknown operation: ${operation}. Available: ${Object.keys(svc).join(', ')}`);
        process.exit(1);
      }

      console.log(formatOutput({
        service,
        operation,
        ...op,
      }, opts.output as OutputFormat));
    });
}
