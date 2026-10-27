import { Command } from 'commander';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, UsageError } from '../errors.js';
import {
  listProfiles, setProfile, deleteProfile, getProfile, resolveProfile, maskProfile,
  getDefaultProfileName, setDefaultProfile, type Profile,
} from '../profiles.js';

export function registerProfileCommands(program: Command): void {
  const profile = program.command('profile').description('Manage named profiles for multiple accounts');

  profile
    .command('list')
    .description('List all configured profiles')
    .option('--tag <tag>', 'Only profiles with this tag')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const profiles = listProfiles(opts.tag);
      if (profiles.length === 0) {
        console.log(opts.tag
          ? `No profiles tagged "${opts.tag}".`
          : 'No profiles configured. Use: meta-ads profile create --name <name> --access-token <token>');
        return;
      }
      const defaultName = getDefaultProfileName();
      const display = profiles.map(p => ({ ...maskProfile(p), default: p.name === defaultName }));
      console.log(formatOutput(display, opts.output as OutputFormat));
    }));

  profile
    .command('get <name>')
    .description('Show details for a profile')
    .option('--show-token', 'Show full access token (hidden by default)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (name: string, opts) => {
      const p = opts.showToken ? await resolveProfile(name) : getProfile(name);
      if (!p) {
        throw new UsageError(`Profile "${name}" not found`);
      }
      const display = opts.showToken ? p : maskProfile(p);
      console.log(formatOutput({ ...display, default: name === getDefaultProfileName() }, opts.output as OutputFormat));
    }));

  profile
    .command('create')
    .description('Create or update a named profile (secrets go to the OS keychain when available)')
    .requiredOption('--name <name>', 'Profile name (e.g., client-a, production, staging)')
    .option('--access-token <token>', 'Access token')
    .option('--account-id <id>', 'Default ad account ID (act_XXX)')
    .option('--app-id <id>', 'Meta App ID')
    .option('--app-secret <secret>', 'Meta App Secret')
    .option('--api-version <version>', 'Graph API version')
    .option('--spend-cap <cents>', 'Cents ceiling on budget fields in writes, stored with the profile (spend-cap guard)')
    .option('--tags <tags>', 'Comma-separated tags, e.g. a client name (replaces existing tags)')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const p: Profile = getProfile(opts.name) || { name: opts.name };

      if (opts.accessToken) p.accessToken = opts.accessToken;
      if (opts.accountId) p.accountId = opts.accountId;
      if (opts.appId) p.appId = opts.appId;
      if (opts.appSecret) p.appSecret = opts.appSecret;
      if (opts.apiVersion) p.apiVersion = opts.apiVersion;
      if (opts.spendCap !== undefined) {
        const cents = Number(opts.spendCap);
        if (!Number.isInteger(cents) || cents < 0) throw new UsageError('--spend-cap must be a whole number of cents');
        p.maxSpendCap = cents;
      }
      if (opts.tags !== undefined) {
        p.tags = String(opts.tags).split(',').map(t => t.trim()).filter(Boolean);
      }

      const { storedIn } = await setProfile(p);
      console.log(formatOutput({
        message: `Profile "${opts.name}" saved`,
        secrets_stored_in: storedIn,
        profile: maskProfile(p),
      }, opts.output as OutputFormat));
    }));

  profile
    .command('delete <name>')
    .description('Delete a profile')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (name: string, opts) => {
      const deleted = await deleteProfile(name);
      if (!deleted) {
        throw new UsageError(`Profile "${name}" not found`);
      }
      console.log(formatOutput({ message: `Profile "${name}" deleted` }, opts.output as OutputFormat));
    }));

  profile
    .command('use [name]')
    .description('Make a profile the default (applied when --profile is not given). --clear removes the default')
    .option('--clear', 'Remove the default profile')
    .option('--print-env', 'Print shell export lines (secrets masked unless --show-token)')
    .option('--show-token', 'With --print-env, print the real token and secret')
    .action(handleErrors(async (name: string | undefined, opts) => {
      if (opts.clear) {
        setDefaultProfile(undefined);
        console.log('Default profile cleared.');
        return;
      }
      if (!name) throw new UsageError('Give a profile name, or --clear');
      const p = opts.showToken ? await resolveProfile(name) : getProfile(name);
      if (!p) {
        throw new UsageError(`Profile "${name}" not found`);
      }
      setDefaultProfile(name);
      console.log(`Default profile set to "${name}". Commands use it unless --profile is given; env vars still take priority.`);
      if (opts.printEnv) {
        const shown = opts.showToken ? p : (maskProfile(p) as unknown as Profile);
        console.log(`\n# Environment for profile "${name}":`);
        if (shown.accessToken) console.log(`export META_ADS_CLI_ACCESS_TOKEN="${shown.accessToken}"`);
        if (p.accountId) console.log(`export META_ADS_CLI_ACCOUNT_ID="${p.accountId}"`);
        if (p.appId) console.log(`export META_ADS_CLI_APP_ID="${p.appId}"`);
        if (shown.appSecret) console.log(`export META_ADS_CLI_APP_SECRET="${shown.appSecret}"`);
        if (p.apiVersion) console.log(`export META_ADS_CLI_API_VERSION="${p.apiVersion}"`);
        if (p.maxSpendCap !== undefined) console.log(`export META_ADS_CLI_MAX_SPEND_CAP="${p.maxSpendCap}"`);
      }
    }));
}
