import path from 'path';

/**
 * Validates that an output directory path is safe (no path traversal).
 */
export function validateSafeOutputDir(dir: string): string {
  if (path.isAbsolute(dir)) {
    throw new Error(`Output directory must be a relative path, got: ${dir}`);
  }
  const resolved = path.resolve(dir);
  const rel = path.relative(process.cwd(), resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Output directory must be within current working directory`);
  }
  return resolved;
}

/**
 * Validates that a file path is safe for reading/writing.
 */
export function validateSafeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  // Allow absolute paths but reject path traversal components
  if (filePath.includes('\0')) {
    throw new Error('File path contains null bytes');
  }
  rejectControlChars(filePath, 'file path');
  return resolved;
}

/**
 * Rejects strings containing control characters (except newline/tab).
 */
export function rejectControlChars(input: string, fieldName: string): void {
  // eslint-disable-next-line no-control-regex
  const controlRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
  if (controlRegex.test(input)) {
    throw new Error(`${fieldName} contains invalid control characters`);
  }
}

/**
 * Validates a Meta Ads account ID format.
 */
export function validateAccountId(accountId: string): string {
  if (!accountId) {
    throw new Error('Account ID is required');
  }
  // Ensure act_ prefix
  const id = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
  // Validate format: act_ followed by digits
  if (!/^act_\d+$/.test(id)) {
    throw new Error(`Invalid account ID format: ${accountId}. Expected: act_XXXXXXXXX`);
  }
  return id;
}

/**
 * Validates a numeric ID (campaign, adset, ad, etc.)
 */
export function validateEntityId(id: string, entityType: string): string {
  if (!id) {
    throw new Error(`${entityType} ID is required`);
  }
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid ${entityType} ID: ${id}. Expected numeric ID.`);
  }
  return id;
}

/**
 * Validates a Graph API endpoint path before it is put into a URL. Every
 * segment must be a plain object ID or edge name, so a user-supplied ID can't
 * smuggle in a query string, another path, or encoded characters (which
 * would let budget params bypass the spend-cap guard).
 */
export function validateEndpoint(endpoint: string): string {
  const segments = endpoint.split('/');
  if (!endpoint || segments.some(seg => !/^[A-Za-z0-9_]+$/.test(seg))) {
    throw new Error(`Invalid ID or endpoint: "${endpoint}". IDs may contain only letters, digits and underscores.`);
  }
  return endpoint;
}

/**
 * Parses a non-negative integer number of cents from a flag, env var or
 * profile. Throws instead of silently ignoring bad input, so a typo can't
 * disable the spend-cap guard.
 */
export function parseCents(value: string | number | undefined, source: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`${source} must be a whole number of cents, got: "${value}"`);
  }
  return Number(str);
}
