import path from 'path';

/**
 * Validates that an output directory path is safe (no path traversal).
 */
export function validateSafeOutputDir(dir: string): string {
  if (path.isAbsolute(dir)) {
    throw new Error(`Output directory must be a relative path, got: ${dir}`);
  }
  const resolved = path.resolve(dir);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd)) {
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
