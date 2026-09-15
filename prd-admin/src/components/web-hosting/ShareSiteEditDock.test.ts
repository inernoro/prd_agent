import { describe, expect, it } from 'vitest';
import { shouldCloseOnEscape } from './ShareSiteEditDock';
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
    expect(SOURCE).toContain('shouldCloseOnEscape(event)');
  });

  it('加载过程中仍显示持续变化的反馈，不留下静止等待', () => {
    expect(SOURCE).toContain('<MapSpinner size={15} />');
    expect(SOURCE).toContain('正在准备修改工具');
  });

  it('提问入口存在时纵向错开，避免窄屏和 CDS 制品条横向遮挡', () => {
    expect(SOURCE).toContain("'calc(66px + env(safe-area-inset-bottom, 0px))'");
    expect(SOURCE).toContain("'calc(18px + env(safe-area-inset-bottom, 0px))'");
  });

  // 坞里会打开 Radix 的知识选择弹窗，Radix 在捕获阶段处理 Escape 并 preventDefault，
  // 事件照样冒泡到坞挂在 document 上的监听器。不看 defaultPrevented 的话，用户按一次
  // Escape 只想关掉知识浏览器，却把整个坞连同还没保存的修改要求一起关掉了
  // （Codex P2，2026-09-15）。
  describe('Escape 只关最上面那一层', () => {
    it('没人处理过的 Escape 关掉坞', () => {
      expect(shouldCloseOnEscape({ key: 'Escape', defaultPrevented: false })).toBe(true);
    });

    it('已被上层弹窗处理掉的 Escape 不关坞', () => {
      expect(
        shouldCloseOnEscape({ key: 'Escape', defaultPrevented: true }),
        '嵌套弹窗按 Escape 会连坞一起关掉，用户丢掉还没保存的修改要求',
      ).toBe(false);
    });

    it('别的按键一概不关', () => {
      expect(shouldCloseOnEscape({ key: 'Enter', defaultPrevented: false })).toBe(false);
      expect(shouldCloseOnEscape({ key: 'Esc', defaultPrevented: false })).toBe(false);
    });
  });
});
