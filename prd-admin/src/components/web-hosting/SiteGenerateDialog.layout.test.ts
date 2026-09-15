import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, 'SiteGenerateDialog.tsx'), 'utf8');

describe('SiteGenerateDialog responsive layout contract', () => {
  it('keeps critical modal height inline and every grid branch shrinkable', () => {
    expect(source).toContain("width: 'min(1080px, calc(100vw - 16px))'");
    expect(source).toContain("maxWidth: 'calc(100vw - 16px)'");
    expect(source).toContain("height: 'min(760px, calc(100vh - 24px))'");
    expect(source).not.toContain('contentClassName="h-[');
    expect(source.match(/min-w-0/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  // 共享 Dialog 的标题块用什么 flex 属性，归 2026-09-01 的「控制台形态」那一版所有，
  // 不该由网页托管这个调用方用字面量断言钉死（判据与接线纪律 形状 4a：断言实现的字面存在，
  // 谁改谁的 CI 红）。这里只守本组件自己的契约：标题与说明不许把关闭按钮挤出容器。
  it('keeps its own dialog title short enough not to crowd the shared header', () => {
    const title = source.match(/title="([^"]+)"/)?.[1];
    // companion：正则没匹到就判红，否则这条断言会对着空串永远绿（形状 4b）。
    expect(title, '没在源码里找到弹窗标题').toBeTruthy();
    expect(title!.length, '标题过长会在窄屏把关闭按钮挤出容器').toBeLessThanOrEqual(12);
  });

  it('keeps the primary action visible while mobile configuration scrolls and hides an empty preview', () => {
    expect(source).toContain('sticky bottom-0 z-10');
    expect(source).toContain("generating || previewHtml || completedSite ? 'flex' : 'hidden lg:flex'");
  });

  it('uses an opaque themed surface for waiting while preserving the generated page canvas', () => {
    expect(source).toContain('className="surface-reading flex h-full items-center justify-center text-crisp"');
    expect(source).toContain('className="h-full w-full bg-white"');
    expect(source).not.toContain('className="relative min-h-0 flex-1 bg-white"');
  });

  it('submits only knowledge identities and never truncates or uploads browser-fetched content', () => {
    expect(source).not.toContain('getDocumentContent');
    expect(source).not.toContain('.slice(0, 20_000)');
    expect(source).toContain('entryId: entry.entryId');
    expect(source).toContain('storeId: entry.storeId');
    expect(source).toContain('<KnowledgeEntryPicker');
  });

  it('gives the saved result controls their own themed surface over arbitrary generated content', () => {
    const completionPanel = source.slice(source.indexOf('{completedSite && ('));
    expect(completionPanel).toContain('className="surface-reading absolute bottom-4 right-4');
    expect(completionPanel).not.toContain('bg-token-elevated');
    expect(completionPanel).toContain('已保存到网页托管');
    expect(completionPanel).toContain('打开网页');
  });

  it('updates visible elapsed time every second during a long remote generation', () => {
    expect(source).toContain('window.setInterval');
    expect(source).toContain('runningGenerationActivity(phase, elapsedSeconds)');
    expect(source).toContain("generating ? '任务运行中'");
    expect(source).toContain('animate-pulse');
    expect(source).toContain('aria-valuenow={generating ? undefined : progress}');
    expect(source).toContain('className="sr-only">{phase}</span>');
    expect(source).toContain('<span aria-hidden="true">');
  });
});
