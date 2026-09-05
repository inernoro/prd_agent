import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const previewSource = readFileSync(path.resolve(__dirname, 'SitePreviewModal.tsx'), 'utf8');
const pageSource = readFileSync(path.resolve(__dirname, '../../pages/WebPagesPage.tsx'), 'utf8');

describe('mobile web hosting layout', () => {
  it('wraps preview actions instead of clipping them on narrow screens', () => {
    expect(previewSource).toContain('flex flex-wrap items-center justify-between');
    expect(previewSource).toContain('w-full flex-wrap items-center justify-end');
    expect(previewSource).toContain('sm:flex-nowrap');
  });

  it('uses one full-width card column on mobile', () => {
    expect(pageSource).toContain("isMobile ? 'minmax(0, 1fr)'");
    expect(pageSource).not.toContain("isMobile ? 'repeat(2, minmax(0, 1fr))'");
  });
});
