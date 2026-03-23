import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerConversionCommands(program: Command, getClient: () => MetaClient): void {
  const conversions = program.command('conversions').alias('conv').description('Conversions API and server-side tracking');

  conversions
    .command('send-event')
    .description('Send a server-side conversion event via the Conversions API')
    .requiredOption('--pixel-id <id>', 'Meta Pixel ID')
    .requiredOption('--event-name <name>', 'Event name (Purchase, Lead, CompleteRegistration, AddToCart, ViewContent, etc.)')
    .option('--event-time <timestamp>', 'Unix timestamp (defaults to now)')
    .option('--user-data <json>', 'User data JSON (em, ph, external_id, client_ip_address, fbp, fbc)')
    .option('--custom-data <json>', 'Custom data JSON (value, currency, content_ids, content_type, num_items)')
    .option('--event-source-url <url>', 'URL where event occurred')
    .option('--action-source <source>', 'Action source (website, email, phone_call, chat, other)', 'website')
    .option('--test-event-code <code>', 'Test event code from Events Manager (for debugging)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();

      const eventData: Record<string, unknown> = {
        event_name: opts.eventName,
        event_time: opts.eventTime ? parseInt(opts.eventTime) : Math.floor(Date.now() / 1000),
        action_source: opts.actionSource,
      };
      if (opts.userData) eventData.user_data = JSON.parse(opts.userData);
      if (opts.customData) eventData.custom_data = JSON.parse(opts.customData);
      if (opts.eventSourceUrl) eventData.event_source_url = opts.eventSourceUrl;

      const body: Record<string, string> = {
        data: JSON.stringify([eventData]),
      };
      if (opts.testEventCode) body.test_event_code = opts.testEventCode;

      const response = await client.request(`${opts.pixelId}/events`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('custom-conversions')
    .description('List custom conversions for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,pixel,custom_event_type,default_conversion_value,rule,creation_time',
      };
      const response = await client.request(`${opts.accountId}/customconversions`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('create-custom')
    .description('Create a custom conversion event')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Custom conversion name')
    .requiredOption('--pixel-id <id>', 'Pixel ID')
    .requiredOption('--rule <json>', 'Conversion rule as JSON')
    .option('--event-type <type>', 'Custom event type (e.g., PURCHASE, LEAD)')
    .option('--default-value <value>', 'Default conversion value')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        pixel: opts.pixelId,
        rule: opts.rule,
      };
      if (opts.eventType) body.custom_event_type = opts.eventType;
      if (opts.defaultValue) body.default_conversion_value = opts.defaultValue;

      const response = await client.request(`${opts.accountId}/customconversions`, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('setup-tracking')
    .description('Setup conversion tracking for an account')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--pixel-id <id>', 'Pixel ID to configure')
    .option('--first-party-cookies', 'Enable first-party cookies')
    .option('--automatic-matching', 'Enable automatic advanced matching')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const body: Record<string, string> = {};
      if (opts.firstPartyCookies) body.first_party_cookies_enabled = 'true';
      if (opts.automaticMatching) body.automatic_matching_enabled = 'true';

      const response = await client.request(opts.pixelId, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('send-batch')
    .description('Send multiple conversion events in a single batch request')
    .requiredOption('--pixel-id <id>', 'Meta Pixel ID')
    .requiredOption('--events <json>', 'JSON array of event objects [{event_name, event_time, user_data, custom_data}, ...]')
    .option('--test-event-code <code>', 'Test event code from Events Manager')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const events = JSON.parse(opts.events) as Array<Record<string, unknown>>;

      // Ensure each event has event_time
      for (const event of events) {
        if (!event.event_time) {
          event.event_time = Math.floor(Date.now() / 1000);
        }
        if (!event.action_source) {
          event.action_source = 'website';
        }
      }

      const body: Record<string, string> = {
        data: JSON.stringify(events),
      };
      if (opts.testEventCode) body.test_event_code = opts.testEventCode;

      const response = await client.request(`${opts.pixelId}/events`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('offline-events')
    .description('Send offline conversion events (in-store purchases, phone orders)')
    .requiredOption('--event-set-id <id>', 'Offline event set ID')
    .requiredOption('--events <json>', 'JSON array of offline event objects')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const events = JSON.parse(opts.events) as Array<Record<string, unknown>>;

      for (const event of events) {
        if (!event.event_time) {
          event.event_time = Math.floor(Date.now() / 1000);
        }
      }

      const body: Record<string, string> = {
        data: JSON.stringify(events),
      };

      const response = await client.request(`${opts.eventSetId}/events`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('offline-event-sets')
    .description('List offline event sets for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,event_stats,data_use_setting,creation_time',
      };

      const response = await client.request(`${opts.accountId}/offline_conversion_data_sets`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('create-offline-set')
    .description('Create an offline event set')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Event set name')
    .option('--description <text>', 'Event set description')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.description) body.description = opts.description;

      const response = await client.request(`${opts.accountId}/offline_conversion_data_sets`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('validate-setup <pixelId>')
    .description('Validate conversion tracking setup for a pixel')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pixelId: string, opts) => {
      const client = getClient();

      // Get pixel info
      const pixelParams: Record<string, string> = {
        fields: 'id,name,code,creation_time,data_use_setting,last_fired_time,is_created_by_app',
      };
      const pixelResponse = await client.request(pixelId, { params: pixelParams });

      // Get pixel stats
      const statsResponse = await client.request(`${pixelId}/stats`, {
        params: { fields: 'data' },
      });

      const result = {
        pixel: pixelResponse.data,
        stats: statsResponse.data,
        validation: {
          pixel_exists: true,
          has_recent_activity: !!(pixelResponse.data as Record<string, unknown>).last_fired_time,
        },
      };

      console.log(formatOutput(result, opts.output as OutputFormat));
    }));

  // ── App Events API ────────────────────────────────────

  conversions
    .command('send-app-event')
    .description('Log an app event for analytics and ad optimization')
    .requiredOption('--app-id <id>', 'Meta App ID')
    .requiredOption('--event-name <name>', 'Event name (fb_mobile_purchase, fb_mobile_add_to_cart, etc.)')
    .option('--advertiser-id <id>', 'Advertiser tracking ID (IDFA/GAID)')
    .option('--bundle-id <id>', 'App bundle identifier')
    .option('--custom-events <json>', 'Custom event data as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const eventData: Record<string, unknown> = {
        event: 'CUSTOM_APP_EVENTS',
        custom_events: JSON.stringify([{ _eventName: opts.eventName }]),
      };
      if (opts.advertiserId) eventData.advertiser_id = opts.advertiserId;
      if (opts.bundleId) eventData.application_tracking_enabled = '1';
      if (opts.customEvents) eventData.custom_events = opts.customEvents;

      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(eventData)) body[k] = String(v);

      const response = await client.request(`${opts.appId}/activities`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Dataset API (unified event sources) ───────────────

  conversions
    .command('datasets')
    .description('List datasets (unified event sources) for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const response = await client.request(`${opts.accountId}/datasets`, {
        params: { fields: 'id,name,description,creation_time,usage' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('dataset-send <datasetId>')
    .description('Send events to a dataset (unified Conversions API)')
    .requiredOption('--events <json>', 'JSON array of event objects')
    .option('--test-event-code <code>', 'Test event code')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (datasetId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        data: opts.events,
      };
      if (opts.testEventCode) body.test_event_code = opts.testEventCode;

      const response = await client.request(`${datasetId}/events`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
