import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './private-file.js';

/** Files that hold credentials must never be read into a request (and echoed by --dry-run/--plan). */
function assertSafeInputFile(file: string, flag: string): string {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch (err) {
    throw new Error(`${flag}: can't read ${file}: ${(err as NodeJS.ErrnoException).code || (err as Error).message}`);
  }
  let configDir = CONFIG_DIR;
  try { configDir = fs.realpathSync(CONFIG_DIR); } catch { /* not created yet */ }
  const rel = path.relative(configDir, real);
  const insideConfig = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  const base = path.basename(real);
  if (insideConfig || base === '.env' || base.startsWith('.env.') || base === 'token-cache.json') {
    throw new Error(`${flag}: refusing to read ${file}, which may contain credentials.`);
  }
  return real;
}

/** Parse error text without echoing the input (it may come from a file the user didn't mean to show). */
function parseError(err: unknown): string {
  const msg = (err as Error).message || '';
  const pos = /position (\d+)/.exec(msg);
  return pos ? `syntax error at position ${pos[1]}` : 'syntax error';
}

/**
 * Parse a JSON option value. Accepts inline JSON, `@path/to/file.json`, or
 * `-` to read stdin, and reports parse errors with the flag name. In MCP tool
 * calls only inline JSON is accepted, so a tool can't read local files.
 */
export function parseJsonInput<T = unknown>(value: string, flag: string): T {
  let text = value;
  let source = 'inline value';
  const mcpChild = process.env.META_ADS_CLI_MCP_CHILD === '1';
  if (value === '-' || value.startsWith('@')) {
    if (mcpChild) throw new Error(`${flag}: @file and stdin input aren't available to MCP tools; pass the JSON inline.`);
  }
  if (value === '-') {
    text = fs.readFileSync(0, 'utf8');
    source = 'stdin';
  } else if (value.startsWith('@')) {
    const file = value.slice(1);
    const real = assertSafeInputFile(file, flag);
    text = fs.readFileSync(real, 'utf8');
    source = file;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${flag}: invalid JSON in ${source} (${parseError(err)})`);
  }
}
