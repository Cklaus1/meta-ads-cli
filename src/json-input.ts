import fs from 'fs';

/**
 * Parse a JSON option value. Accepts inline JSON, `@path/to/file.json`, or
 * `-` to read stdin, and reports parse errors with the flag name.
 */
export function parseJsonInput<T = unknown>(value: string, flag: string): T {
  let text = value;
  let source = 'inline value';
  if (value === '-') {
    text = fs.readFileSync(0, 'utf8');
    source = 'stdin';
  } else if (value.startsWith('@')) {
    const file = value.slice(1);
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`${flag}: can't read ${file}: ${(err as Error).message}`);
    }
    source = file;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${flag}: invalid JSON in ${source}: ${(err as Error).message}`);
  }
}
