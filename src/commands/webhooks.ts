import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerWebhookCommands(program: Command, getClient: () => MetaClient): void {
  const wh = program.command('webhooks').description('Webhook subscriptions for real-time notifications');

  wh
    .command('list <appId>')
    .description('List active webhook subscriptions for an app')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (appId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${appId}/subscriptions`, {
        params: { fields: 'object,callback_url,fields,active' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('subscribe <appId>')
    .description('Subscribe to webhook events')
    .requiredOption('--object <type>', 'Object type: page, ad_account, instagram, whatsapp_business_account, user')
    .requiredOption('--callback-url <url>', 'Webhook callback URL (HTTPS)')
    .requiredOption('--verify-token <token>', 'Verification token for handshake')
    .requiredOption('--fields <fields>', 'Comma-separated fields to subscribe to (e.g., leadgen,messages,feed)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (appId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${appId}/subscriptions`, {
        method: 'POST',
        body: {
          object: opts.object,
          callback_url: opts.callbackUrl,
          verify_token: opts.verifyToken,
          fields: opts.fields,
        },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('unsubscribe <appId>')
    .description('Unsubscribe from webhook events')
    .requiredOption('--object <type>', 'Object type to unsubscribe from')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (appId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${appId}/subscriptions`, {
        method: 'DELETE',
        params: { object: opts.object },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('page-subscribe <pageId>')
    .description('Subscribe a page to receive webhook events')
    .requiredOption('--fields <fields>', 'Comma-separated fields: feed,messages,leadgen,messaging_postbacks')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${pageId}/subscribed_apps`, {
        method: 'POST',
        body: { subscribed_fields: opts.fields },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('page-unsubscribe <pageId>')
    .description('Unsubscribe a page from webhook events')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${pageId}/subscribed_apps`, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
