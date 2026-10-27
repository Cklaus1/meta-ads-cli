import { Command } from 'commander';
import fs from 'fs';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { parseCsv } from './audiences.js';
import { hashUserData } from './conversions.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/**
 * Turn each lead's field_data ([{name, values}]) into one column per field,
 * joining multiple values with ';'. Every row gets every field column, so
 * CSV/table headers line up even when leads answered different questions.
 */
export function pivotLeads(leads: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const fieldNames: string[] = [];
  const pivoted = leads.map(lead => {
    const { field_data: fieldData, ...rest } = lead;
    const answers: Record<string, string> = {};
    if (Array.isArray(fieldData)) {
      for (const f of fieldData as Array<{ name?: string; values?: unknown[] }>) {
        if (!f?.name) continue;
        if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
        answers[f.name] = (f.values || []).map(String).join(';');
      }
    }
    return { rest, answers };
  });
  return pivoted.map(({ rest, answers }) => {
    const row: Record<string, unknown> = { ...rest };
    for (const name of fieldNames) {
      // Don't let a form field named e.g. "id" overwrite lead metadata.
      row[name in rest ? `field_${name}` : name] = answers[name] ?? '';
    }
    return row;
  });
}

/** Lead fields for export/sync, including source attribution metadata. */
export const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform';

/** Parse --since/--until (ISO date/time or Unix seconds) to Unix seconds. */
export function toUnixSeconds(value: string, flag: string): number {
  const v = String(value).trim();
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`${flag} must be an ISO date/time (2026-10-26 or 2026-10-26T00:00:00Z) or Unix seconds, got "${value}"`);
  return Math.floor(ms / 1000);
}

/** Graph API filtering for leads created after/before a time. */
export function leadTimeFilter(since?: string, until?: string): Record<string, string> {
  const filters: Array<Record<string, unknown>> = [];
  if (since) filters.push({ field: 'time_created', operator: 'GREATER_THAN', value: toUnixSeconds(since, '--since') });
  if (until) filters.push({ field: 'time_created', operator: 'LESS_THAN', value: toUnixSeconds(until, '--until') });
  return filters.length ? { filtering: JSON.stringify(filters) } : {};
}

/**
 * Build a Conversions API event for a CRM lead stage (Conversion Leads
 * optimization): lead_id in user_data, action_source system_generated, and
 * custom_data.event_source=crm with the CRM's name as lead_event_source.
 */
