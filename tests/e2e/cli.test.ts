import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const exec = promisify(execFile);
const CLI = path.resolve('dist/index.js');

function runCli(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return exec('node', [CLI, ...args], {
    env: { ...process.env, ...env, META_ADS_CLI_LOG_LEVEL: 'none' },
    timeout: 10000,
  });
}

function runCliExpectFail(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node',
      [CLI, ...args],
      {
        env: { ...process.env, ...env, META_ADS_CLI_LOG_LEVEL: 'none' },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          code: error?.code !== undefined ? (error.code as unknown as number) : (child.exitCode ?? 1),
        });
      }
    );
  });
}

describe('CLI E2E', () => {
  beforeAll(async () => {
    // Ensure built
    await exec('npm', ['run', 'build'], { timeout: 30000 });
  });

  describe('help and version', () => {
    it('shows help with --help', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('Meta Ads CLI');
      expect(stdout).toContain('campaigns');
      expect(stdout).toContain('--dry-run');
    });

    it('shows version with --version', async () => {
      const { stdout } = await runCli(['--version']);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('shows subcommand help', async () => {
      const { stdout } = await runCli(['campaigns', '--help']);
      expect(stdout).toContain('list');
      expect(stdout).toContain('get');
      expect(stdout).toContain('create');
      expect(stdout).toContain('update');
      expect(stdout).toContain('delete');
    });

    it('shows help for all command groups', async () => {
      const groups = ['accounts', 'adsets', 'ads', 'creatives', 'insights', 'targeting', 'audiences'];
      for (const group of groups) {
        const { stdout } = await runCli([group, '--help']);
        expect(stdout).toContain(group);
      }
    });
  });

  describe('dry-run mode', () => {
    it('campaigns list dry-run shows request without executing', async () => {
      const { stdout } = await runCli(
        ['campaigns', 'list', '--account-id', 'act_123456', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
      expect(stdout).toContain('GET');
      expect(stdout).toContain('act_123456');
    });

    it('accounts list dry-run', async () => {
      const { stdout } = await runCli(
        ['accounts', 'list', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
      expect(stdout).toContain('GET');
    });

    it('adsets list dry-run', async () => {
      const { stdout } = await runCli(
        ['adsets', 'list', '--account-id', 'act_123', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
      expect(stdout).toContain('GET');
    });

    it('ads list dry-run', async () => {
      const { stdout } = await runCli(
        ['ads', 'list', '--account-id', 'act_123', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
    });

    it('campaign create dry-run shows POST', async () => {
      const { stdout } = await runCli(
        [
          'campaigns', 'create',
          '--account-id', 'act_123456',
          '--name', 'Test Campaign',
          '--objective', 'OUTCOME_AWARENESS',
          '--dry-run',
        ],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
      expect(stdout).toContain('POST');
    });

    it('insights dry-run', async () => {
      const { stdout } = await runCli(
        ['insights', 'account', '--account-id', 'act_123', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
    });
  });

  describe('output formats with dry-run', () => {
    it('json output (default)', async () => {
      const { stdout } = await runCli(
        ['campaigns', 'list', '--account-id', 'act_123', '-o', 'json', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      // Dry-run outputs the dry-run log, then the formatted data
      expect(stdout).toContain('[dry-run]');
    });

    it('table output', async () => {
      const { stdout } = await runCli(
        ['campaigns', 'list', '--account-id', 'act_123', '-o', 'table', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
    });

    it('csv output', async () => {
      const { stdout } = await runCli(
        ['campaigns', 'list', '--account-id', 'act_123', '-o', 'csv', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
    });
  });

  describe('auth commands', () => {
    it('auth status shows not logged in without token', async () => {
      const result = await runCliExpectFail(['auth', 'status'], {
        META_ADS_CLI_ACCESS_TOKEN: '',
        META_ACCESS_TOKEN: '',
      });
      // Should indicate not logged in (either via stderr or exit code)
      expect(result.stderr + result.stdout).toMatch(/not logged in|error|failed/i);
    });
  });

  describe('error handling', () => {
    it('shows error for unknown command', async () => {
      const result = await runCliExpectFail(['nonexistent-command']);
      expect(result.stderr + result.stdout).toMatch(/unknown command|error/i);
    });

    it('shows error when required option missing', async () => {
      const result = await runCliExpectFail(
        ['campaigns', 'create', '--account-id', 'act_123', '--dry-run'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      // Missing --name and --objective
      expect(result.stderr).toContain('required');
    });
  });

  describe('global options', () => {
    it('--api-version is accepted', async () => {
      const { stdout } = await runCli(
        ['campaigns', 'list', '--account-id', 'act_123', '--dry-run', '--api-version', 'v19.0'],
        { META_ADS_CLI_ACCESS_TOKEN: 'fake-token' }
      );
      expect(stdout).toContain('[dry-run]');
    });
  });

  describe('setup and schema commands (no auth needed)', () => {
    it('schema shows available services', async () => {
      const { stdout } = await runCli(['schema']);
      expect(stdout).toContain('campaigns');
      expect(stdout).toContain('adsets');
    });
  });
});
