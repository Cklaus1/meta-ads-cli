import { Command } from 'commander';
import { AuthManager, authScope } from '../auth.js';

export function registerAuthCommands(program: Command, getAuth: () => AuthManager): void {
  const auth = program.command('auth').description('Authentication management');

  auth
    .command('login')
    .description('Login via Meta OAuth flow (opens browser)')
    .action(async () => {
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
    });

  auth
    .command('logout')
    .description('Log out and clear saved credentials')
    .action(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      await authManager.logout();
      console.log('Logged out successfully.');
    });

  auth
    .command('status')
    .description('Verify current login status')
    .action(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      const result = await authManager.verifyLogin();
      if (result.success && result.user) {
        console.log(`Logged in as ${result.user.name} (ID: ${result.user.id})`);
        console.log(`App ID: ${authManager.getAppId() || '(not set)'}`);
      } else {
        console.log('Not logged in. Run: meta-ads auth login');
      }
    });

  auth
    .command('setup')
    .description('Configure Meta App credentials')
    .action(async () => {
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
    });

  auth
    .command('login-link')
    .description('Generate a login URL for authentication')
    .action(async () => {
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
    });

  auth
    .command('refresh-token')
    .description('Exchange the current token for a long-lived one and cache it')
    .option('--print', 'Also print the full new token to stdout (for piping)')
    .action(async (opts) => {
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
    });
}
