import { Command } from 'commander';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { loadPolicy, policyWritableByCurrentUser, SYSTEM_POLICY_PATH } from '../policy.js';

export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('Guardrail policy for delegated/agent access');

  policy
    .command('show')
    .description('Show the policy in effect and whether it can be edited by the current user')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const loaded = loadPolicy();
      const writable = loaded.exists ? policyWritableByCurrentUser(loaded.path) : undefined;
      console.log(formatOutput({
        path: loaded.path || '(disabled)',
        exists: loaded.exists,
        policy: loaded.policy,
        tamper_resistant: loaded.exists ? !writable : undefined,
        system_policy: loaded.path === SYSTEM_POLICY_PATH,
        note: !loaded.exists
          ? `No policy file. For a tamper-resistant setup, install one as root at ${SYSTEM_POLICY_PATH}.`
          : writable
            ? 'The current user can edit, replace or delete this file (or its directory), so an agent running as this user '
              + `could loosen it. Install it as root at ${SYSTEM_POLICY_PATH} instead.`
            : undefined,
      }, opts.output as OutputFormat));
    }));
}
