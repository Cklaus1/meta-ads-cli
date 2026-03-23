import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  validateSafeOutputDir,
  validateSafeFilePath,
  rejectControlChars,
  validateAccountId,
  validateEntityId,
} from '../../src/validate.js';

describe('validateSafeOutputDir', () => {
  it('accepts relative path within cwd', () => {
    const result = validateSafeOutputDir('output');
    expect(result).toBe(path.resolve('output'));
  });

  it('accepts nested relative path', () => {
    const result = validateSafeOutputDir('data/reports');
    expect(result).toBe(path.resolve('data/reports'));
  });

  it('rejects absolute path', () => {
    expect(() => validateSafeOutputDir('/tmp/evil')).toThrow(
      'Output directory must be a relative path'
    );
  });

  it('rejects path traversal escaping cwd', () => {
    expect(() => validateSafeOutputDir('../../etc')).toThrow(
      'Output directory must be within current working directory'
    );
  });
});

describe('validateSafeFilePath', () => {
  it('resolves a valid relative path', () => {
    const result = validateSafeFilePath('file.txt');
    expect(result).toBe(path.resolve('file.txt'));
  });

  it('resolves an absolute path', () => {
    const result = validateSafeFilePath('/tmp/file.txt');
    expect(result).toBe('/tmp/file.txt');
  });

  it('rejects paths with null bytes', () => {
    expect(() => validateSafeFilePath('file\0.txt')).toThrow('null bytes');
  });

  it('rejects paths with control characters', () => {
    expect(() => validateSafeFilePath('file\x07.txt')).toThrow(
      'invalid control characters'
    );
  });
});

describe('rejectControlChars', () => {
  it('allows normal text', () => {
    expect(() => rejectControlChars('hello world', 'field')).not.toThrow();
  });

  it('allows tabs and newlines', () => {
    expect(() => rejectControlChars('line1\nline2\ttab', 'field')).not.toThrow();
  });

  it('allows carriage return', () => {
    expect(() => rejectControlChars('line1\r\nline2', 'field')).not.toThrow();
  });

  it('rejects null byte', () => {
    expect(() => rejectControlChars('\x00', 'field')).toThrow(
      'field contains invalid control characters'
    );
  });

  it('rejects bell character', () => {
    expect(() => rejectControlChars('\x07', 'field')).toThrow(
      'field contains invalid control characters'
    );
  });

  it('rejects backspace', () => {
    expect(() => rejectControlChars('\x08', 'field')).toThrow(
      'field contains invalid control characters'
    );
  });

  it('rejects DEL character', () => {
    expect(() => rejectControlChars('\x7F', 'field')).toThrow(
      'field contains invalid control characters'
    );
  });

  it('includes field name in error message', () => {
    expect(() => rejectControlChars('\x01', 'username')).toThrow(
      'username contains invalid control characters'
    );
  });
});

describe('validateAccountId', () => {
  it('accepts valid act_ prefixed ID', () => {
    expect(validateAccountId('act_123456789')).toBe('act_123456789');
  });

  it('auto-prefixes act_ if missing', () => {
    expect(validateAccountId('123456789')).toBe('act_123456789');
  });

  it('rejects empty string', () => {
    expect(() => validateAccountId('')).toThrow('Account ID is required');
  });

  it('rejects non-numeric after act_', () => {
    expect(() => validateAccountId('act_abc')).toThrow('Invalid account ID format');
  });

  it('rejects special characters', () => {
    expect(() => validateAccountId('act_123-456')).toThrow('Invalid account ID format');
  });

  it('includes original ID in error message', () => {
    expect(() => validateAccountId('bad_id')).toThrow('bad_id');
  });
});

describe('validateEntityId', () => {
  it('accepts numeric ID', () => {
    expect(validateEntityId('12345', 'campaign')).toBe('12345');
  });

  it('rejects empty string', () => {
    expect(() => validateEntityId('', 'campaign')).toThrow('campaign ID is required');
  });

  it('rejects non-numeric ID', () => {
    expect(() => validateEntityId('abc123', 'ad')).toThrow('Invalid ad ID: abc123');
  });

  it('rejects ID with special characters', () => {
    expect(() => validateEntityId('123-456', 'adset')).toThrow(
      'Invalid adset ID'
    );
  });

  it('includes entity type in error', () => {
    expect(() => validateEntityId('bad', 'creative')).toThrow('creative');
  });
});
