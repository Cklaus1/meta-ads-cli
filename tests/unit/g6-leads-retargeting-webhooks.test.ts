import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { mockClient, run } from './command-helpers.js';
import { registerLeadCommands, leadTimeFilter, buildCrmLeadEvent, LEAD_FIELDS } from '../../src/commands/leads.js';
import { registerRetargetingCommands, buildFunnelRules } from '../../src/commands/retargeting.js';
import { verifySignature, createWebhookHandler, extractLeadgenEvents, appendLeadCsv } from '../../src/commands/webhooks.js';

const ok = async () => ({ data: { id: '1' }, status: 200 });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g6-'));

describe('leads (#24, #25)', () => {
  it('export asks for source metadata and filters by --since', async () => {
    const { client, requestAllPages } = mockClient(async () => ({ data: { data: [] }, status: 200 }));
    await run(registerLeadCommands, client, ['leads', 'export', '42', '--since', '2026-10-26T00:00:00Z']);
    const params = requestAllPages.mock.calls[0][1]!.params!;
    expect(params.fields).toBe(LEAD_FIELDS);
    for (const f of ['is_organic', 'platform', 'adset_id', 'form_id']) expect(params.fields).toContain(f);
    expect(JSON.parse(params.filtering)).toEqual([{ field: 'time_created', operator: 'GREATER_THAN', value: 1792972800 }]);
    expect(leadTimeFilter()).toEqual({});
    expect(() => leadTimeFilter('yesterday-ish')).toThrow('--since');
  });

  it('builds Conversion Leads CRM events', () => {
    expect(buildCrmLeadEvent({ leadId: '1234567890123456', stage: 'Qualified', eventTime: '1793404800', crmName: 'HubSpot' })).toEqual({
      event_name: 'Qualified',
      event_time: 1793404800,
      action_source: 'system_generated',
      user_data: { lead_id: '1234567890123456' },
      custom_data: { event_source: 'crm', lead_event_source: 'HubSpot' },
    });
    expect(() => buildCrmLeadEvent({ leadId: 'abc', stage: 'x', crmName: 'y' })).toThrow('lead ID');
  });

  it('crm-event sends a CSV of stage changes to the dataset', async () => {
    const file = path.join(tmpDir(), 'stages.csv');
    fs.writeFileSync(file, 'lead_id,stage,event_time\n1234567890123456,Qualified,1793404800\n1234567890123457,Won,\n');
    const { client, request } = mockClient(ok);
    await run(registerLeadCommands, client, ['leads', 'crm-event', '--dataset-id', '9', '--file', file, '--crm-name', 'Salesforce']);
    expect(request.mock.calls[0][0]).toBe('9/events');
    const events = JSON.parse(request.mock.calls[0][1]!.body!.data);
    expect(events.map((e: { event_name: string }) => e.event_name)).toEqual(['Qualified', 'Won']);
    expect(events[1].custom_data.lead_event_source).toBe('Salesforce');
  });
});

describe('retargeting (#22, #23)', () => {
  const stages = [
    { name: 'Visitors', event: 'PageView', retention: 30 },
    { name: 'Engaged', event: 'ViewContent', retention: 14 },
    { name: 'Cart', event: 'AddToCart', retention: 7 },
  ];
  const events = (rules: Array<Record<string, any>>) => rules.map(r => r.filter.filters[0].value);

  it('each funnel stage excludes deeper stages and converters', () => {
    const rules = buildFunnelRules('px', stages, { event: 'Purchase', retentionDays: 30 });
    expect(events(rules[0].rule.exclusions.rules)).toEqual(['ViewContent', 'AddToCart', 'Purchase']);
    expect(events(rules[1].rule.exclusions.rules)).toEqual(['AddToCart', 'Purchase']);
    expect(events(rules[2].rule.exclusions.rules)).toEqual(['Purchase']);
    expect(buildFunnelRules('px', stages)[2].rule.exclusions).toBeUndefined();
  });

  it('website-behavior --exclude-converters adds a Purchase exclusion', async () => {
    const { client, request } = mockClient(ok);
    await run(registerRetargetingCommands, client, [
      'retargeting', 'website-behavior', '--account-id', 'act_1', '--pixel-id', 'px', '--name', 'V', '--exclude-converters',
    ]);
    const rule = JSON.parse(request.mock.calls[0][1]!.body!.rule);
    expect(rule.exclusions.rules[0]).toMatchObject({ retention_seconds: 30 * 86400, filter: { filters: [{ value: 'Purchase' }] } });
  });

  it('frequency-optimization refuses ad sets not optimized for REACH/THRUPLAY', async () => {
    const { client, request } = mockClient(async (e, o) => (o?.method === 'POST' ? ok() : { data: { optimization_goal: 'OFFSITE_CONVERSIONS' }, status: 200 }));
    await expect(run(registerRetargetingCommands, client, ['retargeting', 'frequency-optimization', '--adset-id', '5'])).rejects.toThrow('REACH or THRUPLAY');
    expect(request.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);

    const { client: c2, request: r2 } = mockClient(async (e, o) => (o?.method === 'POST' ? ok() : { data: { optimization_goal: 'REACH' }, status: 200 }));
    await run(registerRetargetingCommands, c2, ['retargeting', 'frequency-optimization', '--adset-id', '5']);
    expect(r2.mock.calls[1][1]!.body!.frequency_control_specs).toContain('IMPRESSIONS');
  });
});

describe('webhooks listen (G18)', () => {
  const secret = 'shh';
  const sign = (body: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  async function withServer(onEvent: (p: unknown) => void, fn: (base: string) => Promise<void>) {
    const server = http.createServer(createWebhookHandler({ verifyToken: 'tok', appSecret: secret, onEvent }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }

  it('answers the verification handshake and checks signatures', async () => {
    const onEvent = vi.fn();
    await withServer(onEvent, async (base) => {
      const ok = await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123`);
      expect(await ok.text()).toBe('123');
      expect((await fetch(`${base}/?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1`)).status).toBe(403);

      const body = JSON.stringify({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '55', page_id: '1' } }] }] });
      expect((await fetch(base, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=bad' } })).status).toBe(401);
      expect(onEvent).not.toHaveBeenCalled();
      expect((await fetch(base, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } })).status).toBe(200);
      await new Promise(r => setTimeout(r, 10));
      expect(extractLeadgenEvents(onEvent.mock.calls[0][0])).toEqual([{ leadgenId: '55', pageId: '1', formId: undefined }]);
    });
    expect(verifySignature(Buffer.from('x'), undefined, secret)).toBe(false);
  });

  it('appends leads to a CSV, keeping the header order', () => {
    const file = path.join(tmpDir(), 'leads.csv');
    appendLeadCsv(file, { id: '1', created_time: 't1', field_data: [{ name: 'email', values: ['a@b.com'] }] });
    appendLeadCsv(file, { id: '2', created_time: 't2', field_data: [{ name: 'email', values: ['c@d.com'] }] });
    expect(fs.readFileSync(file, 'utf8')).toBe('id,created_time,email\n1,t1,a@b.com\n2,t2,c@d.com\n');
  });
});
