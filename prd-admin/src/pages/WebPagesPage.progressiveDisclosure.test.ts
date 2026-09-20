import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./WebPagesPage.tsx', import.meta.url), 'utf8');

describe('网页托管原版列表布局回归', () => {
  it('桌面保持原右栏三态，不以站点概览开关隐藏上下文', () => {
    expect(source).not.toContain('showDesktopContext');
    expect(source).not.toContain('webpages-context-toggle');
    expect(source).toMatch(/!isMobile && \(\s*selectedSite \? \(/);
    expect(source).toContain('<SiteSelectionPanel');
    expect(source).toContain('<SiteBatchPanel');
    expect(source).toContain('<SiteContextPanel');
  });

  it('搜索、四档组织、显示、网格列表和上传按原顺序常驻', () => {
    const toolbar = source.slice(source.indexOf('const desktopToolbar ='), source.indexOf('\n  return (', source.indexOf('const desktopToolbar =')));
    expect(toolbar).not.toContain('label="整理"');
    const positions = ['placeholder="搜索标题、描述、标签"', 'data-tour-id="webpages-group-pills"', 'label="显示"', 'data-tour-id="webpages-view-toggle"', 'data-tour-id="webpages-upload-primary"'].map((marker) => toolbar.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(toolbar).toContain('ALL_GROUP_MODES.map');
    expect(toolbar).toContain('data-tour-id="webpages-sort-pills"');
    expect(toolbar).toContain('data-tour-id="webpages-card-size-pills"');
    expect(toolbar).toContain('来源筛选');
    expect(toolbar).toContain('size="sm" variant="primary" onClick={openCreateUploadDialog}');
    expect(toolbar).not.toContain('帮我修改');
    expect(toolbar).not.toContain('webpages-knowledge-generate');
  });

  it('只在原站点菜单进入修改，知识生成复用上传弹窗且深链保持可用', () => {
    expect(source).not.toContain('webpages-ai-edit-primary');
    expect(source).not.toContain('onVersionHistory');
    expect(source).toContain("label: '帮我修改'");
    expect(source).toContain('onGenerate: () => void');
    expect(source).toContain('data-tour-id="webpages-knowledge-generate"');
    expect(source).toContain('onClick={onGenerate}');
    expect(source).toContain('parseDesignArtifactLaunch(location.search)');
    expect(source).toContain('<MobileFab onClick={openCreateUploadDialog} icon={Upload} label="上传" />');
    expect(source).toContain("gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))'");
    expect(source).toContain('data-tour-id="webpages-guest-preview"');
  });
});
