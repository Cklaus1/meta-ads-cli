import { Command } from 'commander';
import { AuthManager } from '../auth.js';

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
      const scope = 'business_management,public_profile,pages_show_list,pages_read_engagement,ads_management,ads_read,read_insights,leads_retrieval';
      const url = `https://www.facebook.com/v24.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent('http://localhost:8899/callback')}&scope=${scope}&response_type=token`;
      console.log('\nOpen this URL in your browser to authenticate:\n');
      console.log(`  ${url}\n`);
    });

  auth
    .command('refresh-token')
    .description('Refresh the current access token for extended validity')
    .action(async () => {
      const authManager = getAuth();
      await authManager.initialize();
      try {
        const token = await authManager.getToken();
        const appId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID || '';
        const appSecret = process.env.META_ADS_CLI_APP_SECRET || process.env.META_APP_SECRET || '';

        if (!appSecret) {
          console.error('App Secret required for token refresh. Set META_ADS_CLI_APP_SECRET');
          process.exit(1);
        }

        const url = `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`;
        const response = await fetch(url);
        if (!response.ok) {
          const err = await response.text();
          console.error(`Token refresh failed: ${err}`);
          process.exit(1);
        }
        const data = await response.json() as { access_token: string; expires_in?: number };
        console.log(`Token refreshed successfully.`);
        if (data.expires_in) {
          console.log(`Expires in: ${Math.round(data.expires_in / 86400)} days`);
        }
        console.log(`\nNew token: ${data.access_token.slice(0, 20)}...`);
        console.log('\nTo use it, set: META_ADS_CLI_ACCESS_TOKEN=<token>');
      } catch (err) {
        console.error('Token refresh failed:', (err as Error).message);
        process.exit(1);
      }
    });
}
