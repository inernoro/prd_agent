import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'ShareSiteEditDock.tsx'), 'utf8');

describe('分享页所有者修改入口', () => {
  it('只做入口投射，复用完整站点读取与既有修改面板', () => {
    expect(SOURCE).toContain('getSite(siteId)');
    expect(SOURCE).toContain('<SiteEditPanel site={site} onPublished={handlePublished} compact />');
    expect(SOURCE).toContain('onPublished(updated)');
  });

  it('修改工具使用标准弹窗和受限高度，保留键盘退出', () => {
    expect(SOURCE).toContain('createPortal(');
    expect(SOURCE).toContain("position: 'fixed'");
    expect(SOURCE).toContain('<Dialog open={open}');
    expect(SOURCE).toContain('maxWidth={640}');
    expect(SOURCE).toContain('h-[min(65dvh,640px)] min-h-0');
    expect(SOURCE).toContain('shouldCloseOnEscape(event)');
  });

  it('加载过程中仍显示持续变化的反馈，不留下静止等待', () => {
    expect(SOURCE).toContain('<MapSpinner size={15} />');
    expect(SOURCE).toContain('正在准备修改工具');
  });

  it('统一助手入口存在时不再显示独立胶囊，保留独立使用时的安全区', () => {
    expect(SOURCE).toContain('!assistant && !hidden && !open');
    expect(SOURCE).toContain("useShareAssistantAction('edit', openEditor");
    expect(SOURCE).toContain("'calc(18px + env(safe-area-inset-bottom, 0px))'");
  });

});
