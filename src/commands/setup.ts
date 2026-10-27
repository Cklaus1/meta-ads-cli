import { Command } from 'commander';
import { AuthManager } from '../auth.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { handleErrors } from '../errors.js';
import { writePrivateFile } from '../private-file.js';

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Without this, EOF on stdin leaves the promise pending and the process
    // exits 0 halfway through the wizard.
    const onClose = () => reject(new Error('Setup cancelled (input closed)'));
    rl.once('close', onClose);
    rl.question(question, answer => {
      rl.off('close', onClose);
      resolve(answer.trim());
    });
  });
}

/**
 * Set keys in .env content, replacing existing lines for those keys in place
 * and appending the rest. Every other line is kept as-is.
 */
export function upsertEnv(content: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const lines = content ? content.replace(/\n$/, '').split('\n') : [];
  const out = lines.map(line => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  if (remaining.size > 0) {
    if (!out.some(l => l.trim() === '# Meta Ads CLI Configuration')) {
      if (out.length && out[out.length - 1].trim() !== '') out.push('');
      out.push('# Meta Ads CLI Configuration');
    }
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
  }
  return out.join('\n') + '\n';
}

export function registerSetupCommand(program: Command, getAuth: () => AuthManager): void {
  program
    .command('setup')
    .description('Interactive setup wizard for Meta Ads CLI')
    .option('--non-interactive', 'Print instructions without prompts')
    .action(handleErrors(async (opts) => {
      if (opts.nonInteractive) {
        printStaticInstructions();
        return;
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      console.log('\n=== Meta Ads CLI Setup Wizard ===\n');

      // Step 1: Check existing config
      console.log('Step 1: Checking existing configuration...');
      const existingAppId = process.env.META_ADS_CLI_APP_ID || process.env.META_APP_ID;
      const existingToken = process.env.META_ADS_CLI_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
      const existingAccount = process.env.META_ADS_CLI_ACCOUNT_ID;

      if (existingAppId) {
        console.log(`  Found App ID: ${existingAppId}`);
      }
      if (existingToken) {
        console.log(`  Found access token: ${existingToken.slice(0, 10)}...`);
      }
      if (existingAccount) {
        console.log(`  Found account ID: ${existingAccount}`);
      }
      console.log('');

      // Step 2: Get App credentials
      console.log('Step 2: Meta App credentials');
      console.log('  Create a Meta app at: https://developers.facebook.com/apps');
      console.log('  Add the "Marketing API" product to your app\n');

      const appId = await prompt(rl, `  Meta App ID ${existingAppId ? `(${existingAppId})` : ''}: `);
      const appSecret = await prompt(rl, '  Meta App Secret (for long-lived tokens, optional; blank keeps the current one): ');

      // Step 3: Default account
      console.log('\nStep 3: Default ad account');
      console.log('  Format: act_XXXXXXXXX (run "meta-ads accounts list" to find yours)\n');
      const accountId = await prompt(rl, `  Default Account ID ${existingAccount ? `(${existingAccount})` : '(optional)'}: `);

      // Step 4: Save to .env
      console.log('\nStep 4: Saving configuration...');
      const envPath = path.resolve('.env');
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

      // Only touch the keys the wizard asked about; blank answers keep the
      // current value, and every other setting (token, spend cap, ...) stays.
      const updates: Record<string, string> = {};
      if (appId || existingAppId) updates.META_ADS_CLI_APP_ID = appId || existingAppId || '';
      if (appSecret) updates.META_ADS_CLI_APP_SECRET = appSecret;
      if (accountId) updates.META_ADS_CLI_ACCOUNT_ID = accountId;
      else if (existingAccount) updates.META_ADS_CLI_ACCOUNT_ID = existingAccount;

      writePrivateFile(envPath, upsertEnv(existing, updates));
      console.log(`  Saved to ${envPath}`);

      // Step 5: Test (if we have a token)
      if (existingToken) {
        console.log('\nStep 5: Testing connection...');
        try {
          const auth = getAuth();
          await auth.initialize();
          const result = await auth.verifyLogin();
          if (result.success && result.user) {
            console.log(`  Connected as: ${result.user.name} (ID: ${result.user.id})`);
          } else {
            console.log('  Could not verify connection. Run: meta-ads auth login');
          }
        } catch {
          console.log('  Could not verify connection. Run: meta-ads auth login');
        }
      } else {
        console.log('\nStep 5: Authentication');
        console.log('  Run: meta-ads auth login');
      }

      console.log('\nSetup complete! Next steps:');
      console.log('  1. meta-ads auth login       (authenticate)');
      console.log('  2. meta-ads auth status       (verify)');
      console.log('  3. meta-ads accounts list     (list your ad accounts)');
      console.log('  4. meta-ads campaigns list    (list campaigns)\n');

      rl.close();
    }));
}

function printStaticInstructions(): void {
  console.log('Meta Ads CLI Setup');
  console.log('==================\n');
  console.log('1. Go to https://developers.facebook.com/apps');
  console.log('2. Create or select an app, add "Marketing API" product');
  console.log('3. Set environment variables in .env:\n');
  console.log('  META_ADS_CLI_APP_ID=your_app_id');
  console.log('  META_ADS_CLI_APP_SECRET=your_app_secret');
  console.log('  META_ADS_CLI_ACCOUNT_ID=act_XXXXXXXXX\n');
  console.log('4. Run: meta-ads auth login');
  console.log('5. Run: meta-ads auth status\n');
}
