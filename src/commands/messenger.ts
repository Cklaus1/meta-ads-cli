import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

// Meta removed these tags on 2026-04-27; sending them returns error 100.
const REMOVED_TAGS = new Set(['CONFIRMED_EVENT_UPDATE', 'POST_PURCHASE_UPDATE', 'ACCOUNT_UPDATE']);

/** Validate a message tag, rejecting the ones Meta no longer accepts. */
export function checkMessageTag(tag: string): string {
  const upper = tag.toUpperCase();
  if (REMOVED_TAGS.has(upper)) {
    throw new Error(
      `Message tag ${upper} was removed by Meta (April 2026). Use HUMAN_AGENT for human replies within 7 days, `
      + 'or send a utility message template for event, purchase and account updates.',
    );
  }
  return upper;
}

export function registerMessengerCommands(program: Command, getClient: () => MetaClient): void {
  const msg = program.command('messenger').description('Messenger: send messages, manage bots, sponsored messages');

  msg
    .command('send <pageId>')
    .description('Send a message to a user via Messenger')
    .requiredOption('--recipient-id <id>', 'Recipient PSID (Page-Scoped User ID)')
    .option('--text <message>', 'Text message to send')
    .option('--attachment <json>', 'Attachment payload as JSON (type, url)')
    .option('--quick-replies <json>', 'Quick replies as JSON array')
    .option('--tag <tag>', 'Message tag for replies outside the 24h window: HUMAN_AGENT')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const message: Record<string, unknown> = {};
      if (opts.text) message.text = opts.text;
      if (opts.attachment) message.attachment = parseJsonInput(opts.attachment, '--attachment');
      if (opts.quickReplies) message.quick_replies = parseJsonInput(opts.quickReplies, '--quick-replies');

      if (!message.text && !message.attachment) {
        throw new Error('Either --text or --attachment is required');
      }

      const body: Record<string, string> = {
        recipient: JSON.stringify({ id: opts.recipientId }),
        message: JSON.stringify(message),
        messaging_type: opts.tag ? 'MESSAGE_TAG' : 'RESPONSE',
      };
      if (opts.tag) body.tag = checkMessageTag(opts.tag);

      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/messages`, { method: 'POST', body, accessToken });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  msg
    .command('send-template <pageId>')
    .description('Send a structured template message (generic, button, receipt)')
    .requiredOption('--recipient-id <id>', 'Recipient PSID')
    .requiredOption('--template <json>', 'Template payload as JSON')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        recipient: JSON.stringify({ id: opts.recipientId }),
        message: JSON.stringify({
          attachment: {
            type: 'template',
            payload: parseJsonInput(opts.template, '--template'),
          },
        }),
        messaging_type: 'RESPONSE',
      };
      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/messages`, { method: 'POST', body, accessToken });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  msg
    .command('get-profile <pageId>')
    .description('Get Messenger profile settings (greeting, get_started, persistent_menu)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/messenger_profile`, {
        params: { fields: 'greeting,get_started,persistent_menu,ice_breakers,whitelisted_domains' },
        accessToken,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  msg
    .command('set-profile <pageId>')
    .description('Update Messenger profile settings')
    .option('--greeting <json>', 'Greeting text as JSON array [{locale, text}]')
    .option('--get-started <payload>', 'Get Started button payload string')
    .option('--persistent-menu <json>', 'Persistent menu as JSON array')
    .option('--ice-breakers <json>', 'Ice breaker questions as JSON array')
    .option('--whitelisted-domains <json>', 'Whitelisted domains as JSON array')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};
      if (opts.greeting) body.greeting = opts.greeting;
      if (opts.getStarted) body.get_started = JSON.stringify({ payload: opts.getStarted });
      if (opts.persistentMenu) body.persistent_menu = opts.persistentMenu;
      if (opts.iceBreakers) body.ice_breakers = opts.iceBreakers;
      if (opts.whitelistedDomains) body.whitelisted_domains = opts.whitelistedDomains;

      if (Object.keys(body).length === 0) throw new Error('No settings provided');

      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/messenger_profile`, { method: 'POST', body, accessToken });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  msg
    .command('conversations <pageId>')
    .description('List Messenger conversations for a page')
    .option('--limit <n>', 'Maximum conversations', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,updated_time,participants,message_count,unread_count,can_reply',
        limit: opts.limit,
      };
      const endpoint = `${pageId}/conversations`;
      const accessToken = await client.getPageToken(pageId);
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params, accessToken })
        : await client.request(endpoint, { params, accessToken });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  msg
    .command('messages <conversationId>')
    .description('List messages in a Messenger conversation')
    .option('--limit <n>', 'Maximum messages', '25')
    .requiredOption('--page-id <id>', 'Page that owns the conversation (its Page token is required)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (conversationId: string, opts) => {
      const client = getClient();
      const accessToken = await client.getPageToken(opts.pageId);
      const response = await client.request(`${conversationId}/messages`, {
        params: { fields: 'id,message,from,to,created_time,attachments', limit: opts.limit },
        accessToken,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
