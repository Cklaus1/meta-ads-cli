import { Command } from 'commander';
import crypto from 'crypto';
import fs from 'fs';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { parseJsonInput } from '../json-input.js';
import { normalizePii } from './conversions.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

// ── Customer lists ───────────────────────────────────────────────────────────

/** Meta's limit on users per /{audience_id}/users request. */
export const MAX_USERS_PER_REQUEST = 10_000;

export const CUSTOMER_FILE_SOURCES = ['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED'];

const pad2 = (v: string) => v.replace(/\D/g, '').padStart(2, '0');

// Per-key normalization before SHA-256 hashing (Meta's customer list rules).
// Keys mapped to null are sent as-is (not hashed).
const CUSTOMER_KEY_NORMALIZERS: Record<string, ((v: string) => string) | null> = {
  EMAIL: normalizePii.email,
  PHONE: normalizePii.phone,
  FN: normalizePii.name,
  LN: normalizePii.name,
  FI: normalizePii.initial,
  GEN: normalizePii.initial,
  DOBY: normalizePii.digits,
  DOBM: pad2,
  DOBD: pad2,
  CT: normalizePii.city,
  ST: normalizePii.state,
  ZIP: normalizePii.zip,
  COUNTRY: normalizePii.country,
  MADID: null,
  EXTERN_ID: null,
  LOOKALIKE_VALUE: null,
};

// CSV header names (lowercased) accepted for each schema key.
const HEADER_ALIASES: Record<string, string> = {
  email: 'EMAIL', em: 'EMAIL', e_mail: 'EMAIL',
  phone: 'PHONE', ph: 'PHONE', phone_number: 'PHONE',
  fn: 'FN', first_name: 'FN', firstname: 'FN',
  ln: 'LN', last_name: 'LN', lastname: 'LN',
  fi: 'FI', gen: 'GEN', gender: 'GEN',
  doby: 'DOBY', dobm: 'DOBM', dobd: 'DOBD',
  ct: 'CT', city: 'CT', st: 'ST', state: 'ST',
  zip: 'ZIP', zip_code: 'ZIP', postal_code: 'ZIP',
  country: 'COUNTRY', madid: 'MADID', maid: 'MADID',
  extern_id: 'EXTERN_ID', external_id: 'EXTERN_ID',
  value: 'LOOKALIKE_VALUE', lookalike_value: 'LOOKALIKE_VALUE', ltv: 'LOOKALIKE_VALUE',
};

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

/** Resolve the schema from --schema or the CSV header. */
export function resolveCustomerSchema(header: string[] | undefined, schemaOpt?: string): string[] {
  const schema = schemaOpt
    ? schemaOpt.split(',').map(k => k.trim().toUpperCase())
    : (header || []).map(h => HEADER_ALIASES[h.trim().toLowerCase()] || h.trim().toUpperCase());
  const unknown = schema.filter(k => !(k in CUSTOMER_KEY_NORMALIZERS));
  if (unknown.length) {
    throw new Error(`Unknown customer list column(s): ${unknown.join(', ')}. Use: ${Object.keys(CUSTOMER_KEY_NORMALIZERS).join(', ')}`);
  }
  if (new Set(schema).size !== schema.length) throw new Error(`Duplicate columns in schema: ${schema.join(', ')}`);
  return schema;
}

/** Normalize and SHA-256 hash one value for a schema key (64-hex values pass through). */
export function hashCustomerValue(key: string, value: string): string | number {
  const normalize = CUSTOMER_KEY_NORMALIZERS[key];
  if (key === 'LOOKALIKE_VALUE') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`LOOKALIKE_VALUE must be a non-negative number, got "${value}"`);
    return n;
  }
  if (normalize === null) return value.trim();
  if (/^[a-f0-9]{64}$/i.test(value.trim())) return value.trim().toLowerCase();
  const normalized = normalize(value);
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : '';
}

/** Turn CSV rows into hashed payload rows, matching the schema order. */
export function buildCustomerRows(rows: string[][], schema: string[], hash = true): Array<Array<string | number>> {
  return rows.map((row, i) => {
    if (row.length < schema.length) throw new Error(`Row ${i + 1} has ${row.length} column(s); expected ${schema.length}`);
    return schema.map((key, j) => (hash ? hashCustomerValue(key, row[j] ?? '') : (key === 'LOOKALIKE_VALUE' ? Number(row[j]) : row[j])));
  });
}

