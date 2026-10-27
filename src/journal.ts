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

export function journalPath(): string | undefined {
  if (process.env.META_ADS_CLI_NO_JOURNAL) return undefined;
  if (process.env.META_ADS_CLI_JOURNAL_FILE) return process.env.META_ADS_CLI_JOURNAL_FILE;
  // Keep test runs out of the developer's real journal.
  if (process.env.VITEST) return undefined;
  return path.join(CONFIG_DIR, 'journal.jsonl');
}

export function journalEnabled(): boolean {
  return journalPath() !== undefined;
}

export function redact(fields: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!fields) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  return out;
}

export function newJournalId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function appendJournal(entry: JournalEntry): void {
  const file = journalPath();
  if (!file) return;
  try {
    ensurePrivateDir(path.dirname(file));
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