export function buildCrmLeadEvent(o: {
  leadId: string; stage: string; eventTime?: number | string; crmName: string; userData?: Record<string, unknown>; hash?: boolean;
}): Record<string, unknown> {
  if (!/^\d{6,20}$/.test(String(o.leadId))) throw new Error(`Invalid lead ID "${o.leadId}" (expected Meta's numeric lead ID)`);
  if (!o.stage) throw new Error('A lead stage (event name) is required');
  const time = o.eventTime !== undefined && o.eventTime !== '' ? toUnixSeconds(String(o.eventTime), 'event_time') : Math.floor(Date.now() / 1000);
  const extra = o.userData ? (o.hash === false ? o.userData : hashUserData(o.userData)) : {};
  return {
    event_name: o.stage,
    event_time: time,
    action_source: 'system_generated',
    user_data: { ...extra, lead_id: o.leadId },
    custom_data: { event_source: 'crm', lead_event_source: o.crmName },
  };
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
    .option('--since <time>', 'Only leads created after this time (ISO or Unix seconds)')
    .option('--until <time>', 'Only leads created before this time (ISO or Unix seconds)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: LEAD_FIELDS,
        limit: opts.limit,
        ...leadTimeFilter(opts.since, opts.until),
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
    .option('--questions <json>', 'Questions as JSON array (inline, @file or -)')
    .option('--privacy-policy-url <url>', 'Privacy policy URL')
    .option('--thank-you-page-url <url>', 'Thank you page URL')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.questions) body.questions = JSON.stringify(parseJsonInput(opts.questions, '--questions'));
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
    .command('update-form <formId>')
    .description('Update a lead form')
    .option('--name <name>', 'New form name')
    .option('--status <status>', 'New status (ACTIVE, ARCHIVED)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};

      if (opts.name) body.name = opts.name;
      if (opts.status) body.status = opts.status;

      if (Object.keys(body).length === 0) {
        throw new Error('No update parameters provided');
      }

      const response = await client.request(formId, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('delete-form <formId>')
    .description('Archive/delete a lead form')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const response = await client.request(formId, {
        method: 'POST',
        body: { status: 'ARCHIVED' },
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  leads
    .command('export <formId>')
    .description('Export leads from a form, one column per answer (fetches all pages). Use --since for incremental CRM syncs')
    .option('--since <time>', 'Only leads created after this time (ISO or Unix seconds), e.g. the last sync time')
    .option('--until <time>', 'Only leads created before this time')
    .option('-o, --output <format>', 'Output format (csv recommended for export)', 'csv')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: LEAD_FIELDS,
        limit: '500',
        ...leadTimeFilter(opts.since, opts.until),
      };

      const response = await client.requestAllPages(`${formId}/leads`, { params }, 50);
      const rows = (response.data as Record<string, unknown>).data as Array<Record<string, unknown>> | undefined;
      console.log(formatOutput(rows ? pivotLeads(rows) : response.data, opts.output as OutputFormat));
    }));

  leads
    .command('quality <formId>')
    .description('Form field completeness for recent leads (not lead quality: send CRM outcomes with leads crm-event for that)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string, opts) => {
      const client = getClient();

      // Get leads
      const params: Record<string, string> = {
        fields: LEAD_FIELDS,
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
        note: 'This measures how fully forms were filled in, not whether leads are qualified. To optimize for qualified leads, '
          + 'send CRM stage changes with: meta-ads leads crm-event (Conversion Leads).',
      }, opts.output as OutputFormat));
    }));

  leads
    .command('crm-event')
    .description('Send CRM lead stage changes to a CRM dataset (Conversion Leads): one event or a CSV of lead_id,stage[,event_time]')
    .requiredOption('--dataset-id <id>', 'CRM dataset ID (set up for Conversion Leads in Events Manager)')
    .option('--lead-id <id>', 'Meta lead ID (15-17 digits)')
    .option('--stage <name>', 'Lead stage / event name as defined in your CRM, e.g. "Qualified"')
    .option('--event-time <time>', 'When the lead reached the stage (ISO or Unix seconds; default now). Must be after the lead was created')
    .option('--file <path>', 'CSV with columns lead_id,stage and optional event_time (header row required)')
    .requiredOption('--crm-name <name>', 'Your CRM name (lead_event_source), e.g. Salesforce, HubSpot')
    .option('--user-data <json>', 'Extra user_data (em, ph, ...) for leads without a lead ID; hashed automatically (inline, @file or -)')
    .option('--no-hash', 'Send --user-data as given (already hashed)')
    .option('--test-event-code <code>', 'Test event code from Events Manager')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const userData = opts.userData ? parseJsonInput<Record<string, unknown>>(opts.userData, '--user-data') : undefined;
      const events: Array<Record<string, unknown>> = [];
      if (opts.file) {
        const rows = parseCsv(fs.readFileSync(opts.file, 'utf8').replace(/^\uFEFF/, ''));
        const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
        const col = (name: string) => header.indexOf(name);
        if (col('lead_id') < 0 || col('stage') < 0) throw new Error(`${opts.file} needs a header row with lead_id and stage columns`);
        for (const row of rows) {
          events.push(buildCrmLeadEvent({
            leadId: row[col('lead_id')].trim(),
            stage: row[col('stage')].trim(),
            eventTime: col('event_time') >= 0 ? row[col('event_time')]?.trim() : undefined,
            crmName: opts.crmName,
          }));
        }
      } else {
        if (!opts.leadId || !opts.stage) throw new Error('Pass --lead-id and --stage, or --file with lead_id,stage columns');
        events.push(buildCrmLeadEvent({
          leadId: opts.leadId, stage: opts.stage, eventTime: opts.eventTime, crmName: opts.crmName, userData, hash: opts.hash,
        }));
      }

      const results: unknown[] = [];
      for (let i = 0; i < events.length; i += 1000) {
        const body: Record<string, string> = { data: JSON.stringify(events.slice(i, i + 1000)) };
        if (opts.testEventCode) body.test_event_code = opts.testEventCode;
        const response = await client.request(`${opts.datasetId}/events`, { method: 'POST', body });
        results.push(response.data);
      }
      console.log(formatOutput(results.length === 1 ? results[0] : { events: events.length, results }, opts.output as OutputFormat));
    }));

  leads
    .command('webhooks [formId]')
    .description('Set up real-time lead webhooks: subscribe your app to leadgen and the Page to your app (receive them with: webhooks listen --leads-csv)')
    .requiredOption('--app-id <id>', 'Your Meta app ID')
    .requiredOption('--page-id <id>', 'Page that owns the lead forms')
    .requiredOption('--url <url>', 'HTTPS callback URL that receives the webhooks')
    .requiredOption('--verify-token <token>', 'Token Meta echoes back during verification (pass the same one to webhooks listen)')
    .option('--app-access-token <token>', 'App access token (app_id|app_secret) for the app subscription; default: built from META_ADS_CLI_APP_ID/SECRET')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (formId: string | undefined, opts) => {
      const client = getClient();
      if (formId) console.error('Note: leadgen webhooks are per Page, not per form; the form ID is ignored.');
      const appSecret = process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET;
      const appToken = opts.appAccessToken || (appSecret ? `${opts.appId}|${appSecret}` : undefined);
      if (!appToken && !client.isDryRun()) {
        throw new Error('App subscriptions need an app access token: pass --app-access-token or set META_ADS_CLI_APP_SECRET.');
      }
      // 1. App-level subscription to the page object's leadgen field.
      const appSub = await client.request(`${opts.appId}/subscriptions`, {
        method: 'POST',
        body: { object: 'page', callback_url: opts.url, fields: 'leadgen', verify_token: opts.verifyToken },
        accessToken: appToken,
      });
      // 2. Install the app on the Page for leadgen (needs a Page token).
      const pageToken = await client.getPageToken(opts.pageId);
      const pageSub = await client.request(`${opts.pageId}/subscribed_apps`, {
        method: 'POST',
        body: { subscribed_fields: 'leadgen' },
        accessToken: pageToken,
      });

      console.log(formatOutput({
        page_id: opts.pageId,
        webhook_url: opts.url,
        app_subscription: appSub.data,
        page_subscription: pageSub.data,
      }, opts.output as OutputFormat));
    }));
}
