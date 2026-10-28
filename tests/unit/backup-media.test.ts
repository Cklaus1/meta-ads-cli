import { describe, it, expect } from 'vitest';
import { collectMedia, remapCreativeMedia, isRejectedAd } from '../../src/commands/backup.js';

const creative = {
  id: 'c1',
  object_story_spec: {
    page_id: 'p',
    link_data: { image_hash: 'h1', image_url: 'https://cdn/x.jpg', link: 'https://a',
      child_attachments: [{ image_hash: 'h2' }, { video_id: 'v2', image_hash: 'h3' }] },
    video_data: { video_id: 'v1', image_hash: 'h4' },
  },
  asset_feed_spec: { images: [{ hash: 'h5' }], videos: [{ video_id: 'v3' }] },
};

describe('backup media', () => {
  it('finds every image hash and video id', () => {
    const { images, videos } = collectMedia([creative]);
    expect([...images].sort()).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
    expect([...videos].sort()).toEqual(['v1', 'v2', 'v3']);
  });

  it('remaps media and drops source-account image URLs', () => {
    const out = remapCreativeMedia(creative, { h1: 'n1', h5: 'n5' }, { v1: 'nv1', v3: 'nv3' });
    expect(out.object_story_spec.link_data.image_hash).toBe('n1');
    expect((out.object_story_spec.link_data as Record<string, unknown>).image_url).toBeUndefined();
    expect(out.object_story_spec.link_data.link).toBe('https://a');
    expect(out.object_story_spec.video_data.video_id).toBe('nv1');
    expect(out.asset_feed_spec.images[0].hash).toBe('n5');
    expect(out.asset_feed_spec.videos[0].video_id).toBe('nv3');
    expect(out.object_story_spec.link_data.child_attachments[0].image_hash).toBe('h2');
  });

  it('detects rejected ads', () => {
    expect(isRejectedAd({ id: '1', effective_status: 'DISAPPROVED' })).toBe(true);
    expect(isRejectedAd({ id: '1', effective_status: 'ACTIVE', ad_review_feedback: { global: { x: 'y' } } })).toBe(true);
    expect(isRejectedAd({ id: '1', effective_status: 'ACTIVE' })).toBe(false);
  });
});

import { portableTrackingSpecs } from '../../src/commands/backup.js';
describe('portableTrackingSpecs', () => {
  it('keeps pixel tracking and drops post/page references', () => {
    expect(portableTrackingSpecs([
      { 'action.type': ['offsite_conversion'], fb_pixel: ['1'] },
      { 'action.type': ['link_click'], post: ['2'], 'post.wall': ['3'] },
      { 'action.type': ['onsite_conversion'] },
    ])).toEqual([{ 'action.type': ['offsite_conversion'], fb_pixel: ['1'] }]);
    expect(portableTrackingSpecs([{ post: ['2'] }])).toBeUndefined();
  });
});

import { parseIdMap, excludeFromTargeting } from '../../src/commands/backup.js';
describe('restore options', () => {
  it('parses campaign maps and excludes countries', () => {
    expect(parseIdMap('1=2, 3=4')).toEqual({ 1: '2', 3: '4' });
    expect(() => parseIdMap('1=x')).toThrow('oldId=newId');
    expect(excludeFromTargeting({ geo_locations: { country_groups: ['worldwide'] }, excluded_geo_locations: { countries: ['CN'] } }, ['TW']))
      .toEqual({ geo_locations: { country_groups: ['worldwide'] }, excluded_geo_locations: { countries: ['CN', 'TW'] } });
  });
});

import { withoutRetiredEnhancements } from '../../src/commands/backup.js';
describe('withoutRetiredEnhancements', () => {
  it('drops standard_enhancements and keeps individual features', () => {
    const c = { id: '1', degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' }, image_touchups: { enroll_status: 'OPT_IN' } } } };
    expect(withoutRetiredEnhancements(c).degrees_of_freedom_spec).toEqual({ creative_features_spec: { image_touchups: { enroll_status: 'OPT_IN' } } });
    const only = { id: '2', degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' } } } };
    expect('degrees_of_freedom_spec' in withoutRetiredEnhancements(only)).toBe(false);
  });
});

import { withPortableAdLabels, withoutReadOnlyFeedFields, LEGACY_OBJECTIVES } from '../../src/commands/backup.js';
describe('cross-account creative cleanup', () => {
  it('keeps ad label names but drops source-account ids', () => {
    const c = { asset_feed_spec: { images: [{ hash: 'h', adlabels: [{ name: 'p1', id: '123' }] }] } };
    expect(withPortableAdLabels(c).asset_feed_spec.images[0].adlabels).toEqual([{ name: 'p1' }]);
  });
  it('drops read-only asset feed fields', () => {
    const c = { asset_feed_spec: { bodies: [], reasons_to_shop: false, shops_bundle: false, additional_data: {} } };
    expect(withoutReadOnlyFeedFields(c).asset_feed_spec).toEqual({ bodies: [] });
  });
  it('maps legacy objectives', () => {
    expect(LEGACY_OBJECTIVES.CONVERSIONS).toBe('OUTCOME_SALES');
  });
});

import { stripLocationTypes } from '../../src/commands/adsets.js';
describe('stripLocationTypes', () => {
  it('removes retired location_types from included and excluded geo', () => {
    expect(stripLocationTypes({ geo_locations: { countries: ['US'], location_types: ['home'] }, excluded_geo_locations: { countries: ['CA'], location_types: ['recent'] }, age_min: 18 }))
      .toEqual({ geo_locations: { countries: ['US'] }, excluded_geo_locations: { countries: ['CA'] }, age_min: 18 });
  });
});
