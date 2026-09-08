import { describe, expect, it } from 'vitest';
import { siteEditDisplayProgress, siteEditStageState } from './SiteEditPanel';

describe('网页修改进度终态', () => {
  it('草稿生成完仍等待人工发布，不显示为完成', () => {
    const progress = siteEditDisplayProgress('draft-ready');
    expect(progress).toBe(95);
    expect(siteEditStageState(3, 3, false, progress)).toEqual({ complete: false, current: true });
  });

  it('只有发布成功显示完整进度', () => {
    const progress = siteEditDisplayProgress('published');
    expect(progress).toBe(100);
    expect(siteEditStageState(3, 3, false, progress)).toEqual({ complete: true, current: false });
  });

  it('服务端 Run 与失败状态不会带入错误的百分百进度', () => {
    expect(siteEditDisplayProgress('incomplete', 100)).toBe(95);
    expect(siteEditDisplayProgress('incomplete', 72)).toBe(72);
  });
});
