import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// profiles.ts resolves the config dir at import time, so point HOME at a temp
// dir and import it fresh in each test.
let home: string;
const originalHome = process.env.HOME;
const originalEnv = { ...process.env };

async function load() {
  vi.resetModules();
  return import('../../src/profiles.js');
}

describe('profiles', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    process.env.HOME = home;
    delete process.env.DBUS_SESSION_BUS_ADDRESS; // no keychain → file storage
    process.env.META_ADS_CLI_NO_KEYCHAIN = '1';
    delete process.env.META_ADS_CLI_ACCESS_TOKEN;
    delete process.env.META_ADS_CLI_ACCOUNT_ID;
  });
  afterEach(() => {
    process.env = { ...originalEnv, HOME: originalHome };
  });

  it('stores tags, filters by tag, and masks secrets', async () => {
    const p = await load();
    const { storedIn } = await p.setProfile({ name: 'a', accessToken: 'EAAB1234567890xyz', tags: ['client-x'] });
    await p.setProfile({ name: 'b', accessToken: 'EAAB999' });
    expect(storedIn).toBe('file');
    expect(p.listProfiles('client-x').map(x => x.name)).toEqual(['a']);
    expect(p.maskProfile(p.getProfile('a')!).accessToken).toBe('EAAB12…0xyz');
    const file = path.join(home, '.config', 'meta-ads-cli', 'profiles.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('default profile fills only unset env vars', async () => {
    const p = await load();
    await p.setProfile({ name: 'prod', accessToken: 'PROFILE_TOKEN', accountId: 'act_9' });
    p.setDefaultProfile('prod');
    expect(p.getDefaultProfileName()).toBe('prod');
    process.env.META_ADS_CLI_ACCESS_TOKEN = 'ENV_TOKEN';
    await p.applyProfile('prod', { onlyUnset: true });
    expect(process.env.META_ADS_CLI_ACCESS_TOKEN).toBe('ENV_TOKEN');
    expect(process.env.META_ADS_CLI_ACCOUNT_ID).toBe('act_9');
  });

  it('deleting the default profile clears the default', async () => {
    const p = await load();
    await p.setProfile({ name: 'x', accessToken: 't' });
    p.setDefaultProfile('x');
    expect(await p.deleteProfile('x')).toBe(true);
    expect(p.getDefaultProfileName()).toBeUndefined();
  });
});
