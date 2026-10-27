import { Command } from 'commander';
import fs from 'fs';
import { handleErrors } from '../errors.js';
import { upsertEnv } from './setup.js';
import { writePrivateFile } from '../private-file.js';
import { AuthManager, authScope } from '../auth.js';

export function registerAuthCommands(program: Command, getAuth: () => AuthManager): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Login via Meta OAuth flow (opens browser)')
    .action(handleErrors(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      try {
        await authManager.login();
        const result = await authManager.verifyLogin();
        if (result.success && result.user) {
          console.log(`Logged in as ${result.user.name} (ID: ${result.user.id})`);
        } else {
          console.log('Login completed. Run "meta-ads auth status" to verify.');
        }
      } catch (err) {
        console.error('Login failed:', (err as Error).message);
        process.exit(1);
      }
    }));

  auth
    .command('logout')
    .description('Log out and clear saved credentials')
    .action(handleErrors(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      await authManager.logout();
      console.log('Logged out successfully.');
    }));

  auth
    .command('status')
    .description('Verify current login status')
    .action(handleErrors(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      const result = await authManager.verifyLogin();
      if (result.success && result.user) {
        console.log(`Logged in as ${result.user.name} (ID: ${result.user.id})`);
        console.log(`App ID: ${authManager.getAppId() || '(not set)'}`);
      } else {
        console.log('Not logged in. Run: meta-ads auth login');
      }
    }));

  auth
    .command('setup')
    .description('Configure Meta App credentials')
    .action(handleErrors(async () => {
      console.log('Meta Ads CLI Setup');
      console.log('==================\n');
      console.log('To use this CLI, you need a Meta App with Ads API access.');
      console.log('1. Go to https://developers.facebook.com/apps');
      console.log('2. Create or select an app');
      console.log('3. Add "Marketing API" product to your app\n');
      console.log('Then set these environment variables in your .env file:\n');
      console.log('  META_ADS_CLI_APP_ID=your_app_id');
      console.log('  META_ADS_CLI_APP_SECRET=your_app_secret\n');
      console.log('Optional: Set a default ad account:');
      console.log('  META_ADS_CLI_ACCOUNT_ID=act_XXXXXXXXX\n');
      console.log('After configuration, run: meta-ads auth login');
    }));

  auth
    .command('login-link')
    .description('Generate a login URL for authentication')
    .action(handleErrors(async () => {
      const authManager = getAuth();
      const appId = authManager.getAppId();
      if (!appId) {
        console.error('No App ID configured. Set META_ADS_CLI_APP_ID or run: meta-ads auth setup');
        process.exit(1);
      }
      const url = `https://www.facebook.com/${authManager.getApiVersion()}/dialog/oauth?client_id=${encodeURIComponent(appId)}`
        + `&redirect_uri=${encodeURIComponent('http://localhost:8899/callback')}&scope=${encodeURIComponent(authScope())}&response_type=token`;
      console.log('\nOpen this URL in your browser to authenticate:\n');
      console.log(`  ${url}\n`);
    }));

  auth
    .command('refresh-token')
    .description('Exchange the current token for a long-lived one and cache it')
    .option('--print', 'Also print the full new token to stdout (for piping)')
    .option('--update-env <file>', 'Verify the new token and write it to META_ADS_CLI_ACCESS_TOKEN in this .env file (for scheduled refresh)')
    .option('--warn-days <n>', 'With --update-env: exit 2 when the token expires within this many days and the refresh did not extend it', '14')
    .action(handleErrors(async (opts) => {
      if (opts.updateEnv) {
        await refreshIntoEnvFile(getAuth(), opts.updateEnv, Number(opts.warnDays));
        return;
      }
      const authManager = getAuth();
      await authManager.initialize();
      try {
        const token = await authManager.getToken();
        if (!authManager.getAppSecret()) {
          console.error('App Secret required for token refresh. Set META_ADS_CLI_APP_SECRET');
          process.exit(1);
        }

        const exchanged = await authManager.exchangeForLongLivedToken(token);
        if (!exchanged) {
          console.error('Token refresh failed: Meta did not return a new token.');
          process.exit(1);
        }
        await authManager.storeToken(exchanged.accessToken, exchanged.expiresIn);
        if (opts.print) {
          console.log(exchanged.accessToken);
          return;
        }
        console.log('Token refreshed and saved to the token cache.');
        if (exchanged.expiresIn) {
          console.log(`Expires in: ${Math.round(exchanged.expiresIn / 86400)} days`);
        }
        if (process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN) {
          console.log('\nNote: an access token env var is set and takes priority over the cache. Use --print to get the new token.');
        }
      } catch (err) {
        console.error('Token refresh failed:', (err as Error).message);
        process.exit(1);
      }
    }));
}

/**
 * Scheduled refresh: exchange the token in an .env file for a new long-lived
 * one, check that it works and doesn't expire sooner than the current one,
 * then rewrite only that line. Prints one status line; never prints tokens.
 */
export async function refreshIntoEnvFile(authManager: AuthManager, envFile: string, warnDays: number): Promise<void> {
  const stamp = new Date().toISOString();
  const fail = (msg: string, code = 1): never => {
    console.error(`${stamp} token refresh FAILED: ${msg}`);
    process.exit(code);
  };
  if (!fs.existsSync(envFile)) fail(`${envFile} not found`);
  const content = fs.readFileSync(envFile, 'utf8');
  const current = /^META_ADS_CLI_ACCESS_TOKEN=(.*)$/m.exec(content)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!current) fail(`no META_ADS_CLI_ACCESS_TOKEN line in ${envFile}`);
  if (!authManager.getAppSecret()) fail('META_ADS_CLI_APP_SECRET is required');

  const before = await authManager.inspectToken(current!).catch(err => fail((err as Error).message));
  if (!before.isValid) fail('the current token is no longer valid; get a new one (meta-ads auth login or Graph API Explorer)');

  const exchanged = await authManager.exchangeForLongLivedToken(current!).catch(err => fail((err as Error).message));
  if (!exchanged) fail('Meta did not return a new token');
  const after = await authManager.inspectToken(exchanged!.accessToken).catch(err => fail((err as Error).message));
  if (!after.isValid) fail('the new token is not valid; .env left unchanged');
  if (after.userId && before.userId && after.userId !== before.userId) fail('the new token belongs to a different user; .env left unchanged');

  const days = (exp?: number) => (exp ? Math.round((exp * 1000 - Date.now()) / 86400000) : Infinity);
  const beforeExp = before.expiresAt || 0;
  const afterExp = after.expiresAt || 0;
  // 0 means "never expires"; otherwise only accept a token that lasts at least as long.
  const extended = afterExp === 0 || (beforeExp !== 0 && afterExp >= beforeExp);
  if (!extended) {
    const msg = `the new token expires sooner (${days(afterExp)} days) than the current one (${days(beforeExp)} days); .env left unchanged`;
    if (days(beforeExp) <= warnDays) fail(`${msg}. The token expires soon: get a new one.`, 2);
    console.error(`${stamp} token refresh skipped: ${msg}`);
    return;
  }

  writePrivateFile(envFile, upsertEnv(content, { META_ADS_CLI_ACCESS_TOKEN: exchanged!.accessToken }));
  const expText = afterExp ? `expires ${new Date(afterExp * 1000).toISOString().slice(0, 10)} (${days(afterExp)} days)` : 'does not expire';
  console.log(`${stamp} token refreshed: ${expText}; was ${days(beforeExp)} days`);
  if (afterExp && days(afterExp) <= warnDays) fail(`the token still expires in ${days(afterExp)} days; Meta did not extend it. Get a new one.`, 2);
}
