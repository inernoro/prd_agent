import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  containingBlockOffset,
  resolveMenuPortalTarget,
  shouldCloseOnOutsidePointer,
} from '../AnchoredMenu';

/**
 * 2026-09-25 验收：网页工作台（Radix 模态）里「发布给客户 → 生成链接并复制」点了没反应。
 * 模态把 body 设成 pointer-events:none、焦点锁在弹窗内容里，挂在 body 下的菜单收不到点击。
 * 这里用最小的假节点树验证三条判定，不依赖 DOM 环境。
 */
type FakeNode = {
  role?: string;
  parent: FakeNode | null;
  closest(selector: string): FakeNode | null;
  contains(other: unknown): boolean;
};

function node(parent: FakeNode | null, role?: string): FakeNode {
  const n: FakeNode = {
    role,
    parent,
    closest(selector) {
      if (selector !== '[role="dialog"]') throw new Error(`unexpected selector ${selector}`);
      for (let cur: FakeNode | null = n; cur; cur = cur.parent) if (cur.role === 'dialog') return cur;
      return null;
    },
    contains(other) {
      for (let cur = other as FakeNode | null; cur; cur = cur.parent) if (cur === n) return true;
      return false;
    },
  };
  return n;
}

const asEl = (n: FakeNode | null) => n as unknown as Element | null;

describe('AnchoredMenu 挂载位置', () => {
  it('锚点在弹窗里时挂进那个弹窗，不挂 body', () => {
    const body = node(null);
    const workbench = node(body, 'dialog');
    const shareButton = node(node(workbench));
    expect(resolveMenuPortalTarget(asEl(shareButton), 'BODY')).toBe(workbench);
  });

  it('锚点不在弹窗里时仍挂 body', () => {
    const body = node(null);
    const cardButton = node(node(body));
    expect(resolveMenuPortalTarget(asEl(cardButton), 'BODY')).toBe('BODY');
    expect(resolveMenuPortalTarget(null, 'BODY')).toBe('BODY');
  });
});

describe('AnchoredMenu 点外关闭', () => {
  const body = node(null);
  const workbench = node(body, 'dialog');
  const anchor = node(node(workbench));
  const confirmDialog = node(body, 'dialog');

  it('点在菜单所在弹窗的其它地方，关菜单', () => {
    const preview = node(node(workbench));
    expect(shouldCloseOnOutsidePointer(asEl(preview), anchor as unknown as Node)).toBe(true);
  });

  it('点在菜单弹出的另一个确认对话框里，不关菜单', () => {
    const confirmButton = node(confirmDialog);
    expect(shouldCloseOnOutsidePointer(asEl(confirmButton), anchor as unknown as Node)).toBe(false);
  });

  it('不在任何弹窗里的点击，关菜单', () => {
    expect(shouldCloseOnOutsidePointer(asEl(node(body)), anchor as unknown as Node)).toBe(true);
  });
});

describe('AnchoredMenu 参照系换算', () => {
  it('参照系就是视口时偏移为零', () => {
    expect(containingBlockOffset({ top: '120px', left: '40px' }, { top: 120, left: 40 })).toEqual({ dx: 0, dy: 0 });
  });

  it('弹窗成为参照系时量出偏移', () => {
    expect(containingBlockOffset({ top: '-9999px', left: '-9999px' }, { top: -9999 + 64, left: -9999 + 240 })).toEqual({
      dx: 240,
      dy: 64,
    });
  });

  it('还没写过坐标时不猜偏移', () => {
    expect(containingBlockOffset({ top: '', left: '' }, { top: 10, left: 10 })).toEqual({ dx: 0, dy: 0 });
  });
});

describe('弹窗出场动画不得留下 transform', () => {
  it('prd-dialog-content 的出场动画不用 both / forwards 填充', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../../styles/motion.css'), 'utf8');
    const rule = /\.prd-dialog-content\[data-state="open"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('prdDialogContentIn');
    expect(rule).not.toMatch(/\b(both|forwards)\b/);
  });
});
