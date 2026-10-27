import { Command } from 'commander';
import crypto from 'crypto';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

// Customer-information fields Meta requires to be normalized and SHA-256 hashed.
const PII_NORMALIZERS: Record<string, (v: string) => string> = {
  em: v => v.trim().toLowerCase(),
  ph: v => v.replace(/\D/g, ''),
  fn: v => v.trim().toLowerCase(),
  ln: v => v.trim().toLowerCase(),
  ct: v => v.toLowerCase().replace(/[^a-z0-9]/g, ''),
  st: v => v.toLowerCase().replace(/[^a-z]/g, ''),
  zp: v => v.toLowerCase().replace(/\s/g, ''),
  db: v => v.replace(/\D/g, ''),
  ge: v => v.trim().toLowerCase().charAt(0),
  country: v => v.toLowerCase().replace(/[^a-z]/g, ''),
};

/**
 * Normalize and SHA-256 hash the PII fields of a CAPI user_data object.
 * Values that are already 64-char hex hashes are passed through unchanged.
 */
export function hashUserData(userData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...userData };
  const hashOne = (field: string, v: unknown): unknown => {
    if (typeof v !== 'string' && typeof v !== 'number') return v;
    const str = String(v);
    if (/^[a-f0-9]{64}$/i.test(str)) return str.toLowerCase();
    return crypto.createHash('sha256').update(PII_NORMALIZERS[field](str)).digest('hex');
  };
  for (const field of Object.keys(PII_NORMALIZERS)) {
    const v = out[field];
    if (v === undefined || v === null) continue;
    out[field] = Array.isArray(v) ? v.map(x => hashOne(field, x)) : hashOne(field, v);
  }
  return out;
}

/**
 * Convert legacy offline-event objects to Conversions API events: default
 * action_source to physical_store and event_time to now, and fold the old
 * match_keys into user_data.
 */
export function toPhysicalStoreEvents(events: Array<Record<string, unknown>>, hash = true): Array<Record<string, unknown>> {
  return events.map((raw) => {
    const event: Record<string, unknown> = { ...raw };
    if (!event.event_time) event.event_time = Math.floor(Date.now() / 1000);
    if (!event.action_source) event.action_source = 'physical_store';
    if (event.match_keys && typeof event.match_keys === 'object') {
      event.user_data = { ...(event.match_keys as Record<string, unknown>), ...((event.user_data as Record<string, unknown>) || {}) };
      delete event.match_keys;
    }
    if (hash && event.user_data && typeof event.user_data === 'object') {
      event.user_data = hashUserData(event.user_data as Record<string, unknown>);
    }
    return event;
  });
}

export function registerConversionCommands(program: Command, getClient: () => MetaClient): void {
  const conversions = program.command('conversions').alias('conv').description('Conversions API and server-side tracking');

  conversions
    .command('send-event')
    .description('Send a server-side conversion event via the Conversions API')
    .requiredOption('--pixel-id <id>', 'Meta Pixel ID')
    .requiredOption('--event-name <name>', 'Event name (Purchase, Lead, CompleteRegistration, AddToCart, ViewContent, etc.)')
    .option('--event-time <timestamp>', 'Unix timestamp (defaults to now)')
    .option('--user-data <json>', 'User data JSON (em, ph, fn, ln, ... are normalized and SHA-256 hashed automatically; external_id, client_ip_address, fbp, fbc)')
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
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
      if (opts.userData) {
        const userData = JSON.parse(opts.userData);
        eventData.user_data = opts.hash ? hashUserData(userData) : userData;
      }
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
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
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
        if (opts.hash && event.user_data && typeof event.user_data === 'object') {
          event.user_data = hashUserData(event.user_data as Record<string, unknown>);
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

  // ── Offline Conversions (migrated) ────────────────────
  // Meta discontinued the Offline Conversions API (offline_conversion_data_sets,
  // {event_set}/events) in May 2025. Offline events now go to a dataset through
  // the Conversions API with action_source=physical_store.

  conversions
    .command('offline-events')
    .description('Send offline (in-store, phone) events to a dataset via the Conversions API (action_source=physical_store)')
    .option('--dataset-id <id>', 'Dataset (pixel) ID to send to')
    .option('--event-set-id <id>', 'Deprecated alias for --dataset-id')
    .requiredOption('--events <json>', 'JSON array of event objects')
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const datasetId = opts.datasetId || opts.eventSetId;
      if (!datasetId) throw new Error('--dataset-id is required (find yours with: meta-ads conversions datasets)');
      if (opts.eventSetId && !opts.datasetId) {
        console.error('Note: offline event sets were replaced by datasets. Sending to the dataset with this ID; use --dataset-id from now on.');
      }
      const client = getClient();
      const events = toPhysicalStoreEvents(JSON.parse(opts.events) as Array<Record<string, unknown>>, opts.hash);
      const response = await client.request(`${datasetId}/events`, {
        method: 'POST',
        body: { data: JSON.stringify(events) },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('offline-event-sets')
    .description('Deprecated: offline event sets were replaced by datasets. Lists datasets instead')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      console.error('Note: the Offline Conversions API was discontinued; listing datasets instead (meta-ads conversions datasets).');
      const client = getClient();
      const response = await client.request(`${opts.accountId}/datasets`, {
        params: { fields: 'id,name,description,creation_time,usage' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  conversions
    .command('create-offline-set')
    .description('Removed: offline event sets were replaced by datasets')
    .allowUnknownOption()
    .action(handleErrors(async () => {
      throw new Error(
        'Offline event sets can no longer be created: Meta discontinued the Offline Conversions API in May 2025. '
        + 'Use a dataset instead (create one in Events Manager, list them with: meta-ads conversions datasets), '
        + 'then send offline events with: meta-ads conversions offline-events --dataset-id <id> --events <json>',
      );
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
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (datasetId: string, opts) => {
      const client = getClient();
      const events = JSON.parse(opts.events) as Array<Record<string, unknown>>;
      if (opts.hash) {
        for (const event of events) {
          if (event.user_data && typeof event.user_data === 'object') {
            event.user_data = hashUserData(event.user_data as Record<string, unknown>);
          }
        }
      }
      const body: Record<string, string> = {
        data: JSON.stringify(events),
      };
      if (opts.testEventCode) body.test_event_code = opts.testEventCode;

      const response = await client.request(`${datasetId}/events`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
