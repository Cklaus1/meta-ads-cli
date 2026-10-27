import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetaClient } from '../../src/meta-client.js';
import { formatOutput } from '../../src/formatter.js';
import { validateEndpoint, validateSafeOutputDir, parseCents } from '../../src/validate.js';
import { upsertEnv } from '../../src/commands/setup.js';
import { writePrivateFile, ensurePrivateDir } from '../../src/private-file.js';

vi.mock('../../src/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMockAuth() {
  return {
    getToken: vi.fn().mockResolvedValue('test-token-123'),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('../../src/auth.js').AuthManager;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(headers),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('guards', () => {
  const originalEnv = process.env;
  let auth: ReturnType<typeof createMockAuth>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.META_ADS_CLI_MAX_SPEND_CAP;
    auth = createMockAuth();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('endpoint validation (BUG-02)', () => {
    it.each(['123?daily_budget=1', 'act_1/../x', '1%2F2', '1#a', '', 'a//b', 'act_1/campaigns?x=1'])(
      'rejects %j',
      (endpoint) => {
        expect(() => validateEndpoint(endpoint)).toThrow('Invalid ID or endpoint');
      },
    );

    it('accepts normal endpoints', () => {
      expect(validateEndpoint('act_123/campaigns')).toBe('act_123/campaigns');
      expect(validateEndpoint('123_456/comments')).toBe('123_456/comments');
    });

    it('blocks a query-string budget before any fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = new MetaClient(auth, false, undefined, false, 1000);
      await expect(client.request('1234?daily_budget=5000000', { method: 'POST', body: { name: 'x' } }))
        .rejects.toThrow('Invalid ID or endpoint');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('spend cap (BUG-03, BUG-04)', () => {
    it('a flag cannot raise the env cap', async () => {
      process.env.META_ADS_CLI_MAX_SPEND_CAP = '1000';
      const client = new MetaClient(auth, true, undefined, false, 100000);
      expect(client.getMaxSpendCapCents()).toBe(1000);
      await expect(client.request('act_1/campaigns', { method: 'POST', body: { daily_budget: '5000' } }))
        .rejects.toThrow('Spend-cap guard');
    });

    it('a flag can lower the env cap', () => {
      process.env.META_ADS_CLI_MAX_SPEND_CAP = '100000';
      expect(new MetaClient(auth, true, undefined, false, 1000).getMaxSpendCapCents()).toBe(1000);
    });

    it('an invalid env cap fails closed', () => {
      process.env.META_ADS_CLI_MAX_SPEND_CAP = 'abc';
      expect(() => new MetaClient(auth, true)).toThrow('META_ADS_CLI_MAX_SPEND_CAP');
    });

    it('parseCents rejects non-integers', () => {
      for (const bad of ['abc', '5,000', '$50', '1.5', '-1']) {
        expect(() => parseCents(bad, '--max-spend-cap')).toThrow('--max-spend-cap');
      }
      expect(parseCents('500', 'x')).toBe(500);
      expect(parseCents(undefined, 'x')).toBeUndefined();
    });

    it.each([
      'daily_budget', 'lifetime_budget', 'spend_cap', 'bid_amount', 'bid_cap',
      'daily_spend_cap', 'lifetime_spend_cap', 'daily_min_spend_target', 'lifetime_min_spend_target',
      'budget', 'budget_value',
    ])('checks %s', async (field) => {
      const client = new MetaClient(auth, true, undefined, false, 1000);
      await expect(client.request('act_1/campaigns', { method: 'POST', body: { [field]: '5000' } }))
        .rejects.toThrow('Spend-cap guard');
      await expect(client.request('act_1/campaigns', { method: 'POST', body: { [field]: '500' } }))
        .resolves.toBeDefined();
    });

    it('skips percentage budget schedules', async () => {
      const client = new MetaClient(auth, true, undefined, false, 1000);
      await expect(client.request('1/budget_schedules', {
        method: 'POST', body: { budget_value: '5000', budget_value_type: 'MULTIPLIER' },
      })).resolves.toBeDefined();
    });

    it.each(['Infinity', '5000abc', '1_000', ''])('fails closed on non-numeric %j', async (value) => {
      const client = new MetaClient(auth, true, undefined, false, 1000);
      await expect(client.request('act_1/campaigns', { method: 'POST', body: { daily_budget: value } }))
        .rejects.toThrow('not a number of cents');
    });

    it('checks budget fields in query params on writes', async () => {
      const client = new MetaClient(auth, true, undefined, false, 1000);
      await expect(client.request('act_1/campaigns', { method: 'POST', params: { daily_budget: '5000' } }))
        .rejects.toThrow('Spend-cap guard');
    });
  });

  describe('read-only uploads (BUG-05)', () => {
    it('blocks uploadFile under --read-only', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const client = new MetaClient(auth, false, undefined, true);
      await expect(client.uploadFile('act_1/advideos', __filename)).rejects.toThrow('Read-only mode');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('sends extra fields with the file (BUG-33)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { id: '9' }));
      const client = new MetaClient(auth);
      await client.uploadFile('act_1/advideos', __filename, { title: 'My "video"' });
      const form = fetchSpy.mock.calls[0][1]!.body as FormData;
      expect(form.get('title')).toBe('My "video"');
      expect(form.get('source')).toBeInstanceOf(Blob);
    });
  });

  describe('retries (BUG-07, BUG-10, BUG-11)', () => {
    it('does not retry a POST on 5xx', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'boom' } }))
        .mockResolvedValueOnce(jsonResponse(200, { id: '1' }));
      const client = new MetaClient(auth);
      await expect(client.request('act_1/campaigns', { method: 'POST', body: { name: 'x' } })).rejects.toThrow('boom');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('retries a GET after a network error', async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(200, { id: '1' }));
      const client = new MetaClient(auth);
      const p = client.request('act_1');
      await vi.runAllTimersAsync();
      await expect(p).resolves.toMatchObject({ data: { id: '1' } });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('does not retry a POST after a network error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const client = new MetaClient(auth);
      await expect(client.request('act_1/campaigns', { method: 'POST', body: {} })).rejects.toThrow('Network error');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('gives up at once when Meta estimates a long rate-limit wait', async () => {
      const usage = JSON.stringify({ act_1: [{ type: 'ads_management', call_count: 100, estimated_time_to_regain_access: 30 }] });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(400, { error: { message: 'limit', code: 17 } }, { 'x-business-use-case-usage': usage }),
      );
      const client = new MetaClient(auth);
      await expect(client.request('act_1/insights')).rejects.toThrow('30 minute');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('pagination (BUG-32)', () => {
    it('stops when paging.next is absent and drops stale paging', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse(200, { data: [{ id: '1' }], paging: { cursors: { after: 'abc' } } }),
      );
      const client = new MetaClient(auth);
      const result = await client.requestAllPages('act_1/campaigns');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((result.data as Record<string, unknown>).paging).toBeUndefined();
    });
  });

  describe('formatter (BUG-09, BUG-18)', () => {
    it('neutralises CSV formulas but keeps negative numbers', () => {
      const out = formatOutput([{ a: '=1+1', b: '-1.5', c: '@SUM(A1)' }], 'csv');
      expect(out).toContain("'=1+1");
      expect(out).toContain(',-1.5,');
      expect(out).toContain("'@SUM(A1)");
    });

    it('keeps {name, values} answers in flattened output', () => {
      const out = formatOutput([{ id: '1', field_data: [{ name: 'email', values: ['a@b.com'] }] }], 'csv');
      expect(out).toContain('email=a@b.com');
    });

    it('quotes YAML strings that would parse as other types', () => {
      const out = formatOutput({ id: '120210000000000001', name: 'true', e: '', ok: 'Campaign A' }, 'yaml');
      expect(out).toContain('id: "120210000000000001"');
      expect(out).toContain('name: "true"');
      expect(out).toContain('e: ""');
      expect(out).toContain('ok: Campaign A');
    });
  });

  describe('setup .env handling (BUG-08)', () => {
    it('keeps unrelated settings and updates keys in place', () => {
      const before = 'META_ADS_CLI_MAX_SPEND_CAP=1000\nMETA_ADS_CLI_ACCESS_TOKEN=x\nMETA_ADS_CLI_APP_SECRET=s\nFOO=1\nMETA_ADS_CLI_APP_ID=old\n';
      const after = upsertEnv(before, { META_ADS_CLI_APP_ID: 'new', META_ADS_CLI_ACCOUNT_ID: 'act_1' });
      expect(after).toContain('META_ADS_CLI_MAX_SPEND_CAP=1000\n');
      expect(after).toContain('META_ADS_CLI_ACCESS_TOKEN=x\n');
      expect(after).toContain('META_ADS_CLI_APP_SECRET=s\n');
      expect(after).toContain('FOO=1\n');
      expect(after).toContain('META_ADS_CLI_APP_ID=new\n');
      expect(after).not.toContain('old');
      expect(after).toContain('META_ADS_CLI_ACCOUNT_ID=act_1\n');
    });
  });

  describe('private files (BUG-06)', () => {
    it('writes credentials 0600 in a 0700 dir', () => {
      const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meta-ads-')), 'cfg');
      const oldMask = process.umask(0o022);
      try {
        ensurePrivateDir(dir);
        const file = path.join(dir, 'token.json');
        writePrivateFile(file, '{}');
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(oldMask);
      }
    });
  });

  describe('validateSafeOutputDir (BUG-34)', () => {
    it('rejects a sibling directory that shares the cwd prefix', () => {
      const sibling = `../${path.basename(process.cwd())}-evil`;
      expect(() => validateSafeOutputDir(sibling)).toThrow('within current working directory');
    });
  });
});
