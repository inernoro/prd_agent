/**
 * 两个角落浮层坞的解析入口（唯一一份）。
 *
 * CDS 只有两个常驻浮层坞，定位与堆叠全在 index.css 里：
 *   - `.cds-global-action-stack` —— 右下角，站内提醒 / 更新徽章 / 提交缺陷入口；
 *   - `.cds-bottom-left-dock`    —— 左下角，CommitInbox / 接入 Agent 入口。
 * 挂在 AppShell 之外的浮层（App.tsx 层、或 portal 到 body 的组件）用本 hook 拿到
 * 坞元素后 `createPortal` 进去，**不要**自己写 `position: fixed; bottom: 1rem; …`：
 * 自己定位的浮层与坞里的浮层几何重合，谁后渲染谁盖住谁（2026-07-28 用户反馈的两处遮挡）。
 *
 * 为什么用 effect + MutationObserver 而不是 render 期 querySelector：
 * 坞由 AppShell 渲染，首帧可能还没挂上；render 期查一次拿到 null 且不会重试，
 * 入口就永远不显示。effect 里查 + 观察 body 变化，能覆盖登录后才挂 AppShell、
 * 路由切换重挂等所有时机。
 */

import { useEffect, useState } from 'react';

export type OverlayDockSelector = '.cds-global-action-stack' | '.cds-bottom-left-dock';

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
