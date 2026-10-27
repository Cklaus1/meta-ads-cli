import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mockClient, run } from './command-helpers.js';
import {
  registerAudienceCommands, parseCsv, resolveCustomerSchema, hashCustomerValue, buildCustomerRows,
  uploadCustomerList, parseLookalikeTiers, pairOverlap,
} from '../../src/commands/audiences.js';
import {
  registerConversionCommands, countMissingEventIds, chunkEvents, summarizeDatasetQuality,
} from '../../src/commands/conversions.js';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const ok = async () => ({ data: { id: '1', num_received: 2, num_invalid_entries: 0 }, status: 200 });

function tmpFile(name: string, content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g6-')), name);
  fs.writeFileSync(file, content);
  return file;
}

describe('customer list helpers (#19)', () => {
  it('parses quoted CSV and maps header aliases', () => {
    const rows = parseCsv('Email,phone,"first_name"\r\n" A@B.com ","+1 (555) 010-0000","Ann, Marie"\n');
    expect(rows).toEqual([['Email', 'phone', 'first_name'], [' A@B.com ', '+1 (555) 010-0000', 'Ann, Marie']]);
    expect(resolveCustomerSchema(rows[0])).toEqual(['EMAIL', 'PHONE', 'FN']);
    expect(() => resolveCustomerSchema(['email', 'shoe_size'])).toThrow('SHOE_SIZE');
  });

  it('normalizes before hashing and leaves unhashed keys alone', () => {
    expect(hashCustomerValue('EMAIL', ' A@B.com ')).toBe(sha('a@b.com'));
    expect(hashCustomerValue('PHONE', '+1 (555) 010-0000')).toBe(sha('15550100000'));
    expect(hashCustomerValue('FN', 'Ann-Marie')).toBe(sha('annmarie'));
    expect(hashCustomerValue('DOBM', '3')).toBe(sha('03'));
    expect(hashCustomerValue('EXTERN_ID', ' crm-42 ')).toBe('crm-42');
    expect(hashCustomerValue('LOOKALIKE_VALUE', '44.5')).toBe(44.5);
    expect(hashCustomerValue('EMAIL', sha('x'))).toBe(sha('x'));
    expect(() => hashCustomerValue('LOOKALIKE_VALUE', '-1')).toThrow('non-negative');
  });

  it('uploads in batches of one session and flags the last batch', async () => {
    const { client, request } = mockClient(ok);
    const data = buildCustomerRows([['a@b.com'], ['c@d.com'], ['e@f.com']], ['EMAIL']);
    const result = await uploadCustomerList(client, '99', ['EMAIL'], data, { batchSize: 2 });
    expect(request).toHaveBeenCalledTimes(2);
    const sessions = request.mock.calls.map(c => JSON.parse(c[1]!.body!.session));
    expect(sessions.map(s => [s.batch_seq, s.last_batch_flag])).toEqual([[1, false], [2, true]]);
    expect(sessions[0].session_id).toBe(sessions[1].session_id);
    const payload = JSON.parse(request.mock.calls[0][1]!.body!.payload);
    expect(payload).toEqual({ schema: 'EMAIL', data: [sha('a@b.com'), sha('c@d.com')] });
    expect(result).toMatchObject({ rows: 3, batches: 2, num_received: 4 });
  });

  it('upload command reads a CSV; remove-users sends method=DELETE', async () => {
    const file = tmpFile('c.csv', 'email,value\na@b.com,10\n');
    const { client, request } = mockClient(ok);
    await run(registerAudienceCommands, client, ['audiences', 'upload', '99', '--file', file]);
    const body = request.mock.calls[0][1]!.body!;
    expect(JSON.parse(body.payload)).toEqual({ schema: ['EMAIL', 'LOOKALIKE_VALUE'], data: [[sha('a@b.com'), 10]] });
    expect(body.method).toBeUndefined();

    const { client: c2, request: r2 } = mockClient(ok);
    await run(registerAudienceCommands, c2, ['audiences', 'remove-users', '99', '--file', file]);
    expect(r2.mock.calls[0][1]!.body!.method).toBe('DELETE');
  });

  it('create-custom defaults customer_file_source for lists and sends labels / value-based', async () => {
    const { client, request } = mockClient(ok);
    await run(registerAudienceCommands, client, [
      'audiences', 'create-custom', '--account-id', 'act_1', '--name', 'Buyers', '--value-based', '--labels', 'HIGH_VALUE_CUSTOMERS',
    ]);
    expect(request.mock.calls[0][1]!.body).toMatchObject({
      subtype: 'CUSTOM', is_value_based: '1', customer_file_source: 'USER_PROVIDED_ONLY', audience_labels: '["HIGH_VALUE_CUSTOMERS"]',
    });
  });
});

