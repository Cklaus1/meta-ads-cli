import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import crypto from 'crypto';
import fs from 'fs';
import { handleErrors, UsageError } from '../errors.js';
import { getProfile, setProfile } from '../profiles.js';
import { upsertEnv } from './setup.js';
import { writePrivateFile } from '../private-file.js';

export function registerBusinessCommands(program: Command, getClient: () => MetaClient): void {
  const biz = program.command('business').alias('bm').description('Business Manager: accounts, pages, pixels, users, permissions');

  biz
    .command('get <businessId>')
    .description('Get Business Manager details')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(businessId, {
        params: { fields: 'id,name,primary_page,link,verification_status,created_time,updated_time,profile_picture_uri,timezone_id' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('ad-accounts <businessId>')
    .description('List ad accounts owned by or shared with a business')
    .option('--type <type>', 'Type: owned, client', 'owned')
    .option('--limit <n>', 'Maximum results', '25')
    .option('--all', 'Fetch all pages')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const endpoint = opts.type === 'client'
        ? `${businessId}/client_ad_accounts`
        : `${businessId}/owned_ad_accounts`;
      const params: Record<string, string> = {
        fields: 'id,name,account_id,account_status,currency,amount_spent,balance,business_name',
        limit: opts.limit,
      };
      const response = opts.all
        ? await client.requestAllPages(endpoint, { params })
        : await client.request(endpoint, { params });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('pages <businessId>')
    .description('List pages owned by or shared with a business')
    .option('--type <type>', 'Type: owned, client', 'owned')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const endpoint = opts.type === 'client'
        ? `${businessId}/client_pages`
        : `${businessId}/owned_pages`;
      const response = await client.request(endpoint, {
        params: { fields: 'id,name,category,fan_count,link,verification_status' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('pixels <businessId>')
    .description('List pixels owned by a business')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${businessId}/owned_pixels`, {
        params: { fields: 'id,name,creation_time,last_fired_time,is_created_by_app' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('pixel-accounts <pixelId>')
    .description('List the ad accounts a pixel is shared with')
    .requiredOption('--business-id <id>', 'Business that owns the pixel')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pixelId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${pixelId}/shared_accounts`, {
        params: { business: opts.businessId, fields: 'id,name,account_status' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('share-pixel <pixelId>')
    .description('Share a business-owned pixel with an ad account, so its ad sets can optimize for the pixel\'s events')
    .requiredOption('--account-id <id>', 'Ad account to share with (act_XXX)')
    .requiredOption('--business-id <id>', 'Business that owns the pixel')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (pixelId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${pixelId}/shared_accounts`, {
        method: 'POST',
        body: { account_id: String(opts.accountId).replace(/^act_/, ''), business: opts.businessId },
      });
      console.log(formatOutput({ pixel_id: pixelId, account_id: opts.accountId, response: response.data }, opts.output as OutputFormat));
    }));

  biz
    .command('users <businessId>')
    .description('List users in a Business Manager')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${businessId}/business_users`, {
        params: { fields: 'id,name,email,role,two_fac_status,created_time' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('system-users <businessId>')
    .description('List system users in a Business Manager')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${businessId}/system_users`, {
        params: { fields: 'id,name,role,created_time' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('system-user-token <systemUserId>')
    .description('Generate an access token for a system user (non-expiring unless --expiring) and save it to a profile or .env file. The token is never printed.')
    .option('--app-id <id>', 'App to issue the token for (default: META_ADS_CLI_APP_ID)')
    .option('--scope <permissions>', 'Comma-separated permissions', 'ads_management,ads_read,business_management,read_insights')
    .option('--expiring', 'Issue a 60-day token instead of a non-expiring one')
    .option('--save-profile <name>', 'Save the token as this profile\'s access token (creates the profile if needed)')
    .option('--update-env <file>', 'Write the token to META_ADS_CLI_ACCESS_TOKEN in this .env file')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (systemUserId: string, opts) => {
      if (!opts.saveProfile && !opts.updateEnv) throw new UsageError('Pass --save-profile <name> or --update-env <file> so the token is stored, not printed');
      const appId = opts.appId || process.env.META_ADS_CLI_APP_ID;
      const appSecret = process.env.META_ADS_CLI_APP_SECRET;
      if (!appId || !appSecret) throw new UsageError('META_ADS_CLI_APP_ID and META_ADS_CLI_APP_SECRET are required (appsecret_proof)');
      const client = getClient();
      const callerToken = process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
      if (!callerToken) throw new UsageError('An admin user token is required in META_ADS_CLI_ACCESS_TOKEN');
      const proof = crypto.createHmac('sha256', appSecret).update(callerToken).digest('hex');

      // The app must be installed for the system user before it can get a token.
      await client.request(`${systemUserId}/applications`, { method: 'POST', body: { business_app: appId } });
      const resp = await client.request(`${systemUserId}/access_tokens`, {
        method: 'POST',
        body: {
          business_app: appId,
          scope: opts.scope,
          appsecret_proof: proof,
          ...(opts.expiring ? { set_token_expires_in_60_days: 'true' } : {}),
        },
      });
      const token = (resp.data as { access_token?: string }).access_token;
      if (!token) {
        if (client.isPreviewMode()) {
          console.log(formatOutput({ system_user_id: systemUserId, preview: true }, opts.output as OutputFormat));
          return;
        }
        throw new Error('Meta did not return a token');
      }

      const saved: string[] = [];
      if (opts.saveProfile) {
        const existing = getProfile(opts.saveProfile) || { name: opts.saveProfile };
        const { storedIn } = await setProfile({ ...existing, accessToken: token });
        saved.push(`profile ${opts.saveProfile} (${storedIn})`);
      }
      if (opts.updateEnv) {
        const content = fs.existsSync(opts.updateEnv) ? fs.readFileSync(opts.updateEnv, 'utf8') : '';
        writePrivateFile(opts.updateEnv, upsertEnv(content, { META_ADS_CLI_ACCESS_TOKEN: token }));
        saved.push(opts.updateEnv);
      }
      console.log(formatOutput({
        system_user_id: systemUserId,
        app_id: appId,
        scope: opts.scope,
        expires: opts.expiring ? 'in 60 days' : 'never',
        saved_to: saved,
      }, opts.output as OutputFormat));
    }));

  biz
    .command('create-system-user <businessId>')
    .description('Create a system user')
    .requiredOption('--name <name>', 'System user name')
    .requiredOption('--role <role>', 'Role: ADMIN, EMPLOYEE')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${businessId}/system_users`, {
        method: 'POST',
        body: { name: opts.name, role: opts.role },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('assign-ad-account')
    .description('Assign an ad account to a user or system user')
    .requiredOption('--user-id <id>', 'User or system user ID')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)')
    .requiredOption('--tasks <tasks>', 'Comma-separated tasks: ANALYZE, ADVERTISE, MANAGE')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request(`${opts.accountId}/assigned_users`, {
        method: 'POST',
        body: { user: opts.userId, tasks: JSON.stringify(opts.tasks.split(',')) },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('assign-page')
    .description('Assign a page to a user or system user')
    .requiredOption('--user-id <id>', 'User or system user ID')
    .requiredOption('--page-id <id>', 'Page ID')
    .requiredOption('--tasks <tasks>', 'Comma-separated tasks: ANALYZE, ADVERTISE, MANAGE, CREATE_CONTENT, MODERATE, MESSAGING')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request(`${opts.pageId}/assigned_users`, {
        method: 'POST',
        body: { user: opts.userId, tasks: JSON.stringify(opts.tasks.split(',')) },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('share-ad-account')
    .description('Share an ad account with a partner business')
    .requiredOption('--business-id <id>', 'Your business ID')
    .requiredOption('--account-id <id>', 'Ad account ID to share')
    .requiredOption('--partner-id <id>', 'Partner business ID')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request(`${opts.accountId}/agencies`, {
        method: 'POST',
        body: { business: opts.partnerId },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  biz
    .command('credit-lines <businessId>')
    .description('List extended credit lines for a business')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (businessId: string, opts) => {
      const client = getClient();
      const response = await client.request(`${businessId}/extendedcredits`, {
        params: { fields: 'id,legal_entity_name,max_balance,allocated_amount,balance,partition_from' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
