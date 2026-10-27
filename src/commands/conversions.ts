import { Command } from 'commander';
import crypto from 'crypto';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Normalizers shared by Conversions API user_data and customer-list uploads,
 * so the same person hashes the same way in both (and match rates line up).
 * Names and cities keep Unicode letters (Meta hashes UTF-8: "München" stays
 * "münchen", it doesn't become "mnchen").
 */
export const normalizePii = {
  email: (v: string) => v.trim().toLowerCase(),
  phone: (v: string) => v.replace(/\D/g, '').replace(/^0+/, ''),
  name: (v: string) => v.trim().toLowerCase().replace(/[^\p{L}]/gu, ''),
  city: (v: string) => v.trim().toLowerCase().replace(/[^\p{L}]/gu, ''),
  state: (v: string) => v.toLowerCase().replace(/[^a-z]/g, ''),
  zip: (v: string) => v.toLowerCase().replace(/\s/g, ''),
  country: (v: string) => v.toLowerCase().replace(/[^a-z]/g, ''),
  digits: (v: string) => v.replace(/\D/g, ''),
  initial: (v: string) => v.trim().toLowerCase().charAt(0),
};

// Customer-information fields Meta requires to be normalized and SHA-256 hashed.
const PII_NORMALIZERS: Record<string, (v: string) => string> = {
  em: normalizePii.email,
  ph: normalizePii.phone,
  fn: normalizePii.name,
  ln: normalizePii.name,
  ct: normalizePii.city,
  st: normalizePii.state,
  zp: normalizePii.zip,
  db: normalizePii.digits,
  ge: normalizePii.initial,
  country: normalizePii.country,
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

// Meta accepts up to 1,000 events per Conversions API request.
export const CAPI_MAX_EVENTS_PER_REQUEST = 1000;

export interface EventOptions {
  ldu?: boolean;
  lduCountry?: string | number;
  lduState?: string | number;
}

/**
 * Apply per-event options: Limited Data Use (US state privacy laws) and
 * defaults. LDU country/state 0 lets Meta geolocate the event (needs
 * client_ip_address); 1/1000 means USA/California.
 */
export function applyEventOptions(event: Record<string, unknown>, opts: EventOptions): Record<string, unknown> {
  if (opts.ldu && event.data_processing_options === undefined) {
    event.data_processing_options = ['LDU'];
    event.data_processing_options_country = Number(opts.lduCountry ?? 0);
    event.data_processing_options_state = Number(opts.lduState ?? 0);
  }
  return event;
}

/**
 * Website events need an event_id shared with the pixel, or Meta can't
 * deduplicate browser and server copies and the conversion counts twice.
 * Returns how many website events are missing one.
 */
export function countMissingEventIds(events: Array<Record<string, unknown>>): number {
  return events.filter(e => (e.action_source ?? 'website') === 'website' && !e.event_id).length;
}

function warnMissingEventIds(events: Array<Record<string, unknown>>): void {
  const missing = countMissingEventIds(events);
  if (missing > 0) {
    console.error(
      `Warning: ${missing} website event(s) have no event_id. If the pixel also fires these events, Meta can't `
      + 'deduplicate them and conversions will be double counted. Send the same event_id (e.g. the order ID) from the pixel and the server.',
    );
  }
}

/** Split events into Conversions API-sized batches. */
export function chunkEvents<T>(events: T[], size = CAPI_MAX_EVENTS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

/** POST events to a pixel/dataset in batches of 1,000 and collect the responses. */
async function sendEvents(
  client: MetaClient,
  datasetId: string,
  events: Array<Record<string, unknown>>,
  testEventCode?: string,
): Promise<unknown> {
  if (events.length === 0) throw new Error('No events to send');
  const batches = chunkEvents(events);
  const results: unknown[] = [];
  for (const batch of batches) {
    const body: Record<string, string> = { data: JSON.stringify(batch) };
    if (testEventCode) body.test_event_code = testEventCode;
    const response = await client.request(`${datasetId}/events`, { method: 'POST', body });
    results.push(response.data);
  }
  return batches.length === 1 ? results[0] : { batches: batches.length, events: events.length, results };
}

const LDU_HELP = 'Flag events for Limited Data Use (US state privacy laws: data_processing_options=["LDU"])';

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
    .option('--action-source <source>', 'Action source (website, email, phone_call, chat, app, physical_store, system_generated, other)', 'website')
    .option('--event-id <id>', 'Deduplication ID; must match the eventID the pixel sends for the same event')
    .option('--order-id <id>', 'Order/transaction ID (custom_data.order_id); also used as event_id when --event-id is omitted')
    .option('--ldu', LDU_HELP)
    .option('--ldu-country <n>', 'LDU country: 0 = let Meta geolocate (needs client_ip_address), 1 = USA', '0')
    .option('--ldu-state <n>', 'LDU state: 0 = let Meta geolocate, 1000 = California', '0')
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
        const userData = parseJsonInput<Record<string, unknown>>(opts.userData, '--user-data');
        eventData.user_data = opts.hash ? hashUserData(userData) : userData;
      }
      if (opts.customData) eventData.custom_data = parseJsonInput(opts.customData, '--custom-data');
      if (opts.orderId) {
        eventData.custom_data = { ...((eventData.custom_data as Record<string, unknown>) || {}), order_id: opts.orderId };
      }
      const eventId = opts.eventId || opts.orderId;
      if (eventId) eventData.event_id = String(eventId);
      if (opts.eventSourceUrl) eventData.event_source_url = opts.eventSourceUrl;
      applyEventOptions(eventData, opts);
      warnMissingEventIds([eventData]);

      const data = await sendEvents(client, opts.pixelId, [eventData], opts.testEventCode);
      console.log(formatOutput(data, opts.output as OutputFormat));
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
    .requiredOption('--rule <json>', 'Conversion rule as JSON (inline, @file or - for stdin)')
    .option('--event-type <type>', 'Custom event type (e.g., PURCHASE, LEAD)')
    .option('--default-value <value>', 'Default conversion value')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        pixel: opts.pixelId,
        rule: JSON.stringify(parseJsonInput(opts.rule, '--rule')),
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
    .requiredOption('--events <json>', 'JSON array of event objects [{event_name, event_time, event_id, user_data, custom_data}, ...] (inline, @file or -); sent in batches of 1,000')
    .option('--test-event-code <code>', 'Test event code from Events Manager')
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
    .option('--ldu', `${LDU_HELP}, for events that don't set data_processing_options`)
    .option('--ldu-country <n>', 'LDU country: 0 = geolocate, 1 = USA', '0')
    .option('--ldu-state <n>', 'LDU state: 0 = geolocate, 1000 = California', '0')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const events = parseEventsArray(opts.events);

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
        applyEventOptions(event, opts);
      }
      warnMissingEventIds(events);

      const data = await sendEvents(client, opts.pixelId, events, opts.testEventCode);
      console.log(formatOutput(data, opts.output as OutputFormat));
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
    .requiredOption('--events <json>', 'JSON array of event objects (inline, @file or -)')
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
    .option('--ldu', LDU_HELP)
    .option('--ldu-country <n>', 'LDU country: 0 = geolocate, 1 = USA', '0')
    .option('--ldu-state <n>', 'LDU state: 0 = geolocate, 1000 = California', '0')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const datasetId = opts.datasetId || opts.eventSetId;
      if (!datasetId) throw new Error('--dataset-id is required (find yours with: meta-ads conversions datasets)');
      if (opts.eventSetId && !opts.datasetId) {
        console.error('Note: offline event sets were replaced by datasets. Sending to the dataset with this ID; use --dataset-id from now on.');
      }
      const client = getClient();
      const events = toPhysicalStoreEvents(parseEventsArray(opts.events), opts.hash)
        .map(e => applyEventOptions(e, opts));
      const data = await sendEvents(client, datasetId, events);
      console.log(formatOutput(data, opts.output as OutputFormat));
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

  conversions
    .command('quality <datasetId>')
    .description('Event Match Quality, coverage, deduplication and freshness per event (Dataset Quality API)')
    .option('--agent-name <name>', 'Only count events sent with this partner_agent')
    .option('--raw', 'Print the full API response instead of the per-event summary')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (datasetId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        dataset_id: datasetId,
        fields: DATASET_QUALITY_FIELDS,
      };
      if (opts.agentName) params.agent_name = opts.agentName;
      const response = await client.request('dataset_quality', { params });
      console.log(formatOutput(opts.raw ? response.data : summarizeDatasetQuality(response.data), opts.output as OutputFormat));
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
    .requiredOption('--events <json>', 'JSON array of event objects (inline, @file or -); sent in batches of 1,000')
    .option('--test-event-code <code>', 'Test event code')
    .option('--no-hash', 'Send user_data as given (values are already normalized and hashed)')
    .option('--ldu', LDU_HELP)
    .option('--ldu-country <n>', 'LDU country: 0 = geolocate, 1 = USA', '0')
    .option('--ldu-state <n>', 'LDU state: 0 = geolocate, 1000 = California', '0')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (datasetId: string, opts) => {
      const client = getClient();
      const events = parseEventsArray(opts.events);
      for (const event of events) {
        if (opts.hash && event.user_data && typeof event.user_data === 'object') {
          event.user_data = hashUserData(event.user_data as Record<string, unknown>);
        }
        applyEventOptions(event, opts);
      }
      warnMissingEventIds(events);
      const data = await sendEvents(client, datasetId, events, opts.testEventCode);
      console.log(formatOutput(data, opts.output as OutputFormat));
    }));
}