describe('lookalikes (#20)', () => {
  it('parses tiers into non-overlapping bands', () => {
    expect(parseLookalikeTiers('0-1,1-3,3-5')).toEqual([{ starting: undefined, ratio: 0.01 }, { starting: 0.01, ratio: 0.03 }, { starting: 0.03, ratio: 0.05 }]);
    expect(() => parseLookalikeTiers('3-1')).toThrow('starting-ratio');
    expect(() => parseLookalikeTiers('0-30')).toThrow('0.20');
  });

  it('creates one lookalike per tier with starting_ratio', async () => {
    const { client, request } = mockClient(ok);
    await run(registerAudienceCommands, client, [
      'audiences', 'create-lookalike', '--account-id', 'act_1', '--source-audience-id', '5', '--tiers', '0-1,1-3', '--name', 'LAL',
    ]);
    const specs = request.mock.calls.map(c => JSON.parse(c[1]!.body!.lookalike_spec));
    expect(specs[0]).toMatchObject({ ratio: 0.01 });
    expect(specs[0].starting_ratio).toBeUndefined();
    expect(specs[1]).toMatchObject({ ratio: 0.03, starting_ratio: 0.01 });
    expect(request.mock.calls[1][1]!.body!.name).toBe('LAL 1-3%');
  });
});

describe('overlap (#21)', () => {
  it('computes intersection from union, not the union itself', () => {
    expect(pairOverlap(1000, 600, 1300)).toEqual({ overlap_estimate: 300, overlap_pct_of_smaller: 50 });
    expect(pairOverlap(null, 600, 1300).overlap_estimate).toBeNull();
  });

  it('estimates each audience and each pair', async () => {
    const reach: Record<string, number> = { '["a"]': 1000, '["b"]': 600, '["a","b"]': 1300 };
    const { client } = mockClient(async (_e, o) => {
      const ids = JSON.stringify(JSON.parse(o!.params!.targeting_spec).custom_audiences.map((c: { id: string }) => c.id));
      return { data: { data: [{ estimate_mau_lower_bound: reach[ids], estimate_mau_upper_bound: reach[ids] }] }, status: 200 };
    });
    const { stdout } = await run(registerAudienceCommands, client, ['audiences', 'overlap', '--account-id', 'act_1', '--audience-ids', 'a,b']);
    expect(JSON.parse(stdout).pairs[0]).toMatchObject({ reach_union: 1300, overlap_estimate: 300, overlap_pct_of_smaller: 50 });
  });
});

describe('saved audiences (G9)', () => {
  it('lists saved audiences with targeting', async () => {
    const { client, request } = mockClient(ok);
    await run(registerAudienceCommands, client, ['audiences', 'saved', 'list', '--account-id', 'act_1']);
    expect(request.mock.calls[0][0]).toBe('act_1/saved_audiences');
    expect(request.mock.calls[0][1]!.params!.fields).toContain('targeting');
  });
});

describe('Conversions API (#6, #26, #27)', () => {
  it('send-event uses --order-id as event_id and order_id, and applies LDU', async () => {
    const { client, request } = mockClient(ok);
    await run(registerConversionCommands, client, [
      'conversions', 'send-event', '--pixel-id', '7', '--event-name', 'Purchase', '--order-id', 'ORD-1', '--custom-data', '{"value":10}',
      '--ldu', '--ldu-country', '1', '--ldu-state', '1000',
    ]);
    const [event] = JSON.parse(request.mock.calls[0][1]!.body!.data);
    expect(event).toMatchObject({
      event_id: 'ORD-1', custom_data: { value: 10, order_id: 'ORD-1' },
      data_processing_options: ['LDU'], data_processing_options_country: 1, data_processing_options_state: 1000,
    });
  });

  it('warns when website events have no event_id', async () => {
    const { client } = mockClient(ok);
    const { stderr } = await run(registerConversionCommands, client, ['conversions', 'send-event', '--pixel-id', '7', '--event-name', 'Purchase']);
    expect(stderr).toContain('no event_id');
    expect(countMissingEventIds([{ action_source: 'website' }, { action_source: 'website', event_id: 'x' }, { action_source: 'physical_store' }])).toBe(1);
  });

  it('send-batch splits into requests of 1,000 events', async () => {
    const { client, request } = mockClient(ok);
    const events = Array.from({ length: 1500 }, (_, i) => ({ event_name: 'Lead', event_id: String(i) }));
    const file = tmpFile('events.json', JSON.stringify(events));
    await run(registerConversionCommands, client, ['conversions', 'send-batch', '--pixel-id', '7', '--events', `@${file}`]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1][1]!.body!.data)).toHaveLength(500);
    expect(chunkEvents([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('quality summarizes the Dataset Quality API per event', async () => {
    const { client, request } = mockClient(async () => ({
      data: { web: [{
        event_name: 'Purchase',
        event_match_quality: { composite_score: 7.2, match_key_feedback: [{ identifier: 'email', coverage: { percentage: 88 } }] },
        event_coverage: { percentage: 64, goal_percentage: 75 },
        dedupe_key_feedback: [{ dedupe_key: 'event_id' }],
        data_freshness: { upload_frequency: 'real_time' },
      }] },
      status: 200,
    }));
    const { stdout } = await run(registerConversionCommands, client, ['conversions', 'quality', '123']);
    expect(request.mock.calls[0][0]).toBe('dataset_quality');
    expect(request.mock.calls[0][1]!.params!.dataset_id).toBe('123');
    expect(JSON.parse(stdout)[0]).toMatchObject({ event_name: 'Purchase', emq_score: 7.2, match_keys: 'email:88%', server_coverage_pct: 64, dedupe_keys: 'event_id' });
    expect(summarizeDatasetQuality({})).toEqual([]);
  });
});
