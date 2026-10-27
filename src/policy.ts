import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from './private-file.js';
import { PolicyError } from './errors.js';

/**
 * Guardrails for delegated or agent access, read from a policy file that the
 * account owner controls. To make it tamper-resistant, have a different user
 * (e.g. root) own it and leave it read-only for the agent's user:
 *   sudo chown root:root policy.json && sudo chmod 644 policy.json
 * and point META_ADS_CLI_POLICY_FILE at it in the agent's environment.
 */
export interface Policy {
  /** Ad accounts (act_XXX) the CLI may touch. Empty/absent = any. */
  accountAllowlist?: string[];
  /** Cents ceiling on any budget field in a write (combined with other caps; the lowest wins). */
  maxSpendCapCents?: number;
  /** Cents ceiling on the sum of daily budgets of active campaigns and ad sets in an account. */
  maxAccountDailyBudgetCents?: number;
  /** Writes that set an object ACTIVE need --allow-live. */
  blockGoingLive?: boolean;
  /** Deletes and archives need --allow-delete. */
  blockDeletes?: boolean;
  /** Sending Messenger/WhatsApp/Instagram messages needs --allow-messaging. */
  blockMessaging?: boolean;
  /** Block every write. */
  readOnly?: boolean;
}

const KEYS: Record<keyof Policy, 'string[]' | 'cents' | 'boolean'> = {
  accountAllowlist: 'string[]',
  maxSpendCapCents: 'cents',
  maxAccountDailyBudgetCents: 'cents',
  blockGoingLive: 'boolean',
  blockDeletes: 'boolean',
  blockMessaging: 'boolean',
  readOnly: 'boolean',
};

export interface LoadedPolicy {
  policy: Policy;
  path: string;
  exists: boolean;
}

export function policyPath(): string | undefined {
  if (process.env.META_ADS_CLI_POLICY_FILE) return process.env.META_ADS_CLI_POLICY_FILE;
  // Don't let a developer's real policy leak into the test suite.
  if (process.env.VITEST) return undefined;
  return path.join(CONFIG_DIR, 'policy.json');
}

/** Validate a parsed policy object, throwing on unknown keys or bad types. */
export function validatePolicy(raw: unknown, source: string): Policy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyError(`Policy file ${source} must contain a JSON object`);
  }
  const policy: Policy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith('$') || key === 'comment') continue;
    const kind = KEYS[key as keyof Policy];
    if (!kind) {
      throw new PolicyError(`Policy file ${source}: unknown setting "${key}". Known: ${Object.keys(KEYS).join(', ')}`);
    }
    if (kind === 'boolean' && typeof value !== 'boolean') {
      throw new PolicyError(`Policy file ${source}: "${key}" must be true or false`);
    }
    if (kind === 'cents' && !(Number.isInteger(value) && (value as number) >= 0)) {
      throw new PolicyError(`Policy file ${source}: "${key}" must be a whole number of cents`);
    }
    if (kind === 'string[]') {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !/^act_\d+$/.test(v))) {
        throw new PolicyError(`Policy file ${source}: "${key}" must be a list of act_XXX account IDs`);
      }
    }
    (policy as Record<string, unknown>)[key] = value;
  }
  return policy;
}

let cached: LoadedPolicy | undefined;

/**
 * Load the policy once per process. A missing file means no policy; a file
 * that exists but can't be parsed or validated is an error, so a broken
 * policy never silently turns the guardrails off.
 */
export function loadPolicy(): LoadedPolicy {
  if (cached) return cached;
  const file = policyPath();
  if (!file || !fs.existsSync(file)) {
    cached = { policy: {}, path: file ?? '', exists: false };
    return cached;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PolicyError(`Policy file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  cached = { policy: validatePolicy(raw, file), path: file, exists: true };
  return cached;
}

/** For tests. */
export function resetPolicyCache(): void {
  cached = undefined;
}

/** Whether the current user could edit the policy file (so an agent could loosen it). */
export function policyWritableByCurrentUser(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
