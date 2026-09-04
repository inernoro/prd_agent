import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'ShareSiteEditDock.tsx'), 'utf8');

describe('分享页所有者修改入口', () => {
  it('只做入口投射，复用完整站点读取与既有修改面板', () => {
    expect(SOURCE).toContain('getSite(siteId)');
    expect(SOURCE).toContain('<SiteEditPanel site={site} onPublished={handlePublished} />');
    expect(SOURCE).toContain('onPublished(updated)');
  });

  it('抽屉通过 portal 挂载，并满足全高与内部可收缩约束', () => {
    expect(SOURCE).toContain('createPortal(');
    expect(SOURCE).toContain("position: 'fixed'");
    expect(SOURCE).toContain('top: 0');
    expect(SOURCE).toContain('bottom: 0');
    expect(SOURCE).toContain('minHeight: 0');
    expect(SOURCE).toContain("event.key === 'Escape'");
  });

  it('加载过程中仍显示持续变化的反馈，不留下静止等待', () => {
    expect(SOURCE).toContain('<MapSpinner size={15} />');
    expect(SOURCE).toContain('正在准备修改工具');
  });

  it('提问入口存在时纵向错开，避免窄屏和 CDS 制品条横向遮挡', () => {
    expect(SOURCE).toContain("'calc(66px + env(safe-area-inset-bottom, 0px))'");
    expect(SOURCE).toContain("'calc(18px + env(safe-area-inset-bottom, 0px))'");
  });
});
