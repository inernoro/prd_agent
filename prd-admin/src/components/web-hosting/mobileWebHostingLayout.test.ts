import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const previewSource = readFileSync(path.resolve(__dirname, 'SitePreviewModal.tsx'), 'utf8');
const editPanelSource = readFileSync(path.resolve(__dirname, 'SiteEditPanel.tsx'), 'utf8');
const pageSource = readFileSync(path.resolve(__dirname, '../../pages/WebPagesPage.tsx'), 'utf8');
const mobileFabSource = readFileSync(path.resolve(__dirname, '../mobile/MobileFab.tsx'), 'utf8');
const dialogSource = readFileSync(path.resolve(__dirname, '../ui/Dialog.tsx'), 'utf8');

describe('mobile web hosting layout', () => {
  it('keeps preview actions in one scrollable control strip on narrow screens', () => {
    expect(previewSource).toContain('flex shrink-0 flex-col gap-2');
    expect(previewSource).toContain('overflow-x-auto');
    expect(previewSource).toContain('whitespace-nowrap');
    expect(previewSource).toContain('sm:flex-row');
  });

  it('gives every preview-header action at least a 44px touch target', () => {
    expect(previewSource.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(7);
    expect(previewSource).toContain('min-w-11');
    expect(previewSource).toContain('帮我修改');
    expect(previewSource).toContain('版本记录');
  });

  it('stacks version titles above their actions instead of squeezing them on mobile', () => {
    expect(editPanelSource).toContain('flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between');
    expect(editPanelSource).toContain('w-full shrink-0 items-center gap-1 overflow-x-auto sm:w-auto');
  });

  it('opens every right panel as a mobile overlay instead of squeezing the preview', () => {
    expect(previewSource).toContain('relative flex-1 min-h-0 flex overflow-hidden');
    expect(previewSource.match(/absolute inset-0 z-20 flex w-full/g)).toHaveLength(3);
    expect(previewSource).toContain('sm:w-[360px]');
    expect(previewSource).toContain('sm:w-[380px]');
    expect(previewSource).toContain('sm:w-[440px]');
  });

  it('uses one full-width card column on mobile', () => {
    expect(pageSource).toContain("isMobile ? 'minmax(0, 1fr)'");
    expect(pageSource).not.toContain("isMobile ? 'repeat(2, minmax(0, 1fr))'");
  });

  it('keeps page-level floating actions below modal surfaces', () => {
    expect(pageSource).toContain('fixed right-[18px] z-[90]');
    expect(mobileFabSource).toContain('zIndex: 90');
    expect(dialogSource).toContain('zIndex: zIndex ?? 100');
  });
});
