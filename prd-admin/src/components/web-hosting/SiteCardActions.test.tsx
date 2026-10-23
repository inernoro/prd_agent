// @vitest-environment jsdom
import { act, useState } from 'react';
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
});