/**
 * Upload (or remove) users in batches of up to 10,000 as one session, so Meta
 * knows when the last batch has arrived.
 */
export async function uploadCustomerList(
  client: MetaClient,
  audienceId: string,
  schema: string[],
  data: Array<Array<string | number>>,
  opts: { remove?: boolean; batchSize?: number } = {},
): Promise<Record<string, unknown>> {
  const batchSize = Math.min(opts.batchSize ?? MAX_USERS_PER_REQUEST, MAX_USERS_PER_REQUEST);
  if (data.length === 0) throw new Error('No rows to upload');
  // A 64-bit positive integer unique within the ad account; stay inside JS-safe range.
  const sessionId = Number(crypto.randomBytes(6).readUIntBE(0, 6)) + 1;
  const batches = Math.ceil(data.length / batchSize);
  const results: unknown[] = [];
  let received = 0;
  let invalid = 0;
  for (let b = 0; b < batches; b++) {
    const chunk = data.slice(b * batchSize, (b + 1) * batchSize);
    const body: Record<string, string> = {
      payload: JSON.stringify({ schema: schema.length === 1 ? schema[0] : schema, data: schema.length === 1 ? chunk.map(r => r[0]) : chunk }),
      session: JSON.stringify({
        session_id: sessionId,
        batch_seq: b + 1,
        last_batch_flag: b === batches - 1,
        estimated_num_total: data.length,
      }),
    };
    // Removal is a DELETE on the same edge; Graph API accepts it as a POST with method=DELETE.
    if (opts.remove) body.method = 'DELETE';
    const response = await client.request(`${audienceId}/users`, { method: 'POST', body });
    const r = response.data as Record<string, unknown>;
    received += Number(r.num_received ?? 0);
    invalid += Number(r.num_invalid_entries ?? 0);
    results.push(r);
  }
  return {
    audience_id: audienceId,
    action: opts.remove ? 'remove' : 'add',
    session_id: sessionId,
    rows: data.length,
    batches,
    num_received: received,
    num_invalid_entries: invalid,
    results,
    note: 'Meta can take up to 24 hours to process the list.',
  };
}

// ── Overlap ──────────────────────────────────────────────────────────────────

function estimateMidpoint(data: unknown): number | null {
  const row = (((data as Record<string, unknown>)?.data as Array<Record<string, unknown>>) || [])[0] || (data as Record<string, unknown>);
  const lo = Number(row?.estimate_mau_lower_bound);
  const hi = Number(row?.estimate_mau_upper_bound);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0) return Math.round((lo + hi) / 2);
  const mau = Number(row?.estimate_mau);
  return Number.isFinite(mau) ? mau : null;
}

/**
 * Pairwise overlap: |A ∩ B| ≈ reach(A) + reach(B) − reach(A ∪ B). Meta's
 * delivery estimate for several audiences is the union, not the overlap.
 */
export function pairOverlap(a: number | null, b: number | null, union: number | null): Record<string, unknown> {
  if (a === null || b === null || union === null) return { overlap_estimate: null, overlap_pct_of_smaller: null };
  const overlap = Math.max(0, a + b - union);
  const smaller = Math.min(a, b);
  return {
    overlap_estimate: overlap,
    overlap_pct_of_smaller: smaller > 0 ? Number(((overlap / smaller) * 100).toFixed(1)) : null,
  };
}

