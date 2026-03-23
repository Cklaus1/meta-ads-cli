import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

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
      if (opts.components) template.components = JSON.parse(opts.components);

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
    .option('--granularity <g>', 'Granularity: HALF_HOUR, DAILY, MONTHLY', 'DAILY')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        start: opts.start,
        end: opts.end,
        granularity: opts.granularity,
      };
      const response = await client.request(`${wabaId}/analytics`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wa
    .command('conversation-analytics <wabaId>')
    .description('Get conversation-level analytics (costs, volumes)')
    .requiredOption('--start <timestamp>', 'Start Unix timestamp')
    .requiredOption('--end <timestamp>', 'End Unix timestamp')
    .option('--granularity <g>', 'Granularity: HALF_HOUR, DAILY, MONTHLY', 'DAILY')
    .option('--dimension <dim>', 'Dimension: CONVERSATION, PHONE, COUNTRY')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (wabaId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        start: opts.start,
        end: opts.end,
        granularity: opts.granularity,
      };
      if (opts.dimension) params.conversation_directions = opts.dimension;
      const response = await client.request(`${wabaId}/conversation_analytics`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
