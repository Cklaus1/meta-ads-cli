import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetaClient } from '../../src/meta-client.js';
import { validatePolicy, loadPolicy, resetPolicyCache } from '../../src/policy.js';
import { readJournal } from '../../src/journal.js';
import { MetaApiError, PolicyError, errorToJson, exitCodeFor, ExitCode, UsageError, NetworkError } from '../../src/errors.js';

vi.mock('../../src/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const auth = { getToken: vi.fn().mockResolvedValue('tok'), initialize: vi.fn() } as never;

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300, status, statusText: '',
    headers: new Headers(headers), text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

/** Route fetches by "METHOD path" (path without version or query). */
function routeFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const pathPart = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const key = `${init?.method || 'GET'} ${pathPart}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    return res(200, routes[key]);
  });
}

describe('policy file', () => {
  it('rejects unknown keys and bad types', () => {
    expect(() => validatePolicy({ blockGoingLive: 'yes' }, 'p')).toThrow('must be true or false');
    expect(() => validatePolicy({ maxSpendCap: 1 }, 'p')).toThrow('unknown setting');
    expect(() => validatePolicy({ accountAllowlist: ['123'] }, 'p')).toThrow('act_XXX');
    expect(validatePolicy({ blockDeletes: true, comment: 'x' }, 'p')).toEqual({ blockDeletes: true });
  });

  it('refuses a policy file that exists but is broken', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pol-')), 'policy.json');
    fs.writeFileSync(file, '{not json');
    process.env.META_ADS_CLI_POLICY_FILE = file;
    resetPolicyCache();
    try {
      expect(() => loadPolicy()).toThrow(PolicyError);
    } finally {
      delete process.env.META_ADS_CLI_POLICY_FILE;
      resetPolicyCache();
    }
  });
});

describe('policy enforcement', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('blocks going live unless --allow-live', async () => {
    const strict = new MetaClient(auth, true, undefined, false, 0, { policy: { blockGoingLive: true } });
    await expect(strict.request('123', { method: 'POST', body: { status: 'ACTIVE' } })).rejects.toThrow('--allow-live');
    await expect(strict.request('act_1/campaigns', { method: 'POST', body: { name: 'x' } })).rejects.toThrow('no explicit status');
    await expect(strict.request('act_1/campaigns', { method: 'POST', body: { name: 'x', status: 'PAUSED' } })).resolves.toBeDefined();
    const allowed = new MetaClient(auth, true, undefined, false, 0, { policy: { blockGoingLive: true }, allowLive: true });
    await expect(allowed.request('123', { method: 'POST', body: { status: 'ACTIVE' } })).resolves.toBeDefined();
  });

  it('blocks deletes and archives unless --allow-delete', async () => {
    const c = new MetaClient(auth, true, undefined, false, 0, { policy: { blockDeletes: true } });
    await expect(c.request('123', { method: 'DELETE' })).rejects.toThrow('--allow-delete');
    await expect(c.request('123', { method: 'POST', body: { status: 'ARCHIVED' } })).rejects.toThrow('--allow-delete');
  });

  it('blocks messaging unless --allow-messaging', async () => {
    const c = new MetaClient(auth, true, undefined, false, 0, { policy: { blockMessaging: true } });
    await expect(c.request('555/messages', { method: 'POST', body: { message: '{}' } })).rejects.toThrow('--allow-messaging');
  });

  it('enforces the account allowlist on act_ endpoints and looked-up objects', async () => {
    const c = new MetaClient(auth, false, undefined, false, 0, { policy: { accountAllowlist: ['act_1'] } });
    await expect(c.request('act_2/campaigns')).rejects.toThrow('accountAllowlist');
    routeFetch({ 'GET 999': { account_id: '2' } });
    await expect(c.request('999', { method: 'POST', body: { name: 'x' } })).rejects.toThrow('act_2 is not in');
  });

  it('enforces the account-wide daily budget ceiling', async () => {
    const policy = { maxAccountDailyBudgetCents: 10000 };
    const c = new MetaClient(auth, false, undefined, false, 0, { policy });
    routeFetch({
      'GET act_1/campaigns': { data: [{ id: 'c1', daily_budget: '6000' }] },
      'GET act_1/adsets': { data: [{ id: 's1', daily_budget: '2000' }] },
    });
    await expect(c.request('act_1/campaigns', { method: 'POST', body: { name: 'x', status: 'ACTIVE', daily_budget: '3000' } }))
      .rejects.toThrow('over the account ceiling');
    // A paused create doesn't count toward active spend.
    vi.restoreAllMocks();
    routeFetch({ 'POST act_1/campaigns': { id: 'new' } });
    await expect(c.request('act_1/campaigns', { method: 'POST', body: { name: 'x', status: 'PAUSED', daily_budget: '3000' } }))
      .resolves.toMatchObject({ data: { id: 'new' } });
  });

  it('policy maxSpendCapCents joins the other caps', () => {
    expect(new MetaClient(auth, true, undefined, false, 5000, { policy: { maxSpendCapCents: 2000 } }).getMaxSpendCapCents()).toBe(2000);
  });

  it('policy readOnly blocks writes', async () => {
    const c = new MetaClient(auth, true, undefined, false, 0, { policy: { readOnly: true } });
    await expect(c.request('1', { method: 'POST', body: {} })).rejects.toThrow(PolicyError);
  });
});

describe('plan and validate modes', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('--plan runs reads but records writes', async () => {
    const fetchSpy = routeFetch({ 'GET act_1': { id: 'act_1' } });
    const c = new MetaClient(auth, false, undefined, false, 0, { plan: true });
    await c.request('act_1', { params: { fields: 'id' } });
    const created = await c.request('act_1/campaigns', { method: 'POST', body: { name: 'x', access_token: 'secret' } });
    expect(created.data).toMatchObject({ planned: true, id: 'planned_1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(c.getPlan()).toEqual([{ step: 1, method: 'POST', endpoint: 'act_1/campaigns', body: { name: 'x', access_token: '[redacted]' } }]);
  });

  it('--validate sends validate_only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(200, { success: true }));
    const c = new MetaClient(auth, false, undefined, false, 0, { validateOnly: true });
    const out = await c.request('act_1/campaigns', { method: 'POST', body: { name: 'x' } });
    expect(out.data).toMatchObject({ validated: true });
    const body = String(fetchSpy.mock.calls[0][1]!.body);
    expect(decodeURIComponent(body)).toContain('execution_options=["validate_only"]');
  });
});

describe('journal', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jr-')), 'journal.jsonl');
    process.env.META_ADS_CLI_JOURNAL_FILE = file;
  });
  afterEach(() => {
    delete process.env.META_ADS_CLI_JOURNAL_FILE;
    vi.restoreAllMocks();
  });

  it('records writes with previous values, without secrets, mode 0600', async () => {
    routeFetch({ 'GET 123': { id: '123', name: 'Old', daily_budget: '1000' }, 'POST 123': { success: true } });
    const c = new MetaClient(auth);
    await c.request('123', { method: 'POST', body: { name: 'New', daily_budget: '2000' } });
    const [entry] = readJournal();
    expect(entry).toMatchObject({ method: 'POST', endpoint: '123', status: 'ok', previous: { name: 'Old', daily_budget: '1000' } });
    expect(JSON.stringify(entry)).not.toContain('tok');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('records failed writes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(400, { error: { message: 'bad', code: 100 } }));
    const c = new MetaClient(auth);
    await expect(c.request('act_1/campaigns', { method: 'POST', body: { name: 'x' } })).rejects.toThrow('bad');
    expect(readJournal()[0]).toMatchObject({ status: 'error' });
  });
});

describe('typed errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('carries Meta diagnostics and maps to exit codes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res(400, {
      error: { message: 'Invalid', code: 100, error_subcode: 1487, fbtrace_id: 'TRACE1', error_user_msg: 'Fix it' },
    }));
    const c = new MetaClient(auth);
    const err = await c.request('act_1/campaigns', { method: 'POST', body: {} }).catch(e => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ code: 100, subcode: 1487, fbtraceId: 'TRACE1', userMessage: 'Fix it', httpStatus: 400 });
    expect(exitCodeFor(err)).toBe(ExitCode.API);
    expect(errorToJson(err).error).toMatchObject({ type: 'api', code: 100, subcode: 1487, fbtrace_id: 'TRACE1', exit_code: 6 });
  });

  it('maps auth, permission, rate limit, usage, policy and network errors', async () => {
    const c = new MetaClient(auth);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(400, { error: { message: 'x', code: 190 } }));
    expect(exitCodeFor(await c.request('act_1').catch(e => e))).toBe(ExitCode.AUTH);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res(403, { error: { message: 'x', code: 200 } }));
    expect(exitCodeFor(await c.request('act_1').catch(e => e))).toBe(ExitCode.PERMISSION);
    expect(exitCodeFor(await c.request('1?x=1').catch(e => e))).toBe(ExitCode.USAGE);
    expect(exitCodeFor(new UsageError('x'))).toBe(2);
    expect(exitCodeFor(new NetworkError('x'))).toBe(8);
    expect(exitCodeFor(new Error('x'))).toBe(1);
    const capped = new MetaClient(auth, true, undefined, false, 100);
    expect(exitCodeFor(await capped.request('act_1/campaigns', { method: 'POST', body: { daily_budget: '500' } }).catch(e => e))).toBe(ExitCode.POLICY);
  });
});
