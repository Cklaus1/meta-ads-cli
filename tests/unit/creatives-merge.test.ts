import { describe, it, expect } from 'vitest';
import { mergeStoryUpdate } from '../../src/commands/creatives.js';

describe('mergeStoryUpdate', () => {
  it('updates video_data fields and keeps the CTA link', () => {
    const out = mergeStoryUpdate({
      object_story_spec: { page_id: 'p', video_data: { video_id: 'v', title: 'Old', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://a' } } } },
    }, { headline: 'New', description: 'D', linkUrl: 'https://b' });
    const video = JSON.parse(out.object_story_spec).video_data;
    expect(video).toMatchObject({ video_id: 'v', title: 'New', link_description: 'D' });
    expect(video.call_to_action).toEqual({ type: 'LEARN_MORE', value: { link: 'https://b' } });
    expect(video.link).toBeUndefined();
  });

  it('replaces asset lists for dynamic creative', () => {
    const out = mergeStoryUpdate({
      object_story_spec: { page_id: 'p' },
      asset_feed_spec: { bodies: [{ text: 'a' }, { text: 'b' }], images: [{ hash: 'h' }], link_urls: [{ website_url: 'https://a', display_url: 'a.com' }] },
    }, { message: 'New body', linkUrl: 'https://b' });
    const feed = JSON.parse(out.asset_feed_spec);
    expect(feed.bodies).toEqual([{ text: 'New body' }]);
    expect(feed.images).toEqual([{ hash: 'h' }]);
    expect(feed.link_urls).toEqual([{ website_url: 'https://b', display_url: 'a.com' }]);
    expect(JSON.parse(out.object_story_spec)).toEqual({ page_id: 'p' });
  });

  it('keeps the existing CTA value when only the type changes on link ads', () => {
    const out = mergeStoryUpdate({
      object_story_spec: { link_data: { link: 'https://a', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://a' } } } },
    }, { cta: 'SHOP_NOW' });
    expect(JSON.parse(out.object_story_spec).link_data.call_to_action).toEqual({ type: 'SHOP_NOW', value: { link: 'https://a' } });
  });

  it('uses template_data for catalog ads', () => {
    const out = mergeStoryUpdate({ object_story_spec: { template_data: { message: 'x' } } }, { message: 'y' });
    expect(JSON.parse(out.object_story_spec)).toEqual({ template_data: { message: 'y' } });
  });

  it('rejects unsupported fields for photo posts', () => {
    expect(() => mergeStoryUpdate({ object_story_spec: { photo_data: {} } }, { headline: 'x' })).toThrow('Photo post');
  });
});