export function registerAudienceCommands(program: Command, getClient: () => MetaClient): void {
  const audiences = program.command('audiences').description('Custom and lookalike audience management');

  audiences
    .command('list')
    .description('List custom audiences for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated',
        limit: opts.limit,
      };

      const endpoint = `${opts.accountId}/customaudiences`;
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('get <audienceId>')
    .description('Get details for a custom audience')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,description,approximate_count,data_source,delivery_status,operation_status,subtype,time_created,time_updated,lookalike_spec,rule',
      };

      const response = await client.request(audienceId, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('create-custom')
    .description('Create a custom audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Audience name')
    .option('--description <desc>', 'Audience description')
    .option('--subtype <type>', 'Audience subtype (CUSTOM for customer lists, WEBSITE, APP, ENGAGEMENT)')
    .option('--rule <json>', 'Audience rule as JSON (inline, @file or -)')
    .option('--customer-file-source <source>', `Where a customer list came from (${CUSTOMER_FILE_SOURCES.join(', ')}); defaults to USER_PROVIDED_ONLY for CUSTOM`)
    .option('--value-based', 'Value-based customer list (seed for value-based lookalikes; upload a value column)')
    .option('--labels <labels>', 'Comma-separated audience labels (audience_labels), e.g. HIGH_VALUE_CUSTOMERS')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = {
        name: opts.name,
      };
      if (opts.description) body.description = opts.description;
      if (opts.subtype) body.subtype = String(opts.subtype).toUpperCase();
      if (opts.rule) body.rule = JSON.stringify(parseJsonInput(opts.rule, '--rule'));
      if (opts.valueBased) {
        body.subtype = body.subtype || 'CUSTOM';
        body.is_value_based = '1';
      }
      if (opts.customerFileSource) {
        const src = String(opts.customerFileSource).toUpperCase();
        if (!CUSTOMER_FILE_SOURCES.includes(src)) {
          throw new Error(`--customer-file-source must be one of ${CUSTOMER_FILE_SOURCES.join(', ')}`);
        }
        body.customer_file_source = src;
      } else if (body.subtype === 'CUSTOM') {
        // Meta requires a source for customer lists.
        body.customer_file_source = 'USER_PROVIDED_ONLY';
      }
      if (opts.labels) {
        body.audience_labels = JSON.stringify(String(opts.labels).split(',').map((l: string) => l.trim()).filter(Boolean));
      }

      const response = await client.request(`${opts.accountId}/customaudiences`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('create-lookalike')
    .description('Create a lookalike audience from a source audience')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--source-audience-id <id>', 'Source audience ID')
    .option('--name <name>', 'Audience name')
    .option('--countries <countries>', 'Deprecated: Meta ignores lookalike countries; location comes from the ad set targeting')
    .option('--ratio <ratio>', 'Lookalike ratio (0.01-0.20); top x% of similarity', '0.01')
    .option('--starting-ratio <ratio>', 'Lower bound of the band, e.g. --starting-ratio 0.01 --ratio 0.03 for 1-3%')
    .option('--tiers <bands>', 'Create several non-overlapping bands in percent, e.g. 0-1,1-3,3-5 (overrides --ratio/--starting-ratio)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      if (opts.countries) {
        console.error('Warning: --countries is ignored. Meta no longer uses lookalike_spec country/location_spec (v26.0, all versions from 2026-09-01); set locations in the ad set targeting instead.');
      }
      const bands = opts.tiers
        ? parseLookalikeTiers(opts.tiers)
        : [{ starting: opts.startingRatio !== undefined ? parseFloat(opts.startingRatio) : undefined, ratio: parseFloat(opts.ratio) }];

      const results: unknown[] = [];
      for (const band of bands) {
        const spec = buildLookalikeSpec(opts.sourceAudienceId, band.ratio, band.starting);
        const label = band.starting ? `${band.starting * 100}-${band.ratio * 100}%` : `${band.ratio * 100}%`;
        const body: Record<string, string> = {
          name: opts.name
            ? (bands.length > 1 ? `${opts.name} ${label}` : opts.name)
            : `Lookalike ${label} - ${opts.sourceAudienceId}`,
          subtype: 'LOOKALIKE',
          origin_audience_id: opts.sourceAudienceId,
          lookalike_spec: JSON.stringify(spec),
        };
        const response = await client.request(`${opts.accountId}/customaudiences`, { method: 'POST', body });
        results.push(bands.length > 1 ? { band: label, ...(response.data as Record<string, unknown>) } : response.data);
      }

      console.log(formatOutput(bands.length > 1 ? results : results[0], opts.output as OutputFormat));
    }));

  audiences
    .command('update <audienceId>')
    .description('Update an existing custom audience')
    .option('--name <name>', 'New audience name')
    .option('--description <desc>', 'New description')
    .option('--rule <json>', 'New audience rule as JSON (inline, @file or -)')
    .option('--labels <labels>', 'Comma-separated audience labels (replaces existing)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const body: Record<string, string> = {};
      if (opts.name) body.name = opts.name;
      if (opts.description) body.description = opts.description;
      if (opts.rule) body.rule = JSON.stringify(parseJsonInput(opts.rule, '--rule'));
      if (opts.labels) {
        body.audience_labels = JSON.stringify(String(opts.labels).split(',').map((l: string) => l.trim()).filter(Boolean));
      }
      if (Object.keys(body).length === 0) throw new Error('No update parameters provided');

      const response = await client.request(audienceId, { method: 'POST', body });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  audiences
    .command('overlap')
    .description('Estimate pairwise overlap between audiences (reach(A) + reach(B) − reach(A ∪ B), from delivery estimates)')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--audience-ids <ids>', 'Comma-separated audience IDs (2-5)')
    .option('--countries <codes>', 'Countries for the reach estimates (delivery estimates need a location)', 'US')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const ids: string[] = String(opts.audienceIds).split(',').map((id: string) => id.trim()).filter(Boolean);
      if (ids.length < 2 || ids.length > 5) throw new Error('--audience-ids needs 2 to 5 audience IDs');
      const countries = String(opts.countries).split(',').map((c: string) => c.trim().toUpperCase()).filter(Boolean);

      const estimate = async (audienceIds: string[]): Promise<number | null> => {
        const targeting = { geo_locations: { countries }, custom_audiences: audienceIds.map(id => ({ id })) };
        const response = await client.request(`${opts.accountId}/delivery_estimate`, {
          params: { targeting_spec: JSON.stringify(targeting), optimization_goal: 'REACH' },
        });
        return estimateMidpoint(response.data);
      };

      const reach: Record<string, number | null> = {};
      for (const id of ids) reach[id] = await estimate([id]);

      const pairs: Array<Record<string, unknown>> = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const union = await estimate([ids[i], ids[j]]);
          pairs.push({
            audience_a: ids[i],
            audience_b: ids[j],
            reach_a: reach[ids[i]],
            reach_b: reach[ids[j]],
            reach_union: union,
            ...pairOverlap(reach[ids[i]], reach[ids[j]], union),
          });
        }
      }

      console.log(formatOutput({
        countries,
        pairs,
        note: 'Estimated from Meta delivery estimates (monthly active reach midpoints), which are rounded ranges. '
          + 'Treat overlap as approximate; small audiences may show 0.',
      }, opts.output as OutputFormat));
    }));

  // Saved audiences (read-only: Meta doesn't support creating them via the API)
  const saved = audiences.command('saved').description('Saved audiences (targeting presets) — read-only via the API');

  saved
    .command('list')
    .description('List saved audiences for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      const client = getClient();
      const params = { fields: SAVED_AUDIENCE_FIELDS };
      const endpoint = `${opts.accountId}/saved_audiences`;
      const response = opts.all ? await client.requestAllPages(endpoint, { params }) : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  saved
    .command('get <savedAudienceId>')
    .description('Get a saved audience, including its targeting spec (reuse it with adsets create --targeting)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (savedAudienceId: string, opts) => {
      const client = getClient();
      const response = await client.request(savedAudienceId, { params: { fields: SAVED_AUDIENCE_FIELDS } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // Customer list upload / removal
  audiences
    .command('upload <audienceId>')
    .description('Add customers from a CSV to a customer list audience (normalized + SHA-256 hashed; batches of 10,000)')
    .requiredOption('--file <path>', 'CSV file with a header row (email, phone, first_name, last_name, zip, city, state, country, gender, doby, madid, external_id, value)')
    .option('--schema <keys>', 'Comma-separated schema keys in column order (EMAIL,PHONE,FN,LN,ZIP,CT,ST,COUNTRY,GEN,DOBY,DOBM,DOBD,FI,MADID,EXTERN_ID,LOOKALIKE_VALUE); default: from the CSV header')
    .option('--no-header', 'The CSV has no header row (requires --schema)')
    .option('--no-hash', 'Values are already normalized and hashed')
    .option('--remove', 'Remove these customers from the audience instead of adding them')
    .option('--batch-size <n>', 'Users per request (max 10000)', String(MAX_USERS_PER_REQUEST))
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      await runCustomerUpload(getClient(), audienceId, opts);
    }));

  audiences
    .command('remove-users <audienceId>')
    .description('Remove customers listed in a CSV from a customer list audience')
    .requiredOption('--file <path>', 'CSV file (same format as upload)')
    .option('--schema <keys>', 'Comma-separated schema keys in column order; default: from the CSV header')
    .option('--no-header', 'The CSV has no header row (requires --schema)')
    .option('--no-hash', 'Values are already normalized and hashed')
    .option('--batch-size <n>', 'Users per request (max 10000)', String(MAX_USERS_PER_REQUEST))
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      await runCustomerUpload(getClient(), audienceId, { ...opts, remove: true });
    }));

  audiences
    .command('delete <audienceId>')
    .description('Delete a custom audience')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (audienceId: string, opts) => {
      const client = getClient();
      const response = await client.request(audienceId, { method: 'DELETE' });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  // Pixel management
  const pixels = program.command('pixels').description('Pixel and conversion tracking');

  pixels
    .command('list')
    .description('List pixels for an ad account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'id,name,code,creation_time,data_use_setting,last_fired_time,is_created_by_app',
      };

      const response = await client.request(`${opts.accountId}/adspixels`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pixels
    .command('create')
    .description('Create a new tracking pixel')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--name <name>', 'Pixel name')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) {
        throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      }
      const client = getClient();
      const body: Record<string, string> = { name: opts.name };

      const response = await client.request(`${opts.accountId}/adspixels`, {
        method: 'POST',
        body,
      });

      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  pixels
    .command('events <pixelId>')
    .description('Get pixel events')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pixelId: string, opts) => {
      const client = getClient();
      const params: Record<string, string> = {
        fields: 'data',
      };

      const response = await client.request(`${pixelId}/stats`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}

const SAVED_AUDIENCE_FIELDS = 'id,name,description,approximate_count_lower_bound,approximate_count_upper_bound,run_status,sentence_lines,targeting,time_created,time_updated';

async function runCustomerUpload(client: MetaClient, audienceId: string, opts: Record<string, unknown>): Promise<void> {
  const batchSize = Number(opts.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_USERS_PER_REQUEST) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_USERS_PER_REQUEST}`);
  }
  if (opts.header === false && !opts.schema) throw new Error('--no-header requires --schema');
  let text: string;
  try {
    text = fs.readFileSync(String(opts.file), 'utf8');
  } catch (err) {
    throw new Error(`Can't read ${opts.file}: ${(err as Error).message}`);
  }
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const header = opts.header === false ? undefined : rows.shift();
  const schema = resolveCustomerSchema(header, opts.schema as string | undefined);
  const data = buildCustomerRows(rows, schema, opts.hash !== false);
  const result = await uploadCustomerList(client, audienceId, schema, data, { remove: Boolean(opts.remove), batchSize });
  console.log(formatOutput({ schema, ...result }, (opts.output as OutputFormat) || 'json'));
}

