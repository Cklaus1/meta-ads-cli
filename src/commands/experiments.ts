import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, UsageError } from '../errors.js';
import { parseJsonInput } from '../json-input.js';

function getDefaultBusinessId(): string {
  return process.env.META_ADS_CLI_BUSINESS_ID || '';
}

// Ad Studies types this CLI creates (AdStudy reference, checked 2026-10-27).
export const STUDY_TYPES = ['SPLIT_TEST', 'LIFT', 'GEO_LIFT'];

export interface StudyCell {
  name: string;
  description?: string;
  treatment_percentage: number;
  campaigns?: string[];
  adsets?: string[];
  adaccounts?: string[];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Parse a --cell value like "name=A;campaigns=111,222;pct=50". Keys: name,
 * description, pct (treatment_percentage), campaigns, adsets, adaccounts.
 */
export function parseCell(value: string): StudyCell {
  const cell: Partial<StudyCell> = {};
  for (const part of value.split(';').map(p => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`--cell: expected key=value, got "${part}"`);
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    const ids = () => val.split(',').map(v => v.trim()).filter(Boolean);
    if (key === 'name') cell.name = val;
    else if (key === 'description') cell.description = val;
    else if (key === 'pct' || key === 'treatment_percentage') cell.treatment_percentage = Number(val);
    else if (key === 'campaigns') cell.campaigns = ids();
    else if (key === 'adsets') cell.adsets = ids();
    else if (key === 'adaccounts') cell.adaccounts = ids().map(a => (a.startsWith('act_') ? a.slice(4) : a));
    else throw new Error(`--cell: unknown key "${key}" (use name, description, pct, campaigns, adsets, adaccounts)`);
  }
  if (!cell.name) throw new Error(`--cell "${value}" needs a name=`);
  return cell as StudyCell;
}

/** Check cells against Meta's Ad Studies rules before sending. */
export function validateCells(type: string, cells: StudyCell[]): void {
  if (type === 'SPLIT_TEST' && cells.length < 2) throw new Error('A split test needs at least two cells');
  if (cells.length > 5) throw new Error('At most 5 cells are supported');
  let total = 0;
  for (const c of cells) {
    if (!c.campaigns?.length && !c.adsets?.length && !c.adaccounts?.length) {
      throw new Error(`Cell "${c.name}" needs campaigns, adsets or adaccounts`);
    }
    if (!Number.isFinite(c.treatment_percentage) || c.treatment_percentage < 10) {
      throw new Error(`Cell "${c.name}": treatment percentage must be at least 10, got ${c.treatment_percentage}`);
    }
    total += c.treatment_percentage;
  }
  if (total > 100) throw new Error(`Cell treatment percentages add up to ${total}; the total must be 100 or less`);
}

/** Accept "now", a Unix timestamp, or an ISO date/time. Returns Unix seconds. */
export function toUnix(value: string, flag: string): number {
  if (value === 'now') return Math.floor(Date.now() / 1000);
  if (/^\d{9,11}$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${flag}: expected "now", a Unix timestamp or an ISO date, got "${value}"`);
  return Math.floor(ms / 1000);
}

/**
 * Build the POST body for /{business_id}/ad_studies. Split tests divide the
 * audience so the cells don't compete in the same auction, unlike comparing
 * two duplicated campaigns.
 */
export function buildStudyBody(o: {
  name: string; type: string; start: number; end: number; cells: StudyCell[];
  description?: string; confidenceLevel?: number; objectives?: unknown;
}): Record<string, string> {
  const type = o.type.toUpperCase();
  if (!STUDY_TYPES.includes(type)) throw new Error(`--type must be one of ${STUDY_TYPES.join(', ')}, got "${o.type}"`);
  if (o.end <= o.start) throw new Error('The end time must be after the start time');
  validateCells(type, o.cells);
  const body: Record<string, string> = {
    name: o.name,
    type,
    start_time: String(o.start),
    end_time: String(o.end),
    cells: JSON.stringify(o.cells),
  };
  if (o.description) body.description = o.description;
  if (o.confidenceLevel !== undefined) body.confidence_level = String(o.confidenceLevel);
  if (o.objectives !== undefined) body.objectives = JSON.stringify(o.objectives);
  return body;
}

export function registerExperimentCommands(program: Command, getClient: () => MetaClient): void {
  const experiments = program.command('experiments').alias('studies')
    .description('Meta experiments (Ad Studies): split tests and lift studies with a properly divided audience');

  experiments
    .command('create')
    .description('Create a split test or lift study. Example: --type SPLIT_TEST --cell "name=A;campaigns=111;pct=50" --cell "name=B;campaigns=222;pct=50" --start now --days 14')
    .requiredOption('--business-id <id>', 'Business ID that owns the study (env META_ADS_CLI_BUSINESS_ID)', getDefaultBusinessId())
    .requiredOption('--name <name>', 'Study name')
    .option('--type <type>', `Study type: ${STUDY_TYPES.join(', ')}`, 'SPLIT_TEST')
    .option('--cell <spec>', 'Cell as "name=A;campaigns=1,2;pct=50" (repeatable; keys: name, description, pct, campaigns, adsets, adaccounts)', collect)
    .option('--cells <json>', 'Cells as a JSON array (JSON, @file or -) instead of --cell')
    .option('--start <time>', '"now", Unix timestamp or ISO date', 'now')
    .option('--end <time>', 'End: Unix timestamp or ISO date')
    .option('--days <n>', 'Duration in days (instead of --end)', '14')
    .option('--description <text>', 'Description')
    .option('--confidence-level <pct>', 'Confidence level for results, e.g. 90')
    .option('--objectives <json>', 'Study objectives (JSON, @file or -), e.g. for lift studies')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.businessId) throw new Error('--business-id required (or set META_ADS_CLI_BUSINESS_ID)');
      const cells: StudyCell[] = opts.cells
        ? parseJsonInput<StudyCell[]>(opts.cells, '--cells')
        : (opts.cell || []).map(parseCell);
      if (!Array.isArray(cells) || cells.some(c => !c || typeof c !== 'object' || Array.isArray(c))) {
        throw new UsageError('--cells must be a JSON array of cell objects');
      }
      let confidenceLevel: number | undefined;
      if (opts.confidenceLevel !== undefined) {
        confidenceLevel = Number(opts.confidenceLevel);
        if (!Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 100) {
          throw new UsageError(`--confidence-level must be a percentage between 0 and 100, got "${opts.confidenceLevel}"`);
        }
      }
      const start = toUnix(opts.start, '--start');
      const days = Number(opts.days);
      if (!opts.end && (!Number.isFinite(days) || days <= 0)) throw new Error(`--days must be a positive number, got "${opts.days}"`);
      const end = opts.end ? toUnix(opts.end, '--end') : start + Math.round(days * 86400);
      const body = buildStudyBody({
        name: opts.name,
        type: opts.type,
        start,
        end,
        cells,
        description: opts.description,
        confidenceLevel,
        objectives: opts.objectives ? parseJsonInput(opts.objectives, '--objectives') : undefined,
      });
      const response = await getClient().request(`${opts.businessId}/ad_studies`, { method: 'POST', body });
      console.log(formatOutput({
        ...(response.data as Record<string, unknown>),
        type: body.type,
        start_time: new Date(start * 1000).toISOString(),
        end_time: new Date(end * 1000).toISOString(),
        cells,
      }, opts.output as OutputFormat));
    }));

  experiments
    .command('list')
    .description('List ad studies for a business')
    .requiredOption('--business-id <id>', 'Business ID (env META_ADS_CLI_BUSINESS_ID)', getDefaultBusinessId())
    .option('--limit <n>', 'Maximum results', '25')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.businessId) throw new Error('--business-id required (or set META_ADS_CLI_BUSINESS_ID)');
      const response = await getClient().request(`${opts.businessId}/ad_studies`, {
        params: { fields: 'id,name,type,start_time,end_time,canceled_time,results_first_available_date,created_time', limit: opts.limit },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  experiments
    .command('get <studyId>')
    .description('Get a study with its cells')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (studyId: string, opts) => {
      const client = getClient();
      const [study, cells] = await Promise.all([
        client.request(studyId, { params: { fields: 'id,name,description,type,start_time,end_time,canceled_time,cooldown_start_time,observation_end_time,results_first_available_date,created_time,updated_time' } }),
        client.request(`${studyId}/cells`, { params: { fields: 'id,name,treatment_percentage,campaigns,adsets,adaccounts' } }),
      ]);
      console.log(formatOutput({ ...(study.data as Record<string, unknown>), cells: (cells.data as { data?: unknown }).data ?? cells.data }, opts.output as OutputFormat));
    }));

  experiments
    .command('results <studyId>')
    .description('Read a study\'s objectives and their results (available once Meta has enough data)')
    .option('--fields <fields>', 'Objective fields to request (default: Meta\'s defaults)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (studyId: string, opts) => {
      const params: Record<string, string> = {};
      if (opts.fields) params.fields = opts.fields;
      const response = await getClient().request(`${studyId}/objectives`, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
