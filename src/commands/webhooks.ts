import { Command } from 'commander';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { LEAD_FIELDS, pivotLeads } from './leads.js';
import { parseCsv } from './audiences.js';

/** Check Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Leadgen IDs (and page/form IDs) from a webhook payload. */
export function extractLeadgenEvents(payload: unknown): Array<{ leadgenId: string; pageId?: string; formId?: string }> {
  const out: Array<{ leadgenId: string; pageId?: string; formId?: string }> = [];
  const entries = ((payload as Record<string, unknown>)?.entry ?? []) as Array<Record<string, unknown>>;
  for (const entry of entries) {
    for (const change of ((entry.changes ?? []) as Array<Record<string, any>>)) {
      if (change.field === 'leadgen' && change.value?.leadgen_id) {
        out.push({ leadgenId: String(change.value.leadgen_id), pageId: change.value.page_id, formId: change.value.form_id });
      }
    }
  }
  return out;
}

/** Lead IDs already in a leads CSV (its "id" column), so redelivered leads aren't appended twice. */
export function leadIdsInCsv(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const header = rows.shift() ?? [];
  const col = header.indexOf('id');
  return new Set(col === -1 ? [] : rows.map(r => r[col]).filter(Boolean));
}

/**
 * Append one lead row to a CSV, writing the header first if the file is new.
 * Returns false (and appends nothing) when the lead's ID is already in `seen`,
 * since Meta retries webhook deliveries.
 */
export function appendLeadCsv(file: string, lead: Record<string, unknown>, seen?: Set<string>): boolean {
  const row = pivotLeads([lead])[0];
  const id = row.id === undefined ? undefined : String(row.id);
  if (id && seen?.has(id)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.writeFileSync(file, formatOutput([row], 'csv') + '\n');
    if (id) seen?.add(id);
    return true;
  }
  // Keep the existing column order; answers to fields not in the header are dropped.
  // Parse the header as CSV so quoted names containing commas stay aligned.
  const firstLine = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  const header = parseCsv(firstLine)[0] ?? [];
  const missing = Object.keys(row).filter(k => !header.includes(k));
  if (missing.length) console.error(`Warning: lead ${row.id} has fields not in ${file}'s header, skipped: ${missing.join(', ')}`);
  const ordered: Record<string, unknown> = {};
  for (const h of header) ordered[h] = row[h] ?? '';
  const csv = formatOutput([ordered], 'csv');
  fs.appendFileSync(file, csv.slice(csv.indexOf('\n') + 1) + '\n');
  if (id) seen?.add(id);
  return true;
}

export interface WebhookListenerOptions {
  verifyToken: string;
  appSecret?: string;
  /** Called with each verified event payload. */
  onEvent: (payload: unknown) => void | Promise<void>;
}

/**
 * HTTP handler for Meta webhooks: answers the GET verification handshake and
 * accepts POSTed events only with a valid X-Hub-Signature-256.
 */
export function createWebhookHandler(o: WebhookListenerOptions): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === o.verifyToken) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(url.searchParams.get('hub.challenge') || '');
      } else {
        res.writeHead(403);
        res.end('Forbidden');
      }
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (o.appSecret && !verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, o.appSecret)) {
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }
      // Acknowledge right away; Meta retries slow or failed deliveries.
      res.writeHead(200);
      res.end('OK');
      Promise.resolve(o.onEvent(payload)).catch(err => console.error(`Error handling webhook event: ${(err as Error).message}`));
    });
  };
}

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
      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/subscribed_apps`, {
        method: 'POST',
        body: { subscribed_fields: opts.fields },
        accessToken,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('page-unsubscribe <pageId>')
    .description('Unsubscribe a page from webhook events')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pageId: string, opts) => {
      const client = getClient();
      const accessToken = await client.getPageToken(pageId);
      const response = await client.request(`${pageId}/subscribed_apps`, { method: 'DELETE', accessToken });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  wh
    .command('listen')
    .description('Run a webhook receiver: answers Meta\'s verification handshake, checks signatures, prints events as JSON lines, and can stream new leads')
    .requiredOption('--verify-token <token>', 'The verify token you set on the subscription (webhooks subscribe --verify-token)')
    .option('--port <port>', 'Port to listen on', '8080')
    .option('--host <host>', 'Interface to bind', '0.0.0.0')
    .option('--app-secret <secret>', 'App secret for X-Hub-Signature-256 checks (default: META_ADS_CLI_APP_SECRET)')
    .option('--insecure-no-signature', 'Accept unsigned events (testing only)')
    .option('--leads-csv <file>', 'For leadgen events, fetch each lead and append it to this CSV')
    .option('--forward-url <url>', 'For leadgen events, POST each fetched lead as JSON to this URL (e.g. a CRM or Zapier hook)')
    .action(handleErrors(async (opts) => {
      const appSecret = opts.appSecret || process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET;
      if (!appSecret && !opts.insecureNoSignature) {
        throw new Error('An app secret is needed to verify event signatures. Pass --app-secret or set META_ADS_CLI_APP_SECRET (or --insecure-no-signature for local testing).');
      }
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a valid port number');
      const streamLeads = Boolean(opts.leadsCsv || opts.forwardUrl);
      const client = streamLeads ? getClient() : undefined;

      const seenLeads = opts.leadsCsv ? leadIdsInCsv(opts.leadsCsv) : new Set<string>();
      const handleLead = async (leadgenId: string) => {
        if (seenLeads.has(leadgenId)) {
          console.error(`Lead ${leadgenId} already saved; skipping redelivery`);
          return;
        }
        const response = await client!.request(leadgenId, { params: { fields: LEAD_FIELDS } });
        const lead = response.data as Record<string, unknown>;
        // In dry-run/plan the read returns a stub, not a lead: don't store or forward it.
        if (client!.isPreviewMode() || lead.dryRun || lead.planned) {
          console.error(`Preview mode: lead ${leadgenId} not saved or forwarded`);
          return;
        }
        if (opts.leadsCsv && !appendLeadCsv(opts.leadsCsv, lead, seenLeads)) return;
        if (!opts.leadsCsv) seenLeads.add(leadgenId);
        if (opts.forwardUrl) {
          const r = await fetch(opts.forwardUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pivotLeads([lead])[0]),
            signal: AbortSignal.timeout(30_000),
          });
          if (!r.ok) console.error(`Forwarding lead ${leadgenId} failed: HTTP ${r.status}`);
        }
        console.error(`Lead ${leadgenId} saved`);
      };

      const server = http.createServer(createWebhookHandler({
        verifyToken: opts.verifyToken,
        appSecret: opts.insecureNoSignature ? undefined : appSecret,
        onEvent: async (payload) => {
          console.log(JSON.stringify(payload));
          if (!streamLeads) return;
          for (const ev of extractLeadgenEvents(payload)) {
            try {
              await handleLead(ev.leadgenId);
            } catch (err) {
              console.error(`Could not fetch lead ${ev.leadgenId}: ${(err as Error).message}`);
            }
          }
        },
      }));
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, opts.host, () => {
          console.error(`Listening for Meta webhooks on http://${opts.host}:${port} (Ctrl+C to stop). Expose it over HTTPS (e.g. a tunnel) and use that URL as the callback.`);
          resolve();
        });
      });
      // Keep running until interrupted.
      await new Promise<void>(resolve => process.once('SIGINT', () => { server.close(); resolve(); }));
    }));
}
