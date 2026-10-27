import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  registerMonitoringCommands, pauseReasons, pauseFindings, newAlerts, alertKeys, isFatalWatchError,
} from '../../src/commands/monitoring.js';
import { registerInsightCommands, parsePollOptions, waitForReport, startAsyncReport } from '../../src/commands/insights.js';
import { registerCatalogCommands } from '../../src/commands/catalog.js';
import { registerCreativeCommands } from '../../src/commands/creatives.js';
import { hashUserData } from '../../src/commands/conversions.js';
import { buildCustomerRows } from '../../src/commands/audiences.js';
import { appendLeadCsv, leadIdsInCsv } from '../../src/commands/webhooks.js';
import { registerAdSetCommands } from '../../src/commands/adsets.js';
import { MetaApiError, CliError } from '../../src/errors.js';
import { mockClient, run } from './command-helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('B2-24 --min-roas only where ROAS applies', () => {
  const lead = { spend: '50', impressions: '5000', objective: 'OUTCOME_LEADS', actions: [{ action_type: 'lead', value: '10' }] };
  it('does not pause a lead ad set with no purchases', () => {
    expect(pauseReasons(lead, { minRoas: '1' })).toEqual([]);
  });
  it('still judges a sales ad set with no revenue', () => {
    expect(pauseReasons({ ...lead, objective: 'OUTCOME_SALES', actions: [] }, { minRoas: '1' })).toEqual(['ROAS 0 < 1']);
  });
  it('judges rows with purchase revenue even without an objective', () => {
    expect(pauseFindings({ spend: '50', impressions: '5000', action_values: [{ action_type: 'omni_purchase', value: '25' }] }, { minRoas: '1' })[0].rule).toBe('LOW_ROAS');
  });
});

describe('B2-25 watch alerts keyed on rule, not message', () => {
  it('treats a changed spend number as the same alert', () => {
    const first = [{ id: '1', name: 'a', reason: 'Spend 150 > 100', rules: ['HIGH_SPEND'] }];
    const seen = new Set(first.flatMap(alertKeys));
    expect(newAlerts(seen, [{ id: '1', name: 'a', reason: 'Spend 151 > 100', rules: ['HIGH_SPEND'] }])).toEqual([]);
    expect(newAlerts(seen, [{ id: '1', name: 'a', reason: 'x', rules: ['HIGH_SPEND', 'LOW_ROAS'] }])).toHaveLength(1);
  });

  it('retries a failed pause on the next tick and notifies once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let pauseAttempts = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    let tick = 0;
    const { client } = mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/adsets') return { data: { data: [{ id: '9', name: 'A', status: 'ACTIVE' }] }, status: 200 };
      if (endpoint === 'act_1/insights') {
        tick++;
        return { data: { data: [{ adset_id: '9', spend: String(150 + tick), impressions: '5000' }] }, status: 200 };
      }
      if (endpoint === '9' && opts?.method === 'POST') {
        pauseAttempts++;
        if (pauseAttempts === 1) throw new Error('transient');
        return { data: { success: true }, status: 200 };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    const p = run(registerMonitoringCommands, client, [
      'monitor', 'watch', '--account-id', 'act_1', '--interval', '60s', '--max-spend', '100',
      '--auto-pause', '--confirm', '--max-runs', '2', '--notify', 'webhook:https://example.com/h',
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    const { stdout } = await p;
    const ticks = stdout.split('\n').map(l => JSON.parse(l));
    expect(ticks[0].failed).toHaveLength(1);
    expect(ticks[1].paused).toEqual(['9']);
    expect(pauseAttempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second tick's spend changed but it's the same alert
  });
});

describe('B2-42 watch stops on errors that waiting won\'t fix', () => {
  it('classifies fatal errors', () => {
    expect(isFatalWatchError(new MetaApiError('bad token', { type: 'auth', httpStatus: 401, code: 190 }))).toBe(true);
    expect(isFatalWatchError(new CliError('net', 'network'))).toBe(false);
    expect(isFatalWatchError(new Error('x'))).toBe(false);
  });

  it('ends the loop on an auth error instead of retrying', async () => {
    const { client, request } = mockClient(async () => { throw new CliError('Authentication failed', 'auth'); });
    await expect(run(registerMonitoringCommands, client, [
      'monitor', 'watch', '--account-id', 'act_1', '--interval', '60s', '--max-spend', '100',
    ])).rejects.toThrow(/exit 3/);
    expect(request.mock.calls.length + 0).toBeLessThanOrEqual(1);
  });
});

describe('B2-21 / B2-26 async reports', () => {
  it('starts reports as a read', async () => {
    const { client, request } = mockClient(async () => ({ data: { report_run_id: 'r1' }, status: 200 }));
    await expect(startAsyncReport(client, 'act_1', { level: 'ad' })).resolves.toBe('r1');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', readLike: true });
  });

  it('does not poll placeholder report ids', async () => {
    const { client, request } = mockClient(async () => ({ data: { planned: true, id: 'planned_1' }, status: 0 }));
    await expect(startAsyncReport(client, 'act_1', {})).resolves.toBeUndefined();
    await expect(waitForReport(client, 'planned_2', { pollMs: 1000, timeoutMs: 1000 })).resolves.toMatchObject({ placeholder: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects bad --timeout / --poll-interval values', async () => {
    expect(() => parsePollOptions('5', '30m')).toThrow('--timeout');
    expect(() => parsePollOptions('0', '60')).toThrow('--poll-interval');
    expect(parsePollOptions('2', '60')).toEqual({ pollMs: 2000, timeoutMs: 60000 });
    const { client, request } = mockClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerInsightCommands, client, ['insights', 'export-mmm', '--account-id', 'act_1', '--timeout', 'abc']))
      .rejects.toThrow(/exit 2/);
    expect(request).not.toHaveBeenCalled();
    await expect(waitForReport(client, 'r1', { pollMs: NaN, timeoutMs: 1000 })).rejects.toThrow('non-negative');
  });
});

describe('B2-30 / B2-39 catalog', () => {
  it('sends item_type and accepts @file requests', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h3-')), 'reqs.json');
    fs.writeFileSync(file, JSON.stringify([{ method: 'UPDATE', data: { id: 'sku1', price: '9.99 USD' } }]));
    const { client, request } = mockClient(async () => ({ data: { handles: ['h'] }, status: 200 }));
    await run(registerCatalogCommands, client, ['catalog', 'batch', '123', '--requests', `@${file}`]);
    const body = request.mock.calls[0][1]!.body!;
    expect(body.item_type).toBe('PRODUCT_ITEM');
    expect(JSON.parse(body.requests)[0].data.id).toBe('sku1');
    expect(body.allow_upsert).toBe('true');
  });

  it('rejects malformed batch requests', async () => {
    const { client, request } = mockClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerCatalogCommands, client, ['catalog', 'batch', '123', '--requests', '[{"retailer_id":"x"}]'])).rejects.toThrow(/exit 2/);
    expect(request).not.toHaveBeenCalled();
  });

  it('requires a currency for a sale price without --price', async () => {
    const { client, request } = mockClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerCatalogCommands, client, ['catalog', 'update-product', '55', '--sale-price', '1000'])).rejects.toThrow(/exit 2/);
    expect(request).not.toHaveBeenCalled();
    await run(registerCatalogCommands, client, ['catalog', 'update-product', '55', '--sale-price', '1000 JPY']);
    expect(request.mock.calls[0][1]!.body).toMatchObject({ sale_price: '1000', sale_price_currency: 'JPY' });
  });
});

