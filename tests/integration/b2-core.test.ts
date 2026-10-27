import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetaClient, effectiveMethod, isPlaceholderId } from '../../src/meta-client.js';
import { parseJsonInput } from '../../src/json-input.js';
import { CONFIG_DIR } from '../../src/private-file.js';
import { appendJournal } from '../../src/journal.js';
import { policyWritableByCurrentUser } from '../../src/policy.js';
import { toolArgv, buildTools, childEnv, validateToolInput } from '../../src/commands/mcp.js';
import { Command } from 'commander';

vi.mock('../../src/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CLI = path.resolve('dist/index.js');
const auth = { getToken: vi.fn().mockResolvedValue('t'), initialize: vi.fn() } as never;

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, META_ADS_CLI_ACCESS_TOKEN: 'x', META_ADS_CLI_NO_JOURNAL: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(status: number, body: unknown): Response {
  return { ok: status < 300, status, statusText: '', headers: new Headers(), text: () => Promise.resolve(JSON.stringify(body)) } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('B2-01 MCP flag injection', () => {
  it('a later --max-spend-cap in argv cannot raise an earlier one', () => {
    const r = cli(['--dry-run', '--max-spend-cap', '5000', 'campaigns', 'update', '123',
      '--daily-budget=90000', '--bid-strategy=--max-spend-cap=99999999']);
    expect(r.code).toBe(7);
    const r2 = cli(['--dry-run', '--max-spend-cap', '5000', 'campaigns', 'update', '123', '--daily-budget=90000', '--max-spend-cap', '99999999']);
    expect(r2.code).toBe(7);
  });

  it('MCP children ignore --allow-live unless the server allowed it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
    const policy = path.join(dir, 'p.json');
    fs.writeFileSync(policy, '{"blockGoingLive":true}');
    const args = ['--dry-run', '--allow-live', 'campaigns', 'update', '123', '--status=ACTIVE'];
    expect(cli(args, { META_ADS_CLI_POLICY_FILE: policy, META_ADS_CLI_MCP_CHILD: '1', META_ADS_CLI_MCP_ALLOW: '' }).code).toBe(7);
    expect(cli(args, { META_ADS_CLI_POLICY_FILE: policy, META_ADS_CLI_MCP_CHILD: '1', META_ADS_CLI_MCP_ALLOW: 'live' }).code).toBe(0);
  });

  it('tool argv uses --opt=value, rejects dash positionals, and checks input', () => {
    const program = new Command('meta-ads');
    program.option('--max-spend-cap <c>');
    program.command('campaigns').command('update <campaignId>').option('--bid-strategy <s>').option('--status <s>').action(() => {});
    const tool = buildTools(program).find(t => t.name === 'campaigns_update')!;
    expect(toolArgv(tool, { campaignId: '1', bid_strategy: '--max-spend-cap=999' }, [], []))
      .toContain('--bid-strategy=--max-spend-cap=999');
    expect(() => toolArgv(tool, { campaignId: '--allow-live' }, [], [])).toThrow("can't start with");
    expect(() => validateToolInput(tool, { campaignId: '1', bogus: 'x' })).toThrow('Unknown argument');
    expect(() => validateToolInput(tool, { campaignId: { a: 1 } })).toThrow('must be a string');
  });

  it('the server passes its cap and allow flags through the env', () => {
    const program = new Command('meta-ads').option('--max-spend-cap <c>').option('--allow-live');
    program.parse(['node', 'x', '--max-spend-cap', '5000'], { from: 'node' });
    const env = childEnv(program, { META_ADS_CLI_MAX_SPEND_CAP: '9000' });
    expect(env).toMatchObject({ META_ADS_CLI_MCP_CHILD: '1', META_ADS_CLI_MAX_SPEND_CAP: '5000', META_ADS_CLI_MCP_ALLOW: '' });
  });
});

describe('B2-02 API version', () => {
  it('rejects a version that carries a path or query', () => {
    expect(() => new MetaClient(auth, true, 'v26.0/1?daily_budget=9#')).toThrow('Invalid API version');
    expect(cli(['--dry-run', '--api-version', 'v26.0/123?x=1#', 'campaigns', 'list', '--account-id', '1']).code).toBe(2);
  });
});

describe('B2-05 / B2-19 placeholders', () => {
  it('--plan hands out endpoint-safe ids that later steps can use', async () => {
    const client = new MetaClient(auth, false, undefined, false, 0, { plan: true, policy: {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const created = await client.request('act_1/campaigns', { method: 'POST', body: { name: 'x', status: 'PAUSED' } });
    const id = (created.data as { id: string }).id;
    expect(isPlaceholderId(id)).toBe(true);
    await expect(client.request(`${id}/copies`, { method: 'POST', body: {} })).resolves.toBeDefined();
    await expect(client.request(id)).resolves.toMatchObject({ data: { planned: true } });
    expect(client.getPlan()).toHaveLength(2);
  });

  it('--validate skips writes that depend on a validated-only object', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new MetaClient(auth, false, undefined, false, 0, { validateOnly: true, policy: {} });
    const c = await client.request('act_1/campaigns', { method: 'POST', body: { name: 'x' } });
    const id = (c.data as { id: string }).id;
    await client.request('act_1/adsets', { method: 'POST', body: { campaign_id: id } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('B2-09 method override', () => {
  it('treats POST method=DELETE as a delete', async () => {
    expect(effectiveMethod('POST', { method: 'delete' })).toBe('DELETE');
    const client = new MetaClient(auth, true, undefined, false, 0, { policy: { blockDeletes: true } });
    await expect(client.request('123', { method: 'POST', body: { method: 'DELETE' } })).rejects.toThrow('deletes and archives are blocked');
    const ro = new MetaClient(auth, true, undefined, true, 0, { policy: {} });
    await expect(ro.uploadFile('act_1/advideos', __filename, { method: 'DELETE' })).rejects.toThrow('Read-only');
  });
});

describe('B2-10 policy fails closed', () => {
  it('blocks a write when the account lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(500, { error: { message: 'boom', code: 1 } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new MetaClient(auth, false, undefined, false, 0, { policy: { accountAllowlist: ['act_1'] } });
    await expect(client.request('123', { method: 'POST', body: { name: 'x' } })).rejects.toThrow("couldn't verify");
  });
});

describe('B2-12 budget schedules', () => {
  it('checks the resulting budget, not the increase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { daily_budget: '4000' }));
    const client = new MetaClient(auth, false, undefined, false, 5000, { policy: {} });
    await expect(client.request('123/budget_schedules', {
      method: 'POST', body: { budget_value: '4000', budget_value_type: 'ABSOLUTE' },
    })).rejects.toThrow('raise the budget to 8000');
  });
});

describe('B2-14 @file inputs', () => {
  it('refuses credential files and file input in MCP tool calls', () => {
    expect(() => parseJsonInput(`@${path.join(CONFIG_DIR, 'profiles.json')}`, '--x')).toThrow(/refusing|can't read/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, '{"a":1}');
    expect(() => parseJsonInput(`@${env}`, '--x')).toThrow('refusing');
    process.env.META_ADS_CLI_MCP_CHILD = '1';
    try {
      expect(() => parseJsonInput('@/tmp/x.json', '--x')).toThrow('MCP');
    } finally {
      delete process.env.META_ADS_CLI_MCP_CHILD;
    }
    expect(() => parseJsonInput('{"secret": oops', '--x')).toThrow(/syntax error/);
    expect(() => parseJsonInput('{"secret": oops', '--x')).not.toThrow(/oops/);
  });
});

describe('B2-13 / B2-16 policy and journal files', () => {
  it('counts a writable directory as tamperable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o444);
    expect(policyWritableByCurrentUser(file)).toBe(true);
  });

  it('does not chmod the directory of a custom journal path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
    fs.chmodSync(dir, 0o755);
    process.env.META_ADS_CLI_JOURNAL_FILE = path.join(dir, 'j.jsonl');
    try {
      appendJournal({ id: '1', ts: '', method: 'POST', endpoint: '1', status: 'ok' });
      expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(dir, 'j.jsonl')).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.META_ADS_CLI_JOURNAL_FILE;
    }
  });
});

describe('B2-17 / B2-18 profiles', () => {
  function home() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-home-'));
    fs.mkdirSync(path.join(h, '.config', 'meta-ads-cli'), { recursive: true });
    return h;
  }

  it("uses a profile's apiVersion", () => {
    const h = home();
    fs.writeFileSync(path.join(h, '.config/meta-ads-cli/profiles.json'), JSON.stringify({ p: { name: 'p', apiVersion: 'v21.0' } }));
    const r = cli(['--profile', 'p', '--dry-run', 'campaigns', 'list', '--account-id', '1'], { HOME: h, META_ADS_CLI_API_VERSION: '' });
    expect(r.stderr).toContain('/v21.0/');
  });

  it('a broken default profile does not lock out the CLI', () => {
    const h = home();
    fs.writeFileSync(path.join(h, '.config/meta-ads-cli/config.json'), JSON.stringify({ defaultProfile: 'gone' }));
    expect(cli(['--version'], { HOME: h }).code).toBe(0);
    const r = cli(['--dry-run', 'campaigns', 'list', '--account-id', '1'], { HOME: h });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('default profile "gone" not applied');
    expect(cli(['profile', 'use', '--clear'], { HOME: h }).code).toBe(0);
  });
});

describe('B2-20 / B2-21 validate scope and read-like POSTs', () => {
  it('--validate never sends messages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new MetaClient(auth, false, undefined, false, 0, { validateOnly: true, policy: {} });
    await client.request('555/messages', { method: 'POST', body: { message: '{}' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('read-like POSTs pass --read-only and send no execution_options', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { report_run_id: '9' }));
    const client = new MetaClient(auth, false, undefined, true, 0, { validateOnly: true, policy: {} });
    await client.request('act_1/insights', { method: 'POST', body: { level: 'ad' }, readLike: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][1]?.body)).not.toContain('execution_options');
  });
});
