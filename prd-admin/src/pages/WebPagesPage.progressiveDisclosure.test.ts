import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./WebPagesPage.tsx', import.meta.url), 'utf8');

describe('网页托管桌面首屏渐进披露', () => {
  it('默认收起站点概览，并允许用户显式展开', () => {
    expect(source).toContain('const [showDesktopContext, setShowDesktopContext] = useState(false)');
    expect(source).toContain('data-tour-id="webpages-context-toggle"');
    expect(source).toContain('aria-controls="webpages-context-panel"');
    expect(source).toContain('aria-expanded={showDesktopContext || !!selectedSite || selectedIds.size > 1}');
    expect(source).toContain("!isMobile && (selectedSite || selectedIds.size > 1 || showDesktopContext)");
    expect(source).toContain('id="webpages-context-panel"');
  });

  it('把组织、排序、尺寸、来源和视图收进同一个整理入口', () => {
    expect(source).toContain('label="整理"');
    expect(source).toContain('tourId="webpages-organize-popover"');
    expect(source).toContain('openToolbarPanel === \'organize\'');
    expect(source).toContain('组织方式');
    expect(source).toContain('data-tour-id="webpages-group-pills"');
    expect(source).toContain('data-tour-id="webpages-sort-pills"');
    expect(source).toContain('data-tour-id="webpages-card-size-pills"');
    expect(source).toContain('来源筛选');
    expect(source).toContain('data-tour-id="webpages-view-toggle"');
  });

  it('突出帮我修改，同时保留知识生成、上传和访客预览能力', () => {
    expect(source).toContain('data-tour-id="webpages-ai-edit-primary"');
    expect(source).toContain("openSiteEditor(contextSite, 'compose')");
    expect(source).toContain('帮我修改');
    expect(source).toContain('data-tour-id="webpages-knowledge-generate"');
    expect(source).toContain('data-tour-id="webpages-upload-primary"');
    expect(source).toContain('data-tour-id="webpages-guest-preview"');
  });
});