/** Parse "0-1,1-3,3-5" (percent) into lookalike bands. */
export function parseLookalikeTiers(value: string): Array<{ starting?: number; ratio: number }> {
  const bands = String(value).split(',').map((band) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(band);
    if (!m) throw new Error(`Invalid tier "${band}". Use percent bands like 0-1,1-3,3-5`);
    const start = Number(m[1]) / 100;
    const end = Number(m[2]) / 100;
    return { starting: start > 0 ? start : undefined, ratio: end };
  });
  bands.forEach(b => validateLookalikeBand(b.ratio, b.starting));
  return bands;
}

function validateLookalikeBand(ratio: number, starting?: number): void {
  if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 0.2) throw new Error('Lookalike ratio must be between 0.01 and 0.20 (1-20%)');
  if (starting !== undefined && (!Number.isFinite(starting) || starting < 0 || starting >= ratio)) {
    throw new Error('--starting-ratio must be at least 0 and below --ratio');
  }
}

export function buildLookalikeSpec(sourceAudienceId: string, ratio: number, starting?: number): Record<string, unknown> {
  validateLookalikeBand(ratio, starting);
  const spec: Record<string, unknown> = {
    type: 'similarity',
    ratio: Number(ratio.toFixed(2)),
    origin: [{ id: sourceAudienceId, type: 'custom_audience' }],
  };
  if (starting !== undefined && starting > 0) spec.starting_ratio = Number(starting.toFixed(2));
  return spec;
}