describe('B2-37 preview spec from stdin is read once', () => {
  it('reuses the parsed spec for every format', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => '{"object_story_spec":{"page_id":"1"}}');
    const { client, request } = mockClient(async () => ({ data: { data: [{ body: '<iframe>' }] }, status: 200 }));
    await run(registerCreativeCommands, client, ['creatives', 'preview', 'act_1', '--spec', '-', '--format', 'A,B']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]!.params!.creative).toContain('page_id');
  });
});

describe('B2-40 one city normalizer', () => {
  it('hashes München the same for CAPI and customer lists', () => {
    const capi = hashUserData({ ct: 'München' }).ct;
    const list = buildCustomerRows([['München']], ['CT'], true)[0][0];
    expect(capi).toBe(list);
    expect(capi).toBe(crypto.createHash('sha256').update('münchen').digest('hex'));
  });
});

describe('B2-41 leads CSV', () => {
  it('parses quoted headers and dedupes redelivered leads', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h3-')), 'leads.csv');
    fs.writeFileSync(file, 'id,"full name, legal",email\n1,"A, B",a@b.com\n');
    const seen = leadIdsInCsv(file);
    expect(seen.has('1')).toBe(true);
    expect(appendLeadCsv(file, { id: '1', field_data: [{ name: 'email', values: ['a@b.com'] }] }, seen)).toBe(false);
    expect(appendLeadCsv(file, { id: '2', field_data: [{ name: 'email', values: ['c@d.com'] }] }, seen)).toBe(true);
    expect(appendLeadCsv(file, { id: '2', field_data: [{ name: 'email', values: ['c@d.com'] }] }, seen)).toBe(false);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('2,,c@d.com');
  });
});

describe('B2-44 adsets update runs create-time checks', () => {
  it('rejects an update that conflicts with a special ad category', async () => {
    const { client, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === '77' && !opts?.method) return { data: { campaign_id: '5', targeting: { geo_locations: { countries: ['US'] } } }, status: 200 };
      if (endpoint === '5') return { data: { special_ad_categories: ['HOUSING'] }, status: 200 };
      return { data: { success: true }, status: 200 };
    });
    await expect(run(registerAdSetCommands, client, ['adsets', 'update', '77', '--custom-audiences', '123'])).rejects.toThrow(/Advantage\+ audience/);
    expect(request.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
  });

  it('dry-run previews only the changed targeting keys', async () => {
    const { client, request } = mockClient(async () => ({ data: { dryRun: true }, status: 0 }), true);
    const { stderr } = await run(registerAdSetCommands, client, ['adsets', 'update', '77', '--instagram-positions', 'stream']);
    const post = request.mock.calls.find(c => c[1]?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body!.targeting)).toEqual({ instagram_positions: ['stream'] });
    expect(stderr).toContain('merges them');
  });
});
