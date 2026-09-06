import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const previewSource = readFileSync(path.resolve(__dirname, 'SitePreviewModal.tsx'), 'utf8');
const editPanelSource = readFileSync(path.resolve(__dirname, 'SiteEditPanel.tsx'), 'utf8');
const pageSource = readFileSync(path.resolve(__dirname, '../../pages/WebPagesPage.tsx'), 'utf8');
const cardSource = readFileSync(path.resolve(__dirname, 'SiteCard.tsx'), 'utf8');
const cardActionsSource = readFileSync(path.resolve(__dirname, 'SiteCardActions.tsx'), 'utf8');
const appShellSource = readFileSync(path.resolve(__dirname, '../../layouts/AppShell.tsx'), 'utf8');
const changelogBellSource = readFileSync(path.resolve(__dirname, '../changelog/ChangelogBell.tsx'), 'utf8');
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

  it('keeps the functional page controls at least 44px on mobile', () => {
    expect(cardSource).toContain('className="absolute bottom-[-5px] left-[-5px] z-20 inline-flex h-11 w-11');
    expect(cardActionsSource).toContain('max-sm:h-11 max-sm:min-h-11');
    expect(cardActionsSource).toContain('max-sm:w-11 max-sm:min-w-11');
    expect(editPanelSource).toContain('aria-label="页面修改执行器"');
    expect(editPanelSource).toContain('className="mt-3 min-h-11 w-full');
    expect(pageSource).toContain('className="min-h-11 w-full pl-9');
    expect(pageSource).toContain('className="h-11 px-3 rounded-[12px]');
    expect(appShellSource).toContain("gridTemplateColumns: '44px minmax(0, 1fr) 92px'");
    expect(appShellSource.match(/className="(?:relative )?h-11 w-11 shrink-0/g)?.length).toBeGreaterThanOrEqual(2);
    expect(changelogBellSource).toContain("compact ? 'h-11 w-11 shrink-0'");
  });

  it('stacks version titles above their actions instead of squeezing them on mobile', () => {
    expect(editPanelSource).toContain('flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between');
    expect(editPanelSource).toContain('w-full shrink-0 items-center gap-1 overflow-x-auto sm:w-auto');
  });

  it('uses one scroll owner for compose, progress, preview and history on mobile', () => {
    expect(editPanelSource).toContain('className="flex-1 min-h-0 overflow-y-auto"');
    expect(editPanelSource).toMatch(/ref=\{composeRef\}[\s\S]{0,220}className="scroll-mt-2/);
    expect(editPanelSource).not.toContain('ref={composeRef} className="shrink-0');
  });

  it('opens every right panel as a mobile overlay instead of squeezing the preview', () => {
    expect(previewSource).toContain('relative flex-1 min-h-0 flex overflow-hidden');
    expect(previewSource.match(/absolute inset-0 z-20 flex w-full/g)).toHaveLength(3);
    expect(previewSource).toContain('sm:w-[360px]');
    expect(previewSource).toContain('sm:w-[380px]');
    expect(previewSource).toContain('sm:w-[440px]');
    expect(previewSource.match(/background: 'var\(--bg-elevated\)'/g)?.length).toBeGreaterThanOrEqual(2);
    expect(previewSource).not.toContain("background: 'var(--panel-solid, var(--bg-elevated))'");
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

  it('exposes the preview surface as a labelled modal with keyboard focus containment', () => {
    expect(previewSource).toContain('role="dialog"');
    expect(previewSource).toContain('aria-modal="true"');
    expect(previewSource).toContain('aria-labelledby="site-preview-dialog-title"');
    expect(previewSource).toContain("e.key !== 'Tab'");
    expect(previewSource).toContain('previouslyFocused?.focus()');
  });
});
