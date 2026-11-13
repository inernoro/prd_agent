// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardMoreButton } from './SiteCardActions';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';

// 使用真实菜单验证：关闭更多菜单后，分享浮层的锚点仍连接在文档内。
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CardMoreButton 分享入口', () => {
  it('点击分享后关闭更多菜单，分享浮层以常驻更多按钮定位', async () => {
    const onShare = vi.fn();
    function Fixture() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      return <>
        <CardMoreButton actions={[{ label: '分享', icon: null, onClick: (button) => {
          onShare(button);
          setAnchor(button);
        } }]} />
        <AnchoredMenu open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}>
          <button>生成链接并复制</button>
        </AnchoredMenu>
      </>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Fixture />));
      const trigger = container.querySelector('button')!;
      await act(async () => trigger.click());
      const share = [...document.querySelectorAll('button')].find(button => button.textContent === '分享')!;
      expect(share).toBeDefined();
      await act(async () => share.click());
      expect(onShare).toHaveBeenCalledTimes(1);
      expect(onShare).toHaveBeenCalledWith(trigger);
      expect(trigger.isConnected).toBe(true);
      expect(share.isConnected).toBe(false);
      const create = [...document.querySelectorAll('button')].find(button => button.textContent === '生成链接并复制')!;
      expect(create).toBeDefined();
      expect(create.parentElement!.style.visibility).toBe('visible');
    } finally {
      await act(async () => root.unmount());
    }
  });
  it('右键与更多共用操作，空白区域即使阻止冒泡也能关闭', async () => {
    const action = vi.fn();
    function Fixture() {
      const target = useRef<HTMLDivElement>(null);
      return <><div ref={target} data-card><CardMoreButton contextTargetRef={target} actions={[{ label: '编辑信息', icon: null, onClick: action }]} /></div>
        <div data-blank onPointerDown={event => event.stopPropagation()}>空白</div></>;
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Fixture />));
      const card = container.querySelector('[data-card]')!;
      await act(async () => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })));
      expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('编辑信息');
      await act(async () => container.querySelector('[data-blank]')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
      expect(document.querySelector('[role="menu"]')).toBeNull();
      const more = container.querySelector('button')!;
      await act(async () => more.click());
      expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('编辑信息');
      await act(async () => more.click());
      expect(document.querySelector('[role="menu"]')).toBeNull();
      await act(async () => more.click());
      await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
      expect(action).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

});
