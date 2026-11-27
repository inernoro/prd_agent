import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const previewSource = readFileSync(path.resolve(__dirname, 'SitePreviewModal.tsx'), 'utf8');
const reviewStyles = readFileSync(path.resolve(__dirname, '../../styles/hosted-review-workbench.css'), 'utf8');
const editPanelSource = readFileSync(path.resolve(__dirname, 'SiteEditPanel.tsx'), 'utf8')
  + readFileSync(path.resolve(__dirname, 'workbench/useSiteEditSession.ts'), 'utf8');
const pageSource = readFileSync(path.resolve(__dirname, '../../pages/WebPagesPage.tsx'), 'utf8');
const cardSource = readFileSync(path.resolve(__dirname, 'SiteCard.tsx'), 'utf8');
const cardActionsSource = readFileSync(path.resolve(__dirname, 'SiteCardActions.tsx'), 'utf8');
const appShellSource = readFileSync(path.resolve(__dirname, '../../layouts/AppShell.tsx'), 'utf8');
const changelogBellSource = readFileSync(path.resolve(__dirname, '../changelog/ChangelogBell.tsx'), 'utf8');
const dialogSource = readFileSync(path.resolve(__dirname, '../ui/Dialog.tsx'), 'utf8');

describe('mobile web hosting layout', () => {
  it('keeps preview actions together and tucks secondary actions into the menu on narrow screens', () => {
    expect(previewSource).toContain('review-reader-toolbar');
    expect(previewSource).toContain('review-reader-actions');
    expect(previewSource).toContain('<ShareMoreMenu adaptive>');
    expect(reviewStyles).toMatch(/grid-column:\s*3; grid-row:\s*1; justify-self:\s*end/);
  });

  it('gives every preview-header action at least a 44px touch target', () => {
    expect(previewSource).toContain('<ReviewToolbarControls');
    expect(reviewStyles).toMatch(/\.related-trigger\s*\{[^}]*min-width:\s*44px; min-height:\s*44px/);
    expect(reviewStyles).toMatch(/\.share-more-menu\[data-theme\] \.share-topbar-btn\s*\{ min-height:\s*44px/);
    // 2026-09-24：「帮我修改」进生成工作台，版本记录作为那里的对话显示，预览顶栏只留一个入口。
    expect(previewSource).toContain('帮我修改');
    expect(previewSource).toContain('onClick={onEditInWorkbench}');
  });

  it('keeps the functional page controls at least 44px on mobile', () => {
    expect(cardSource).toContain('max-sm:right-[-4px] max-sm:top-[-4px] max-sm:h-11 max-sm:w-11');
    expect(cardActionsSource).toContain('max-sm:h-11 max-sm:min-h-11');
    expect(cardActionsSource).toContain('max-sm:w-11 max-sm:min-w-11');
    expect(editPanelSource).not.toContain('aria-label="页面修改执行器"');
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

  it('switches the mobile reader between full-width document and discussion panels', () => {
    expect(previewSource).toContain('relative flex-1 min-h-0 flex overflow-hidden');
    expect(previewSource).toContain('<ReviewReaderTabs');
    expect(previewSource).toContain("aria-hidden={isMobile && rightPanel !== 'none' ? true : undefined}");
    expect(previewSource).toContain("width: isMobile ? '100%' : reviewSidebar.width");
    expect(previewSource).toContain('!isMobile && <ReviewSidebarResizeHandle');
    expect(previewSource).toContain('sm:w-[380px]');
    expect(previewSource).not.toContain('sm:w-[440px]');
    expect(previewSource.match(/background: 'var\(--bg-elevated\)'/g)?.length).toBeGreaterThanOrEqual(1);
    expect(previewSource).not.toContain("background: 'var(--panel-solid, var(--bg-elevated))'");
  });

  it('restores the original two-column mobile cards without shrinking menu touch targets', () => {
    expect(pageSource).toContain("isMobile ? 'repeat(2, minmax(0, 1fr))'");
    expect(pageSource).not.toContain("isMobile ? 'minmax(0, 1fr)'");
    expect(cardActionsSource).toContain('max-sm:w-11 max-sm:min-w-11');
    expect(cardActionsSource).toContain('max-sm:h-11 max-sm:min-h-11');
    expect(cardSource).toContain('[@media(hover:none)]:block');
    expect(cardSource).toContain("label: '帮我修改'");
    expect(cardSource).not.toContain('data-site-version-actions');
  });

  it('keeps generation directly discoverable on touch navigation without hiding upload', () => {
    expect(pageSource).toContain('<MobileFab onClick={openQuickCreation} icon={Sparkles} label="生成网页" />');
    expect(pageSource).toContain('data-tour-id="webpages-mobile-upload"');
    expect(pageSource).toContain('aria-label="上传网页"');
    expect(pageSource).toContain('className="h-11 w-11 rounded-[12px] inline-flex items-center justify-center shrink-0"');
    expect(pageSource).not.toContain('aria-label="网页托管快捷操作"');
    expect(pageSource).toContain('!isEdit && !file && !saving');
    expect(pageSource).toContain('data-tour-id="webpages-knowledge-generate"');
    expect(pageSource).toContain('onClick={onGenerate}');
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
