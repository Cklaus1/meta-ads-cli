import fs from 'fs';
import path from 'path';
import { CONFIG_DIR, ensurePrivateDir, writePrivateFile } from './private-file.js';
import { parseCents } from './validate.js';
import { keychainDelete, keychainGet, keychainSet } from './auth.js';

const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'config.json');

export interface Profile {
  name: string;
  accessToken?: string;
  accountId?: string;
  appId?: string;
  appSecret?: string;
  apiVersion?: string;
  /** Cents ceiling on budget fields in writes (feeds the spend-cap guard). */
  maxSpendCap?: number;
  /** Free-form labels, e.g. a client name, for `profile list --tag`. */
  tags?: string[];
  /** True when accessToken/appSecret are stored in the OS keychain instead of this file. */
  secretsInKeychain?: boolean;
}

interface Settings {
  defaultProfile?: string;
}

function loadProfiles(): Record<string, Profile> {
  try {
    if (fs.existsSync(PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function saveProfiles(profiles: Record<string, Profile>): void {
  ensurePrivateDir();
  writePrivateFile(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    // ignore
  }
  return {};
}

function saveSettings(settings: Settings): void {
  ensurePrivateDir();
  writePrivateFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

const keychainAccount = (name: string) => `profile:${name}`;

export function getProfile(name: string): Profile | undefined {
  const profiles = loadProfiles();
  return profiles[name];
}

/**
 * Save a profile. Secrets go to the OS keychain when it's available; the
 * profiles file (0600) is the fallback.
 */
export async function setProfile(profile: Profile): Promise<{ storedIn: 'keychain' | 'file' }> {
  const profiles = loadProfiles();
  const stored: Profile = { ...profile };
  let storedIn: 'keychain' | 'file' = 'file';
  if (profile.accessToken || profile.appSecret) {
    const existing = profile.secretsInKeychain ? await readKeychainSecrets(profile.name) : {};
    const secrets = {
      accessToken: profile.accessToken ?? existing.accessToken,
      appSecret: profile.appSecret ?? existing.appSecret,
    };
    if (await keychainSet(keychainAccount(profile.name), JSON.stringify(secrets))) {
      delete stored.accessToken;
      delete stored.appSecret;
      stored.secretsInKeychain = true;
      storedIn = 'keychain';
    } else {
      stored.secretsInKeychain = false;
    }
  } else if (profile.secretsInKeychain) {
    storedIn = 'keychain';
  }
  profiles[profile.name] = stored;
  saveProfiles(profiles);
  return { storedIn };
}

export async function deleteProfile(name: string): Promise<boolean> {
  const profiles = loadProfiles();
  if (!profiles[name]) return false;
  if (profiles[name].secretsInKeychain) await keychainDelete(keychainAccount(name));
  delete profiles[name];
  saveProfiles(profiles);
  const settings = loadSettings();
  if (settings.defaultProfile === name) {
    delete settings.defaultProfile;
    saveSettings(settings);
  }
  return true;
}

export function listProfiles(tag?: string): Profile[] {
  const profiles = Object.values(loadProfiles());
  return tag ? profiles.filter(p => p.tags?.includes(tag)) : profiles;
}

export function getDefaultProfileName(): string | undefined {
  return loadSettings().defaultProfile;
}

export function setDefaultProfile(name: string | undefined): void {
  const settings = loadSettings();
  if (name) settings.defaultProfile = name;
  else delete settings.defaultProfile;
  saveSettings(settings);
}

async function readKeychainSecrets(name: string): Promise<{ accessToken?: string; appSecret?: string }> {
  const raw = await keychainGet(keychainAccount(name));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** A profile with its keychain secrets filled in. */
export async function resolveProfile(name: string): Promise<Profile | undefined> {
  const profile = getProfile(name);
  if (!profile) return undefined;
  if (!profile.secretsInKeychain) return profile;
  const secrets = await readKeychainSecrets(name);
  return { ...profile, ...secrets };
}

/**
 * Apply a profile's settings to the environment.
 * Called early in CLI startup when --profile is used, or for the default
 * profile. With `onlyUnset`, values already in the environment win (used for
 * the default profile, so an explicit env var isn't silently overridden).
 */
export async function applyProfile(name: string, opts: { onlyUnset?: boolean } = {}): Promise<void> {
  // A default profile can't override an env token, so don't pay for (or
  // fail on) a keychain read in that case.
  const envToken = process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
  const profile = opts.onlyUnset && envToken ? getProfile(name) : await resolveProfile(name);
  if (!profile) {
    throw new Error(`Profile "${name}" not found. Use: meta-ads profile list`);
  }
  if (profile.secretsInKeychain && !profile.accessToken && !(opts.onlyUnset && envToken)) {
    throw new Error(`Profile "${name}" keeps its token in the OS keychain, which isn't available here.`);
  }

  const set = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (opts.onlyUnset && process.env[key]) return;
    process.env[key] = value;
  };
  set('META_ADS_CLI_ACCESS_TOKEN', profile.accessToken);
  set('META_ADS_CLI_ACCOUNT_ID', profile.accountId);
  set('META_ADS_CLI_APP_ID', profile.appId);
  set('META_ADS_CLI_APP_SECRET', profile.appSecret);
  set('META_ADS_CLI_API_VERSION', profile.apiVersion);
  // The stricter of the profile cap and any env cap applies.
  const profileCap = parseCents(profile.maxSpendCap, `Profile "${name}" maxSpendCap`);
  if (profileCap) {
    const envCap = parseCents(process.env.META_ADS_CLI_MAX_SPEND_CAP, 'META_ADS_CLI_MAX_SPEND_CAP');
    process.env.META_ADS_CLI_MAX_SPEND_CAP = String(envCap ? Math.min(envCap, profileCap) : profileCap);
  }
}

/** Mask secrets for display. */
export function maskProfile(p: Profile): Record<string, unknown> {
  return {
    ...p,
    accessToken: p.accessToken ? `${p.accessToken.substring(0, 6)}…${p.accessToken.slice(-4)}` : (p.secretsInKeychain ? '(keychain)' : undefined),
    appSecret: p.appSecret ? '***' : (p.secretsInKeychain ? '(keychain)' : undefined),
  };
}
