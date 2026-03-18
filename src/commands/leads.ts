import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerLeadCommands(program: Command, getClient: () => MetaClient): void {
  const leads = program.command('leads').description('Lead form and lead management');

  leads
    .command('forms')
    .description('List lead forms for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--page-id <id>', 'Page ID to list forms for')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      let endpoint: string;
      if (opts.pageId) {
        endpoint = `${opts.pageId}/leadgen_forms`;
      } else if (opts.accountId) {
        endpoint = `${opts.accountId}/leadgen_forms`;
      } else {
        throw new Error('Either --account-id or --page-id required');
      }

      const params: Record<string, string> = {
        fields: 'id,name,status,leads_count,created_time',
      };

      const response = await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('get <formId>')
    .description('Get leads from a lead form')
    .option('--limit <n>', 'Maximum leads to return', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name',
        limit: opts.limit,
      };

      const endpoint = `${formId}/leads`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('create-form')
    .description('Create a new lead form')
    .requiredOption('--page-id <id>', 'Page ID')
    .requiredOption('--name <name>', 'Form name')
    .option('--questions <json>', 'Questions as JSON array')
    .option('--privacy-policy-url <url>', 'Privacy policy URL')
    .option('--thank-you-page-url <url>', 'Thank you page URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.questions) body.questions = opts.questions;
      if (opts.privacyPolicyUrl) {
        body.privacy_policy = JSON.stringify({ url: opts.privacyPolicyUrl });
      }
      if (opts.thankYouPageUrl) {
        body.thank_you_page = JSON.stringify({ url: opts.thankYouPageUrl });
      }

      const response = await client.request(`${opts.pageId}/leadgen_forms`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('export <formId>')
    .description('Export all leads from a form (fetches all pages)')
    .option('-o, --output <format>', 'Output format (csv recommended for export)', 'csv')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name',
        limit: '500',
      };

      const response = await client.requestAllPages(`${formId}/leads`, { params }, 50);
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('quality <formId>')
    .description('Analyze lead quality for a form')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();

      // Get leads
      const params: Record<string, string> = {
        fields: 'id,created_time,field_data,ad_id,ad_name,campaign_id',
        limit: '100',
      };
      const response = await client.request(`${formId}/leads`, { params });
      const leads = (response.data as Record<string, unknown>).data as Array<Record<string, unknown>> || [];

      // Analyze completeness
      let totalFields = 0;
      let filledFields = 0;
      const fieldCompleteness: Record<string, { total: number; filled: number }> = {};

      for (const lead of leads) {
        const fieldData = lead.field_data as Array<Record<string, unknown>> || [];
        for (const field of fieldData) {
          const name = String(field.name || 'unknown');
          if (!fieldCompleteness[name]) fieldCompleteness[name] = { total: 0, filled: 0 };
          fieldCompleteness[name].total++;
          totalFields++;
          if (field.values && (field.values as string[]).length > 0 && (field.values as string[])[0]) {
            fieldCompleteness[name].filled++;
            filledFields++;
          }
        }
      }

      console.log(formatOutput({
        form_id: formId,
        total_leads: leads.length,
        overall_completeness: totalFields > 0 ? `${((filledFields / totalFields) * 100).toFixed(1)}%` : 'N/A',
        field_analysis: Object.entries(fieldCompleteness).map(([name, stats]) => ({
          field: name,
          completeness: `${((stats.filled / stats.total) * 100).toFixed(0)}%`,
          filled: stats.filled,
          total: stats.total,
        })),
      }, opts.output as OutputFormat));
    }));

  leads
    .command('webhooks <formId>')
    .description('Setup webhooks for real-time lead notifications')
    .requiredOption('--url <url>', 'Webhook URL to receive lead notifications')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        object: 'page',
        callback_url: opts.url,
        fields: 'leadgen',
        verify_token: `meta_ads_cli_${Date.now()}`,
      };

      // Subscribe to leadgen webhooks
      const response = await client.request(`${formId}/subscriptions`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput({
        form_id: formId,
        webhook_url: opts.url,
        subscription: response.data,
      }, opts.output as OutputFormat));
    }));
}
