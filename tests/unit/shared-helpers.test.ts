import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJsonInput } from '../../src/json-input.js';
import { actionValue, deriveMetrics, resultEventFor, compareProportions, hasEnoughVolume } from '../../src/metrics.js';
import { insightsTimeParams } from '../../src/time-range.js';
import { formatOutput } from '../../src/formatter.js';

describe('parseJsonInput', () => {
  it('reads inline, @file, and reports the flag on errors', () => {
    expect(parseJsonInput('{"a":1}', '--x')).toEqual({ a: 1 });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'json-')), 'a.json');
    fs.writeFileSync(file, '[1,2]');
    expect(parseJsonInput(`@${file}`, '--x')).toEqual([1, 2]);
    expect(() => parseJsonInput('{bad', '--targeting')).toThrow('--targeting: invalid JSON in inline value');
    expect(() => parseJsonInput('@/nope.json', '--x')).toThrow("--x: can't read /nope.json");
  });
});

describe('metrics', () => {
  const row = {
    spend: '100', impressions: '10000', reach: '5000', inline_link_clicks: '200',
    actions: [
      { action_type: 'purchase', value: '4' },
      { action_type: 'omni_purchase', value: '4' },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '4' },
      { action_type: 'link_click', value: '200' },
    ],
    action_values: [{ action_type: 'omni_purchase', value: '400' }, { action_type: 'purchase', value: '400' }],
  };

  it('counts each purchase once', () => {
    expect(actionValue(row.actions, 'purchase')).toBe(4);
  });

  it('derives cost per result and ROAS', () => {
    const m = deriveMetrics(row, 'purchase');
    expect(m).toMatchObject({ results: 4, cost_per_result: 25, revenue: 400, roas: 4, ctr: 2, cpc: 0.5, cpm: 10, frequency: 2 });
    expect(hasEnoughVolume(m, { minSpend: 50, minResults: 3 })).toBe(true);
    expect(hasEnoughVolume(m, { minResults: 10 })).toBe(false);
  });

  it('picks the result event from the most specific signal', () => {
    expect(resultEventFor({ objective: 'OUTCOME_SALES' })).toBe('purchase');
    expect(resultEventFor({ objective: 'OUTCOME_SALES', optimizationGoal: 'OFFSITE_CONVERSIONS', customEventType: 'LEAD' })).toBe('lead');
    expect(resultEventFor({ objective: 'OUTCOME_TRAFFIC', optimizationGoal: 'LANDING_PAGE_VIEWS' })).toBe('landing_page_view');
  });

  it('z-test separates real differences from noise', () => {
    expect(compareProportions(50, 1000, 30, 1000).pValue).toBeLessThan(0.05);
    expect(compareProportions(5, 100, 4, 100).pValue).toBeGreaterThan(0.5);
  });
});

describe('insightsTimeParams', () => {
  it('uses date_preset for named ranges and time_range for dates', () => {
    expect(insightsTimeParams('last_7d')).toEqual({ date_preset: 'last_7d' });
    expect(insightsTimeParams(undefined, '2026-10-01', '2026-10-07')).toEqual({ time_range: '{"since":"2026-10-01","until":"2026-10-07"}' });
    expect(() => insightsTimeParams('bogus')).toThrow('Unknown time range');
    expect(() => insightsTimeParams(undefined, '2026-10-01')).toThrow('together');
  });
});

describe('formatter action columns', () => {
  it('keeps action values in CSV', () => {
    const out = formatOutput([{ id: '1', actions: [{ action_type: 'purchase', value: '4' }, { action_type: 'link_click', value: '9' }] }], 'csv');
    expect(out.split('\n')[0]).toBe('id,actions.purchase,actions.link_click');
    expect(out.split('\n')[1]).toBe('1,4,9');
  });
});

import { resultEventForPromotedObject } from '../../src/metrics.js';
import { addDerivedColumns } from '../../src/commands/insights.js';
describe('optimization-event results', () => {
  it('maps promoted objects to the action type they optimize for', () => {
    expect(resultEventForPromotedObject({ pixel_id: '1', custom_event_type: 'PURCHASE' })).toBe('purchase');
    expect(resultEventForPromotedObject({ pixel_id: '1', custom_event_type: 'OTHER', custom_event_str: 'ProjectCreated' })).toBe('offsite_conversion.fb_pixel_custom');
    expect(resultEventForPromotedObject({ custom_conversion_id: '77' })).toBe('offsite_conversion.custom.77');
    expect(resultEventForPromotedObject({ page_id: '1' })).toBeUndefined();
  });

  it('counts each ad set by its own event and flags mixed campaigns', () => {
    const optimized = { adsets: new Map([['a1', 'offsite_conversion.fb_pixel_custom']]), campaigns: new Map([['c1', 'offsite_conversion.fb_pixel_custom'], ['c2', '__mixed__']]) };
    const rows = addDerivedColumns([
      { adset_id: 'a1', objective: 'OUTCOME_SALES', spend: '10', actions: [{ action_type: 'offsite_conversion.fb_pixel_custom', value: '5' }] },
      { campaign_id: 'c2', objective: 'OUTCOME_SALES', spend: '10', actions: [] },
    ], undefined, optimized);
    expect(rows[0]).toMatchObject({ result_event: 'offsite_conversion.fb_pixel_custom', results: 5, cost_per_result: 2 });
    expect(rows[1].result_note).toContain('different events');
  });
});
