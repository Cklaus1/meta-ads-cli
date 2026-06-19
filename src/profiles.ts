import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'meta-ads-cli');
const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json');

export interface Profile {
  name: string;
  accessToken?: string;
  accountId?: string;
  appId?: string;
  appSecret?: string;
  apiVersion?: string;
  /** Cents ceiling on budget fields in writes (feeds the spend-cap guard). */
  maxSpendCap?: number;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
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
  ensureConfigDir();
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

export function getProfile(name: string): Profile | undefined {
  const profiles = loadProfiles();
  return profiles[name];
}

export function setProfile(profile: Profile): void {
  const profiles = loadProfiles();
  profiles[profile.name] = profile;
  saveProfiles(profiles);
}

export function deleteProfile(name: string): boolean {
  const profiles = loadProfiles();
  if (profiles[name]) {
    delete profiles[name];
    saveProfiles(profiles);
    return true;
  }
  return false;
}

export function listProfiles(): Profile[] {
  const profiles = loadProfiles();
  return Object.values(profiles);
}

/**
 * Apply a profile's settings to the environment.
 * Called early in CLI startup when --profile is used.
 */
export function applyProfile(name: string): void {
  const profile = getProfile(name);
  if (!profile) {
    throw new Error(`Profile "${name}" not found. Use: meta-ads profile list`);
  }

  if (profile.accessToken) process.env.META_ADS_CLI_ACCESS_TOKEN = profile.accessToken;
  if (profile.accountId) process.env.META_ADS_CLI_ACCOUNT_ID = profile.accountId;
  if (profile.appId) process.env.META_ADS_CLI_APP_ID = profile.appId;
  if (profile.appSecret) process.env.META_ADS_CLI_APP_SECRET = profile.appSecret;
  if (profile.apiVersion) process.env.META_ADS_CLI_API_VERSION = profile.apiVersion;
  // Apply the profile's spend cap unless the env already sets one (explicit env wins).
  if (profile.maxSpendCap !== undefined && process.env.META_ADS_CLI_MAX_SPEND_CAP === undefined) {
    process.env.META_ADS_CLI_MAX_SPEND_CAP = String(profile.maxSpendCap);
  }
}
