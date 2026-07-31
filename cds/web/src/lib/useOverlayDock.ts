/**
 * 壳层 Portal 宿主的解析入口（唯一一份）。
 *
 * 信息中心状态常驻 AppShell，但入口需要显示在每页 TopBar 的宿主内。挂载方用本
 * hook 等待 `#cds-information-center-host` 出现后再 createPortal，避免路由切换时
 * 重建 SSE 连接和提醒状态。
 *
 * 为什么用 effect + MutationObserver 而不是 render 期 querySelector：
 * 坞由 AppShell 渲染，首帧可能还没挂上；render 期查一次拿到 null 且不会重试，
 * 入口就永远不显示。effect 里查 + 观察 body 变化，能覆盖登录后才挂 AppShell、
 * 路由切换重挂等所有时机。
 */

import { useEffect, useState } from 'react';

export type OverlayDockSelector = '#cds-information-center-host';

/** 返回坞元素；坞尚未挂载时返回 null（调用方此时不渲染入口即可）。 */
export function useOverlayDock(selector: OverlayDockSelector): Element | null {
  const [dock, setDock] = useState<Element | null>(null);

  useEffect(() => {
    const resolve = (): void => {
      setDock((current) => {
        const next = document.querySelector(selector);
        return current === next ? current : next;
      });
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selector]);

  return dock;
}
