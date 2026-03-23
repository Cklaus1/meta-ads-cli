import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

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
