import { Command } from 'commander';
import fs from 'fs';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { applyAdsetBudgetSharing } from './campaigns.js';
import { insightsTimeParams } from '../time-range.js';
import { parseJsonInput } from '../json-input.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

/** Parse an integer option, rejecting non-numeric values and values below `min`. */
export function parseIntOption(value: string, name: string, min: number): number {
  const str = String(value).trim();
  if (!/^-?\d+$/.test(str) || Number(str) < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: "${value}"`);
  }
  return Number(str);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Resumable batches ──────────────────────────────────────────────────────

/** IDs already processed in an earlier run, from a --state-file. */
export function loadState(file: string | undefined): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { done?: string[] };
    return new Set(data.done || []);
  } catch {
    throw new Error(`--state-file ${file} is not a valid state file`);
  }
}

function saveState(file: string | undefined, done: Set<string>): void {
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify({ done: [...done], updated_at: new Date().toISOString() }, null, 2));
}

// ─── CSV sheet round trip ───────────────────────────────────────────────────

type Level = 'campaign' | 'adset' | 'ad';

/** Columns exported per level; `editable` ones can be changed by `bulk import`. */
export const SHEET_COLUMNS: Record<Level, { fields: string[]; editable: string[]; edge: string }> = {
  campaign: {
    edge: 'campaigns',
    fields: ['id', 'name', 'status', 'effective_status', 'objective', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'spend_cap'],
    editable: ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'spend_cap'],
  },
  adset: {
    edge: 'adsets',
    fields: ['id', 'name', 'campaign_id', 'status', 'effective_status', 'optimization_goal', 'billing_event', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount', 'start_time', 'end_time'],
    editable: ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount', 'end_time'],
  },
  ad: {
    edge: 'ads',
    fields: ['id', 'name', 'adset_id', 'campaign_id', 'status', 'effective_status'],
    editable: ['name', 'status'],
  },
};

function parseLevel(value: string): Level {
  if (value !== 'campaign' && value !== 'adset' && value !== 'ad') {
    throw new Error(`--level must be campaign, adset or ad, got: "${value}"`);
  }
  return value;
}

function csvCell(value: unknown): string {
  let v = value === undefined || value === null ? '' : String(value);
  // Neutralise spreadsheet formulas; `bulk import` strips the guard again.
  if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/** Parse CSV text (quoted fields, escaped quotes, CRLF) into row objects keyed by header. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some(f => f !== '')) records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted field');
  record.push(field);
  if (record.some(f => f !== '')) records.push(record);
  if (records.length === 0) return [];
  const header = records[0].map(h => h.trim());
  return records.slice(1).map(cells => {
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      let v = cells[idx] ?? '';
      if (/^'[=+\-@\t\r]/.test(v)) v = v.slice(1);
      row[h] = v;
    });
    return row;
  });
}

/** Changes a sheet row makes to the current object, editable columns only; blank cells mean "leave as is". */
export function diffRow(row: Record<string, string>, current: Record<string, unknown>, editable: string[]): Record<string, { from: string; to: string }> {
  const changes: Record<string, { from: string; to: string }> = {};
  for (const col of editable) {
    if (!(col in row)) continue;
    const to = row[col].trim();
    if (to === '') continue;
    const from = current[col] === undefined || current[col] === null ? '' : String(current[col]);
    if (to !== from) changes[col] = { from, to };
  }
  return changes;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse repeated --set key=value pairs into a request body. */
export function parseSetPairs(pairs: string[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--set must look like field=value, got: "${pair}"`);
    const key = pair.slice(0, eq).trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error(`--set field "${key}" isn't a valid API field name`);
    body[key] = pair.slice(eq + 1);
  }
  if (Object.keys(body).length === 0) throw new Error('Pass at least one --set field=value');
  return body;
}

