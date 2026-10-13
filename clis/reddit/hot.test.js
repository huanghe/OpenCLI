import { describe, expect, it } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './hot.js';

describe('reddit hot adapter', () => {
  const command = getRegistry().get('reddit/hot');

  it('surfaces post_hint, url_overridden_by_dest, preview_image_url, gallery_urls via extractRedditMedia', () => {
    expect(command?.pipeline?.[1]?.evaluate).toContain('function extractRedditMedia');
    expect(command?.pipeline?.[1]?.evaluate).toContain('...extractRedditMedia(c.data)');
    expect(command?.pipeline?.[2]?.map).toMatchObject({
      post_hint: '${{ item.post_hint }}',
      url_overridden_by_dest: '${{ item.url_overridden_by_dest }}',
      preview_image_url: '${{ item.preview_image_url }}',
      gallery_urls: '${{ item.gallery_urls }}',
    });
  });
});
