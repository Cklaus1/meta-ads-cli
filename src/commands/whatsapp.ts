import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

/** Build a Graph field-expansion string, e.g. pricing_analytics.start(1).end(2).dimensions(A,B). */
export function fieldExpansion(field: string, args: Record<string, string | string[] | undefined>): string {
  let out = field;
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0) || v === '') continue;
    out += `.${k}(${Array.isArray(v) ? v.join(',') : v})`;
  }
  return out;
}

const ONE_YEAR_SEC = 365 * 86400;

/**
 * Validate a Unix-timestamp range for WhatsApp analytics. Meta limits
 * messaging, conversation and pricing analytics to a 1-year lookback
 * (since 2025-12-01).
 */
export function validateAnalyticsRange(start: string, end: string, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) throw new Error('--start and --end must be Unix timestamps in seconds');
  if (Number(end) <= Number(start)) throw new Error('--end must be after --start');
  if (Number(start) < nowSec - ONE_YEAR_SEC) {
    throw new Error('--start is more than 1 year ago; Meta limits WhatsApp analytics to a 1-year lookback.');
  }
}

function list(value: unknown): string[] | undefined {
  if (!value) return undefined;
  return String(value).split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
}

export function registerWhatsAppCommands(program: Command, getClient: () => MetaClient): void {
  const wa = program.command('whatsapp').alias('wa').description('WhatsApp Business: messaging, templates, analytics');

  // ── Profile & Phone Numbers ───────────────────────────

  wa
    .command('profile <phoneNumberId>')
    .description('Get or update WhatsApp Business profile')
    .option('--update-about <text>', 'Update about text')
    .option('--update-address <text>', 'Update business address')
    .option('--update-description <text>', 'Update business description')
    .option('--update-email <email>', 'Update business email')
    .option('--update-website <url>', 'Update website URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (phoneNumberId: string, opts) => {
      const client = getClient();
      if (opts.updateAbout || opts.updateAddress || opts.updateDescription || opts.updateEmail || opts.updateWebsite) {
        const body: Record<string, string> = {};
        if (opts.updateAbout) body.about = opts.updateAbout;
        if (opts.updateAddress) body.address = opts.updateAddress;
        if (opts.updateDescription) body.description = opts.updateDescription;
        if (opts.updateEmail) body.email = opts.updateEmail;
        if (opts.updateWebsite) body.websites = JSON.stringify([opts.updateWebsite]);
        const response = await client.request(`${phoneNumberId}/whatsapp_business_profile`, { method: 'POST', body });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      } else {
        const response = await client.request(`${phoneNumberId}/whatsapp_business_profile`, {
          params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
        });
        console.log(formatOutput(response.data, opts.output as OutputFormat));
      }
    }));

  wa
    .command('phone-numbers <wabaId>')
    .description('List phone numbers for a WhatsApp Business Account')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${wabaId}/phone_numbers`, {
        params: { fields: 'id,display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Messaging ─────────────────────────────────────────

  wa
    .command('send-text <phoneNumberId>')
    .description('Send a text message')
    .requiredOption('--to <number>', 'Recipient phone number (with country code, e.g., 14155551234)')
    .requiredOption('--message <text>', 'Message text')
    .option('--preview-url', 'Enable URL preview in message')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (phoneNumberId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'text',
        text: JSON.stringify({ body: opts.message, preview_url: !!opts.previewUrl }),
      };
      const response = await client.request(`${phoneNumberId}/messages`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('send-template <phoneNumberId>')
    .description('Send a template message')
    .requiredOption('--to <number>', 'Recipient phone number')
    .requiredOption('--template-name <name>', 'Template name')
    .option('--language <code>', 'Language code', 'en_US')
    .option('--components <json>', 'Template components as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (phoneNumberId: string, opts) => {
      const client = getClient();
      const template: Record<string, unknown> = {
        name: opts.templateName,
        language: { code: opts.language },
      };
      if (opts.components) template.components = parseJsonInput(opts.components, '--components');

      const body: Record<string, string> = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'template',
        template: JSON.stringify(template),
      };
      const response = await client.request(`${phoneNumberId}/messages`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('send-media <phoneNumberId>')
    .description('Send an image, video, document, or audio message')
    .requiredOption('--to <number>', 'Recipient phone number')
    .requiredOption('--type <type>', 'Media type: image, video, document, audio')
    .requiredOption('--url <url>', 'Media URL')
    .option('--caption <text>', 'Media caption')
    .option('--filename <name>', 'Filename for documents')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (phoneNumberId: string, opts) => {
      const client = getClient();
      const mediaObj: Record<string, string> = { link: opts.url };
      if (opts.caption) mediaObj.caption = opts.caption;
      if (opts.filename) mediaObj.filename = opts.filename;

      const body: Record<string, string> = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: opts.type,
        [opts.type]: JSON.stringify(mediaObj),
      };
      const response = await client.request(`${phoneNumberId}/messages`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('send-interactive <phoneNumberId>')
    .description('Send an interactive message (buttons, lists)')
    .requiredOption('--to <number>', 'Recipient phone number')
    .requiredOption('--interactive <json>', 'Interactive message spec as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (phoneNumberId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'interactive',
        interactive: opts.interactive,
      };
      const response = await client.request(`${phoneNumberId}/messages`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Templates ─────────────────────────────────────────

  wa
    .command('templates <wabaId>')
    .description('List message templates')
    .option('--status <status>', 'Filter by status: APPROVED, PENDING, REJECTED')
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,status,category,language,components,quality_score',
        limit: opts.limit,
      };
      if (opts.status) params.status = opts.status;
      const endpoint = `${wabaId}/message_templates`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('create-template <wabaId>')
    .description('Create a message template')
    .requiredOption('--name <name>', 'Template name (lowercase, underscores)')
    .requiredOption('--category <category>', 'Category: MARKETING, UTILITY, AUTHENTICATION')
    .requiredOption('--language <code>', 'Language code (e.g., en_US)')
    .requiredOption('--components <json>', 'Components as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
        category: opts.category,
        language: opts.language,
        components: opts.components,
      };
      const response = await client.request(`${wabaId}/message_templates`, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('delete-template <wabaId>')
    .description('Delete a message template')
    .requiredOption('--name <name>', 'Template name to delete')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${wabaId}/message_templates`, {
        method: 'DELETE',
        params: { name: opts.name },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // ── Analytics ─────────────────────────────────────────

  wa
    .command('analytics <wabaId>')
    .description('Get WhatsApp Business Account analytics')
    .requiredOption('--start <timestamp>', 'Start Unix timestamp')
    .requiredOption('--end <timestamp>', 'End Unix timestamp')
    .option('--granularity <g>', 'Granularity: HALF_HOUR, DAY, MONTH', 'DAY')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      validateAnalyticsRange(opts.start, opts.end);
      // Messaging analytics uses DAY/MONTH (not DAILY/MONTHLY); accept either.
      const granularity = ({ DAILY: 'DAY', MONTHLY: 'MONTH' } as Record<string, string>)[String(opts.granularity).toUpperCase()]
        || String(opts.granularity).toUpperCase();
      const client = getClient();
      const fields = fieldExpansion('analytics', { start: opts.start, end: opts.end, granularity });
      const response = await client.request(wabaId, { params: { fields } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('conversation-analytics <wabaId>')
    .description('Legacy: conversation-based analytics. Billing is per message since 2025-07-01; prefer pricing-analytics')
    .requiredOption('--start <timestamp>', 'Start Unix timestamp')
    .requiredOption('--end <timestamp>', 'End Unix timestamp')
    .option('--granularity <g>', 'Granularity: HALF_HOUR, DAILY, MONTHLY', 'DAILY')
    .option('--dimension <dims>', 'Comma-separated dimensions: CONVERSATION_CATEGORY, CONVERSATION_TYPE, COUNTRY, PHONE')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      validateAnalyticsRange(opts.start, opts.end);
      const client = getClient();
      const fields = fieldExpansion('conversation_analytics', {
        start: opts.start,
        end: opts.end,
        granularity: String(opts.granularity).toUpperCase(),
        dimensions: list(opts.dimension),
      });
      const response = await client.request(wabaId, { params: { fields } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('pricing-analytics <wabaId>')
    .description('Per-message pricing analytics: cost and volume by pricing category/type (replaces conversation analytics)')
    .requiredOption('--start <timestamp>', 'Start Unix timestamp (within the last year)')
    .requiredOption('--end <timestamp>', 'End Unix timestamp')
    .option('--granularity <g>', 'Granularity: HALF_HOUR, DAILY, MONTHLY', 'DAILY')
    .option('--dimensions <dims>', 'Comma-separated breakdowns: COUNTRY, PHONE, PRICING_CATEGORY, PRICING_TYPE, TIER', 'PRICING_CATEGORY,PRICING_TYPE')
    .option('--metric-types <types>', 'COST and/or VOLUME (default: both)')
    .option('--pricing-categories <cats>', 'Filter: AUTHENTICATION, AUTHENTICATION_INTERNATIONAL, MARKETING, MARKETING_LITE, SERVICE, UTILITY, REFERRAL_CONVERSION')
    .option('--pricing-types <types>', 'Filter: FREE_CUSTOMER_SERVICE, FREE_ENTRY_POINT, REGULAR')
    .option('--phone-numbers <numbers>', 'Filter: comma-separated business phone numbers')
    .option('--country-codes <codes>', 'Filter: comma-separated 2-letter country codes')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      validateAnalyticsRange(opts.start, opts.end);
      const granularity = String(opts.granularity).toUpperCase();
      if (!['HALF_HOUR', 'DAILY', 'MONTHLY'].includes(granularity)) {
        throw new Error('--granularity must be HALF_HOUR, DAILY or MONTHLY');
      }
      const client = getClient();
      const fields = fieldExpansion('pricing_analytics', {
        start: opts.start,
        end: opts.end,
        granularity,
        phone_numbers: opts.phoneNumbers ? String(opts.phoneNumbers).split(',').map((v: string) => v.trim()) : undefined,
        country_codes: list(opts.countryCodes),
        metric_types: list(opts.metricTypes),
        pricing_types: list(opts.pricingTypes),
        pricing_categories: list(opts.pricingCategories),
        dimensions: list(opts.dimensions),
      });
      const response = await client.request(wabaId, { params: { fields } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
