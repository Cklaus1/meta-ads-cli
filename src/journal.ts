import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG_DIR, ensurePrivateDir } from './private-file.js';

/**
 * Append-only log of every write the CLI sends, with the previous values of
 * changed fields when they could be read first, so changes can be audited
 * and undone (`meta-ads journal list / undo`).
 */
export interface JournalEntry {
  id: string;
  ts: string;
  method: string;
  endpoint: string;
  params?: Record<string, string>;
  body?: Record<string, string>;
  status: 'ok' | 'error';
  result_id?: string;
  error?: string;
  /** Values of the changed fields before the write (bare-object updates only). */
  previous?: Record<string, unknown>;
  /** Set when this entry undid another one. */
  undo_of?: string;
}

const SECRET_KEY = /token|secret|password/i;
// Bulk payloads (customer lists, CAPI events, image bytes) hold personal data
// or are huge; journal and plan output keep only a size and hash.
const BULK_KEY = /^(payload|data|session|bytes|user_data|users|batch|file_content)$/i;
const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;

export function journalPath(): string | undefined {
  if (process.env.META_ADS_CLI_JOURNAL_FILE) return process.env.META_ADS_CLI_JOURNAL_FILE;
  if (process.env.META_ADS_CLI_NO_JOURNAL) return undefined;
  return path.join(CONFIG_DIR, 'journal.jsonl');
}

export function journalEnabled(): boolean {
  return journalPath() !== undefined;
}

export function redact(fields: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!fields) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (BULK_KEY.test(k) && typeof v === 'string' && v.length > 0) out[k] = summarize(v);
    else out[k] = v;
  }
  return out;
}

/** Replace a large or personal value with its size and hash. */
export function summarize(value: string): string {
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `[${value.length} chars, sha256:${hash}]`;
}

export function newJournalId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function appendJournal(entry: JournalEntry): void {
  const file = journalPath();
  if (!file) return;
  try {
    // Only lock down our own config dir; a custom path's directory is the user's.
    const dir = path.dirname(file);
    if (path.resolve(dir) === path.resolve(CONFIG_DIR)) ensurePrivateDir(dir);
    else if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Rotate once the journal gets large, keeping one previous file.
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_JOURNAL_BYTES) fs.renameSync(file, `${file}.1`);
    const existed = fs.existsSync(file);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (!existed) fs.chmodSync(file, 0o600);
  } catch (err) {
    // The write already happened; losing the log line must not fail the command.
    console.error(`Warning: could not write journal (${(err as Error).message})`);
  }
}

export function readJournal(): JournalEntry[] {
  const file = journalPath();
  if (!file || !fs.existsSync(file)) return [];
  const entries: JournalEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // Skip a partially written line rather than refusing to read the journal.
    }
  }
  return entries;
}
