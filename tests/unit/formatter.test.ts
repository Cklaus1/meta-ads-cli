import { describe, it, expect } from 'vitest';
import { formatOutput, type OutputFormat } from '../../src/formatter.js';

describe('formatOutput', () => {
  describe('json format', () => {
    it('pretty-prints objects', () => {
      const data = { id: '1', name: 'Test' };
      const result = formatOutput(data, 'json');
      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it('pretty-prints arrays', () => {
      const data = [1, 2, 3];
      expect(formatOutput(data, 'json')).toBe(JSON.stringify(data, null, 2));
    });

    it('handles null', () => {
      expect(formatOutput(null, 'json')).toBe('null');
    });
  });

  describe('table format', () => {
    it('renders array of objects as table', () => {
      const data = [
        { id: '1', name: 'Campaign A' },
        { id: '2', name: 'Campaign B' },
      ];
      const result = formatOutput(data, 'table');
      const lines = result.split('\n');
      // header, separator, 2 data rows
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('id');
      expect(lines[0]).toContain('name');
      expect(lines[1]).toMatch(/^-+/);
      expect(lines[2]).toContain('1');
      expect(lines[2]).toContain('Campaign A');
    });

    it('extracts items from data.data wrapper', () => {
      const data = { data: [{ id: '1' }, { id: '2' }] };
      const result = formatOutput(data, 'table');
      expect(result).toContain('1');
      expect(result).toContain('2');
    });

    it('extracts items from data.value wrapper', () => {
      const data = { value: [{ id: '10' }] };
      const result = formatOutput(data, 'table');
      expect(result).toContain('10');
    });

    it('returns "(no results)" for empty array', () => {
      expect(formatOutput([], 'table')).toBe('(no results)');
    });

    it('handles non-object items', () => {
      const result = formatOutput(['hello', 'world'], 'table');
      expect(result).toContain('hello');
      expect(result).toContain('world');
    });

    it('flattens nested objects with dot notation', () => {
      const data = [{ id: '1', targeting: { age_min: 18 } }];
      const result = formatOutput(data, 'table');
      expect(result).toContain('targeting.age_min');
      expect(result).toContain('18');
    });

    it('truncates long values to 50 chars', () => {
      const longVal = 'a'.repeat(80);
      const data = [{ text: longVal }];
      const result = formatOutput(data, 'table');
      const dataRow = result.split('\n')[2];
      // value should be truncated
      expect(dataRow).not.toContain(longVal);
      expect(dataRow).toContain('a'.repeat(50));
    });
  });

  describe('csv format', () => {
    it('renders header and rows', () => {
      const data = [
        { id: '1', name: 'Test' },
        { id: '2', name: 'Demo' },
      ];
      const result = formatOutput(data, 'csv');
      const lines = result.split('\n');
      expect(lines[0]).toBe('id,name');
      expect(lines[1]).toBe('1,Test');
      expect(lines[2]).toBe('2,Demo');
    });

    it('escapes values with commas', () => {
      const data = [{ desc: 'hello, world' }];
      const result = formatOutput(data, 'csv');
      expect(result).toContain('"hello, world"');
    });

    it('escapes values with quotes', () => {
      const data = [{ desc: 'say "hello"' }];
      const result = formatOutput(data, 'csv');
      expect(result).toContain('"say ""hello"""');
    });

    it('escapes values with newlines', () => {
      const data = [{ desc: 'line1\nline2' }];
      const result = formatOutput(data, 'csv');
      expect(result).toContain('"line1\nline2"');
    });

    it('returns empty string for empty array', () => {
      expect(formatOutput([], 'csv')).toBe('');
    });
  });

  describe('text format', () => {
    it('renders numbered entries for arrays', () => {
      const data = [
        { id: '1', name: 'A' },
        { id: '2', name: 'B' },
      ];
      const result = formatOutput(data, 'text');
      expect(result).toContain('[1]');
      expect(result).toContain('[2]');
      expect(result).toContain('id: 1');
      expect(result).toContain('name: A');
    });

    it('renders single object as key-value pairs', () => {
      const data = { id: '1', name: 'Test' };
      // Single non-array object wraps in [data] via extractItems → [data]
      const result = formatOutput(data, 'text');
      expect(result).toContain('id: 1');
      expect(result).toContain('name: Test');
    });

    it('handles null/undefined values as empty strings', () => {
      const data = [{ id: '1', extra: null }];
      const result = formatOutput(data, 'text');
      expect(result).toContain('extra: ');
    });
  });

  describe('yaml format', () => {
    it('renders object as YAML', () => {
      const data = { id: 1, name: 'Test' };
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('id: 1');
      expect(result).toContain('name: Test');
    });

    it('renders nested objects', () => {
      const data = { campaign: { id: 1, status: 'ACTIVE' } };
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('campaign:');
      expect(result).toContain('  id: 1');
      expect(result).toContain('  status: ACTIVE');
    });

    it('renders arrays with dash prefix', () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('- id: 1');
      expect(result).toContain('- id: 2');
    });

    it('renders empty array as []', () => {
      const result = formatOutput([], 'yaml');
      expect(result.trim()).toBe('[]');
    });

    it('renders empty object as {}', () => {
      const result = formatOutput({}, 'yaml');
      expect(result.trim()).toBe('{}');
    });

    it('renders null as null', () => {
      const result = formatOutput(null, 'yaml');
      expect(result.trim()).toBe('null');
    });

    it('quotes strings with special characters', () => {
      const data = { msg: 'hello: world' };
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('"hello: world"');
    });

    it('escapes newlines in strings', () => {
      const data = { msg: 'line1\nline2' };
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('\\n');
    });

    it('renders boolean and number values', () => {
      const data = { active: true, count: 42 };
      const result = formatOutput(data, 'yaml');
      expect(result).toContain('active: true');
      expect(result).toContain('count: 42');
    });
  });

  describe('default/unknown format', () => {
    it('falls back to JSON for unknown format', () => {
      const data = { id: 1 };
      const result = formatOutput(data, 'unknown' as OutputFormat);
      expect(result).toBe(JSON.stringify(data, null, 2));
    });
  });
});