export function registerBulkCommands(program: Command, getClient: () => MetaClient): void {
  const bulk = program.command('bulk').description('Bulk operations for campaigns, creatives, and optimization');

  bulk
    .command('create-campaigns')
    .description('Create multiple campaigns from a JSON config')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--config <json>', 'JSON array of campaign configs (name, objective, status, daily_budget, lifetime_budget, bid_strategy, special_ad_categories, is_adset_budget_sharing_enabled); inline, @file or -. Each needs name and objective')
    .option('--batch-size <n>', 'Campaigns per batch', '5')
    .option('--delay-ms <ms>', 'Delay between batches', '2000')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const campaigns = parseJsonInput<Array<Record<string, unknown>>>(opts.config, '--config');
      if (!Array.isArray(campaigns)) throw new Error('--config must be a JSON array of campaign configs');
      const missing = campaigns.findIndex(c => !c || !c.name || !c.objective);
      if (missing !== -1) {
        throw new Error(`--config entry ${missing} needs both "name" and "objective" (e.g. OUTCOME_SALES); there is no default objective.`);
      }
      const batchSize = parseIntOption(opts.batchSize, '--batch-size', 1);
      const delayMs = parseIntOption(opts.delayMs, '--delay-ms', 0);

      const results = { created: [] as unknown[], failed: [] as unknown[] };

      for (let i = 0; i < campaigns.length; i += batchSize) {
        if (i > 0) await sleep(delayMs);
        const batch = campaigns.slice(i, i + batchSize);

        const batchPromises = batch.map(async (config) => {
          try {
            const body: Record<string, string> = {
              name: String(config.name || ''),
              objective: String(config.objective),
              status: String(config.status || 'PAUSED'),
              special_ad_categories: JSON.stringify(config.special_ad_categories || []),
            };
            if (config.daily_budget) body.daily_budget = String(config.daily_budget);
            if (config.lifetime_budget) body.lifetime_budget = String(config.lifetime_budget);
            if (config.bid_strategy) body.bid_strategy = String(config.bid_strategy);
            applyAdsetBudgetSharing(body, config.is_adset_budget_sharing_enabled as boolean | string | undefined);

            const response = await client.request(`${opts.accountId}/campaigns`, { method: 'POST', body });
            return { success: true, name: config.name, data: response.data };
          } catch (err) {
            return { success: false, name: config.name, error: (err as Error).message };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        for (const r of batchResults) {
          if (r.success) results.created.push(r);
          else results.failed.push(r);
        }

        console.error(`Progress: ${Math.min(i + batchSize, campaigns.length)}/${campaigns.length}`);
      }

      console.log(formatOutput({
        total: campaigns.length,
        created: results.created.length,
        failed: results.failed.length,
        results,
      }, opts.output as OutputFormat));
    }));

  bulk
    .command('update-status')
    .description('Bulk update status for multiple objects')
    .requiredOption('--ids <ids>', 'Comma-separated object IDs')
    .requiredOption('--status <status>', 'New status (ACTIVE, PAUSED, ARCHIVED)')
    .option('--delay-ms <ms>', 'Delay between requests', '500')
    .option('--state-file <path>', 'Record finished IDs here and skip them when re-run (resume after a failure)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      await runBulkUpdate(getClient(), opts.ids, { status: opts.status }, opts);
    }));

  bulk
    .command('update')
    .description('Set any fields on many campaigns, ad sets or ads (e.g. --set daily_budget=5000 --set name=Q4)')
    .requiredOption('--ids <ids>', 'Comma-separated object IDs')
    .requiredOption('--set <field=value>', 'Field to set (repeatable). Budgets are in cents', collect)
    .option('--delay-ms <ms>', 'Delay between requests', '500')
    .option('--state-file <path>', 'Record finished IDs here and skip them when re-run')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      await runBulkUpdate(getClient(), opts.ids, parseSetPairs(opts.set), opts);
    }));

  bulk
    .command('export')
    .description('Export campaigns, ad sets or ads to a CSV sheet you can edit and re-import with "bulk import"')
    .requiredOption('--level <level>', 'campaign, adset or ad')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--campaign-id <id>', 'Only objects in this campaign (adset/ad levels)')
    .option('--status <statuses>', 'Comma-separated effective statuses to include (e.g. ACTIVE,PAUSED)')
    .option('--file <path>', 'Write the CSV here instead of stdout')
    .action(handleErrors(async (opts) => {
      const level = parseLevel(opts.level);
      if (!opts.accountId && !opts.campaignId) throw new Error('Account ID required. Use --account-id or set META_ADS_CLI_ACCOUNT_ID');
      if (opts.campaignId && level === 'campaign') throw new Error('--campaign-id only applies to --level adset or ad');
      const client = getClient();
      const cfg = SHEET_COLUMNS[level];
      const params: Record<string, string> = { fields: cfg.fields.join(','), limit: '200' };
      if (opts.status) params.effective_status = JSON.stringify(String(opts.status).split(',').map((v: string) => v.trim()));
      const parent = opts.campaignId || opts.accountId;
      const response = await client.requestAllPages(`${parent}/${cfg.edge}`, { params });
      const rows = (response.data as { data?: Array<Record<string, unknown>> }).data || [];
      const csv = toCsv(cfg.fields, rows);
      if (opts.file) {
        fs.writeFileSync(opts.file, csv);
        console.error(`Wrote ${rows.length} ${level}(s) to ${opts.file}. Editable columns: ${cfg.editable.join(', ')}`);
      } else {
        process.stdout.write(csv);
      }
    }));

  bulk
    .command('import')
    .description('Preview (default) or apply the changes in an edited sheet from "bulk export"')
    .requiredOption('--level <level>', 'campaign, adset or ad')
    .requiredOption('--file <path>', 'CSV sheet with an id column (use - for stdin)')
    .option('--apply', 'Send the changes (without it, only the diff is shown)')
    .option('--delay-ms <ms>', 'Delay between updates', '500')
    .option('--state-file <path>', 'Record finished IDs here and skip them when re-run')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const level = parseLevel(opts.level);
      const cfg = SHEET_COLUMNS[level];
      const delayMs = parseIntOption(opts.delayMs, '--delay-ms', 0);
      const text = opts.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(opts.file, 'utf8');
      const rows = parseCsv(text);
      if (rows.length && !('id' in rows[0])) throw new Error('The sheet needs an "id" column');
      const ignored = rows.length ? Object.keys(rows[0]).filter(c => c !== 'id' && !cfg.editable.includes(c) && !cfg.fields.includes(c)) : [];
      const client = getClient();
      const done = loadState(opts.stateFile);
      const plan: Array<{ id: string; changes: Record<string, { from: string; to: string }> }> = [];
      const errors: Array<{ id: string; error: string }> = [];

      for (const row of rows) {
        const id = row.id.trim();
        if (!id) continue;
        if (done.has(id)) continue;
        try {
          const current = (await client.request(id, { params: { fields: cfg.editable.join(',') } })).data as Record<string, unknown>;
          const changes = diffRow(row, current, cfg.editable);
          if (Object.keys(changes).length) plan.push({ id, changes });
        } catch (err) {
          errors.push({ id, error: (err as Error).message });
        }
      }

      const applied: string[] = [];
      if (opts.apply) {
        for (const item of plan) {
          const body = Object.fromEntries(Object.entries(item.changes).map(([k, v]) => [k, v.to]));
          try {
            await client.request(item.id, { method: 'POST', body });
            applied.push(item.id);
            done.add(item.id);
            saveState(opts.stateFile, done);
          } catch (err) {
            errors.push({ id: item.id, error: (err as Error).message });
          }
          if (delayMs > 0) await sleep(delayMs);
        }
      }

      console.log(formatOutput({
        rows: rows.length,
        changed: plan.length,
        applied: opts.apply ? applied.length : 0,
        skipped_already_done: done.size - applied.length,
        failed: errors.length,
        ignored_columns: ignored.length ? ignored : undefined,
        changes: plan,
        errors: errors.length ? errors : undefined,
        note: opts.apply ? undefined : 'Preview only. Re-run with --apply to send these changes.',
      }, opts.output as OutputFormat));
      if (errors.length) process.exitCode = 1;
    }));

  bulk
    .command('analyze')
    .description('Bulk performance analysis for multiple entities')
    .requiredOption('--ids <ids>', 'Comma-separated entity IDs')
    .option('--metrics <fields>', 'Metrics to fetch', 'impressions,clicks,spend,cpc,cpm,ctr,actions')
    .option('--time-range <range>', 'Time range', 'last_7d')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const ids = opts.ids.split(',').map((id: string) => id.trim());
      const results: unknown[] = [];

      for (const id of ids) {
        try {
          const [entity, insights] = await Promise.all([
            client.request(id, { params: { fields: 'id,name,status' } }),
            client.request(`${id}/insights`, { params: {
              fields: opts.metrics,
              ...insightsTimeParams(opts.timeRange),
            } }),
          ]);
          results.push({
            entity: entity.data,
            insights: ((insights.data as Record<string, unknown>).data as unknown[])?.[0] || {},
          });
        } catch (err) {
          results.push({ id, error: (err as Error).message });
        }
      }

      console.log(formatOutput(results, opts.output as OutputFormat));
    }));

  bulk
    .command('upload-creatives')
    .description('Bulk upload image creatives from URLs')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--images <json>', 'JSON array of {url, name} objects (inline, @file or -)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const images = parseJsonInput<Array<{ url: string; name?: string }>>(opts.images, '--images');
      const results = { uploaded: [] as unknown[], failed: [] as unknown[] };

      for (const img of images) {
        try {
          const body: Record<string, string> = { url: img.url };
          if (img.name) body.name = img.name;
          const response = await client.request(`${opts.accountId}/adimages`, { method: 'POST', body });
          results.uploaded.push({ url: img.url, data: response.data });
        } catch (err) {
          results.failed.push({ url: img.url, error: (err as Error).message });
        }
        await sleep(500);
      }

      console.log(formatOutput({
        total: images.length,
        uploaded: results.uploaded.length,
        failed: results.failed.length,
        results,
      }, opts.output as OutputFormat));
    }));
}

/** Update many objects with the same body, optionally resuming from a state file. */
async function runBulkUpdate(
  client: MetaClient,
  idList: string,
  body: Record<string, string>,
  opts: { delayMs: string; stateFile?: string; output: string },
): Promise<void> {
  const ids = idList.split(',').map((id: string) => id.trim()).filter(Boolean);
  const delayMs = parseIntOption(opts.delayMs, '--delay-ms', 0);
  const done = loadState(opts.stateFile);
  const results = { updated: [] as unknown[], failed: [] as unknown[], skipped: [] as string[] };

  for (const id of ids) {
    if (done.has(id)) {
      results.skipped.push(id);
      continue;
    }
    try {
      const response = await client.request(id, { method: 'POST', body });
      results.updated.push({ id, data: response.data });
      done.add(id);
      saveState(opts.stateFile, done);
    } catch (err) {
      results.failed.push({ id, error: (err as Error).message });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(formatOutput({
    total: ids.length,
    updated: results.updated.length,
    failed: results.failed.length,
    skipped: results.skipped.length,
    results,
  }, opts.output as OutputFormat));
  if (results.failed.length) process.exitCode = 1;
}
