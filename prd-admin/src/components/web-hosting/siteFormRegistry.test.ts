import { describe, expect, it } from 'vitest';
import { resolveSiteForm, siteFormBadge, SITE_FORM_REGISTRY } from './siteFormRegistry';

const file = (path: string) => ({
  path,
  cosKey: `sites/test/${path}`,
  size: 1,
  mimeType: path.endsWith('.html') ? 'text/html' : 'application/json',
});

describe('site form content shape', () => {
  it('图片包装站优先识别为图片，不能被两文件壳子误分为 ZIP', () => {
    const site = { wrappedAssetType: 'image', contentShape: 'multi-file' as const, files: [file('index.html'), file('photo.png')] };
    expect(resolveSiteForm(site)).toBe('image');
    expect(SITE_FORM_REGISTRY[resolveSiteForm(site)].label).toBe('图片');
    expect(siteFormBadge(site)).toBeNull();
  });

  it('shows a generated six-file system package as a normal HTML page', () => {
    const site = {
      contentShape: 'self-contained-html' as const,
      files: [
        file('index.html'),
        file('manifest.json'),
        file('assets/page-outline.json'),
        file('assets/design-tokens.json'),
        file('assets/accessibility-static-report.json'),
        file('assets/provenance.json'),
      ],
    };

    expect(resolveSiteForm(site)).toBe('html');
    expect(siteFormBadge(site)).toBeNull();
  });

  it('keeps an ordinary multi-file site classified as a ZIP site', () => {
    const site = {
      contentShape: 'multi-file' as const,
      files: [file('index.html'), file('styles.css')],
    };

    expect(resolveSiteForm(site)).toBe('zip');
    expect(siteFormBadge(site)).toBe('2 文件');
  });
});
