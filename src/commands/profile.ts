import { Command } from 'commander';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { listProfiles, setProfile, deleteProfile, getProfile } from '../profiles.js';

export function registerProfileCommands(program: Command): void {
  const profile = program.command('profile').description('Manage named profiles for multiple accounts');

  profile
    .command('list')
    .description('List all configured profiles')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log('No profiles configured. Use: meta-ads profile create --name <name> --access-token <token>');
        return;
      }
      // Mask tokens for display
      const display = profiles.map(p => ({
        ...p,
        accessToken: p.accessToken ? `${p.accessToken.substring(0, 10)}...` : undefined,
        appSecret: p.appSecret ? '***' : undefined,
      }));
      console.log(formatOutput(display, opts.output as OutputFormat));
    }));

  profile
    .command('get <name>')
    .description('Show details for a profile')
    .option('--show-token', 'Show full access token (hidden by default)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (name: string, opts) => {
      const p = getProfile(name);
      if (!p) {
        throw new Error(`Profile "${name}" not found`);
      }
      const display = {
        ...p,
        accessToken: opts.showToken ? p.accessToken : (p.accessToken ? `${p.accessToken.substring(0, 10)}...` : undefined),
        appSecret: opts.showToken ? p.appSecret : (p.appSecret ? '***' : undefined),
      };
      console.log(formatOutput(display, opts.output as OutputFormat));
    }));

  profile
    .command('create')
    .description('Create or update a named profile')
    .requiredOption('--name <name>', 'Profile name (e.g., client-a, production, staging)')
    .option('--access-token <token>', 'Access token')
    .option('--account-id <id>', 'Default ad account ID (act_XXX)')
    .option('--app-id <id>', 'Meta App ID')
    .option('--app-secret <secret>', 'Meta App Secret')
    .option('--api-version <version>', 'Graph API version')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const p = getProfile(opts.name) || { name: opts.name };

      if (opts.accessToken) p.accessToken = opts.accessToken;
      if (opts.accountId) p.accountId = opts.accountId;
      if (opts.appId) p.appId = opts.appId;
      if (opts.appSecret) p.appSecret = opts.appSecret;
      if (opts.apiVersion) p.apiVersion = opts.apiVersion;

      setProfile(p);
      console.log(formatOutput({ message: `Profile "${opts.name}" saved`, profile: { ...p, accessToken: p.accessToken ? `${p.accessToken.substring(0, 10)}...` : undefined, appSecret: p.appSecret ? '***' : undefined } }, opts.output as OutputFormat));
    }));

  profile
    .command('delete <name>')
    .description('Delete a profile')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (name: string, opts) => {
      const deleted = deleteProfile(name);
      if (!deleted) {
        throw new Error(`Profile "${name}" not found`);
      }
      console.log(formatOutput({ message: `Profile "${name}" deleted` }, opts.output as OutputFormat));
    }));

  profile
    .command('use <name>')
    .description('Show environment export commands for a profile')
    .action(handleErrors(async (name: string) => {
      const p = getProfile(name);
      if (!p) {
        throw new Error(`Profile "${name}" not found`);
      }
      console.log(`# Run these commands to activate profile "${name}":`);
      if (p.accessToken) console.log(`export META_ADS_CLI_ACCESS_TOKEN="${p.accessToken}"`);
      if (p.accountId) console.log(`export META_ADS_CLI_ACCOUNT_ID="${p.accountId}"`);
      if (p.appId) console.log(`export META_ADS_CLI_APP_ID="${p.appId}"`);
      if (p.appSecret) console.log(`export META_ADS_CLI_APP_SECRET="${p.appSecret}"`);
      if (p.apiVersion) console.log(`export META_ADS_CLI_API_VERSION="${p.apiVersion}"`);
      console.log(`\n# Or use inline: meta-ads --profile ${name} campaigns list`);
    }));
}
