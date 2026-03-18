export type OutputFormat = 'json' | 'table' | 'csv' | 'text' | 'yaml';

export function formatOutput(data: unknown, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'table':
      return formatTable(data);
    case 'csv':
      return formatCsv(data);
    case 'text':
      return formatText(data);
    case 'yaml':
      return formatYaml(data);
    default:
      return JSON.stringify(data, null, 2);
  }
}

/**
 * Flatten a nested object into dot-notation keys.
 */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val === null || val === undefined) {
      result[fullKey] = '';
    } else if (Array.isArray(val)) {
      if (val.length > 0 && typeof val[0] === 'object') {
        const summaries = val.map((item) => {
          if (typeof item === 'object' && item !== null) {
            const flat = flattenObject(item as Record<string, unknown>);
            return flat['name'] || flat['id'] || flat['displayName'] || Object.values(flat)[0] || '';
          }
          return String(item);
        });
        result[fullKey] = summaries.join(', ');
      } else {
        result[fullKey] = val.join(', ');
      }
    } else if (typeof val === 'object') {
      Object.assign(result, flattenObject(val as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

function formatTable(data: unknown): string {
  const items = extractItems(data);
  if (items.length === 0) return '(no results)';

  const flatItems = items.map((item) => {
    if (typeof item !== 'object' || item === null) return { value: String(item) };
    return flattenObject(item as Record<string, unknown>);
  });

  const keySet = new Set<string>();
  for (const item of flatItems) {
    for (const key of Object.keys(item)) {
      keySet.add(key);
    }
  }
  const columns = Array.from(keySet);
  if (columns.length === 0) return JSON.stringify(data, null, 2);

  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = col.length;
  }
  for (const item of flatItems) {
    for (const col of columns) {
      const val = item[col] ?? '';
      widths[col] = Math.min(Math.max(widths[col], val.length), 50);
    }
  }

  const header = columns.map(c => c.padEnd(widths[c])).join('  ');
  const separator = columns.map(c => '-'.repeat(widths[c])).join('  ');

  const rows = flatItems.map(item => {
    return columns.map(col => {
      const val = item[col] ?? '';
      return val.substring(0, 50).padEnd(widths[col]);
    }).join('  ');
  });

  return [header, separator, ...rows].join('\n');
}

function formatCsv(data: unknown): string {
  const items = extractItems(data);
  if (items.length === 0) return '';

  const flatItems = items.map((item) => {
    if (typeof item !== 'object' || item === null) return { value: String(item) };
    return flattenObject(item as Record<string, unknown>);
  });

  const keySet = new Set<string>();
  for (const item of flatItems) {
    for (const key of Object.keys(item)) {
      keySet.add(key);
    }
  }
  const columns = Array.from(keySet);
  const header = columns.map(csvEscape).join(',');
  const rows = flatItems.map(item => {
    return columns.map(col => csvEscape(item[col] ?? '')).join(',');
  });

  return [header, ...rows].join('\n');
}

function formatText(data: unknown): string {
  const items = extractItems(data);
  if (items.length === 0) {
    if (typeof data === 'object' && data !== null) {
      const flat = flattenObject(data as Record<string, unknown>);
      return Object.entries(flat)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    }
    return String(data);
  }

  return items.map((item, i) => {
    if (typeof item !== 'object' || item === null) return String(item);
    const flat = flattenObject(item as Record<string, unknown>);
    const entries = Object.entries(flat)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    return `[${i + 1}]\n${entries}`;
  }).join('\n\n');
}

function formatYaml(data: unknown): string {
  return toYaml(data, 0);
}

function toYaml(data: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return `${pad}null\n`;
  if (typeof data === 'boolean') return `${pad}${data}\n`;
  if (typeof data === 'number') return `${pad}${data}\n`;
  if (typeof data === 'string') {
    if (data.includes('\n') || data.includes('"') || data.includes(':')) {
      return `${pad}"${data.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"\n`;
    }
    return `${pad}${data}\n`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of data) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          out += `${pad}- ${firstKey}: ${inlineValue(firstVal)}\n`;
          for (let j = 1; j < entries.length; j++) {
            out += `${pad}  ${entries[j][0]}: ${inlineValue(entries[j][1])}\n`;
          }
          continue;
        }
      }
      out += `${pad}- ${inlineValue(item)}\n`;
    }
    return out;
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}\n`;
    let out = '';
    for (const [key, val] of entries) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        out += `${pad}${key}:\n${toYaml(val, indent + 1)}`;
      } else if (Array.isArray(val)) {
        out += `${pad}${key}:\n${toYaml(val, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${inlineValue(val)}\n`;
      }
    }
    return out;
  }
  return `${pad}${String(data)}\n`;
}

function inlineValue(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    if (val.includes('\n') || val.includes('"') || val.includes(':') || val.includes('#')) {
      return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    }
    return val;
  }
  if (Array.isArray(val)) return JSON.stringify(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function extractItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.value)) return obj.value;
  }
  return [data];
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}