function parseEventsArray(value: string): Array<Record<string, unknown>> {
  const events = parseJsonInput<unknown>(value, '--events');
  if (!Array.isArray(events)) throw new Error('--events must be a JSON array of event objects');
  return events as Array<Record<string, unknown>>;
}

export const DATASET_QUALITY_FIELDS = 'web{event_name,event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}}},'
  + 'event_coverage{percentage,goal_percentage,description},dedupe_key_feedback{dedupe_key,browser_events_with_dedupe_key{percentage},server_events_with_dedupe_key{percentage}},'
  + 'data_freshness{upload_frequency,description},acr{percentage,description}}';

/** One row per event from a Dataset Quality API response. */
export function summarizeDatasetQuality(data: unknown): Array<Record<string, unknown>> {
  const web = ((data as Record<string, unknown>)?.web ?? []) as Array<Record<string, any>>;
  return web.map((e) => {
    const keys = (e.event_match_quality?.match_key_feedback ?? []) as Array<Record<string, any>>;
    const dedupe = (e.dedupe_key_feedback ?? []) as Array<Record<string, any>>;
    return {
      event_name: e.event_name,
      emq_score: e.event_match_quality?.composite_score ?? null,
      match_keys: keys.map(k => `${k.identifier}:${k.coverage?.percentage ?? '?'}%`).join(', '),
      server_coverage_pct: e.event_coverage?.percentage ?? null,
      coverage_goal_pct: e.event_coverage?.goal_percentage ?? null,
      dedupe_keys: dedupe.map(d => d.dedupe_key).filter(Boolean).join(', '),
      upload_frequency: e.data_freshness?.upload_frequency ?? null,
      acr_pct: e.acr?.percentage ?? null,
    };
  });
}
