import { useCallback, useRef } from 'react';

/**
 * 投放面板（ShareDock）统一拖拽协议。
 *
 * 为什么不用 HTML5 DnD：
 * - HTML5 DnD 把拖拽图像渲染在 OS 合成器层，与鼠标解耦，视觉漂移且不跟手
 * - 不支持触摸设备；无法精确控制 ghost 位置
 *
 * Pointer Events 方案：
 * - setPointerCapture 锁定指针，60+ FPS 跟手
 * - ghost 用 position: fixed 的 DOM 节点，transform 同步更新
 * - 落点检测用 document.elementFromPoint + data 属性约定
 * - 跨组件通信用 CustomEvent，解耦 card 与 dock
 */

export interface DockDragOptions {
  /** MIME 必须与目标 Dock 一致，避免跨页面误落 */
  mime: string;
  /** 被拖拽对象 ID（后续通过 CustomEvent 传给 Dock slot） */
  id: string;
  /** ghost 上显示的短文案（默认显示 id 前 8 位） */
  label?: string;
  /** ghost 左侧图标（Emoji 或简短字符） */
  icon?: string;
  /** 开始拖拽前的阈值（px），小于该距离不认为是拖拽，避免误触阻塞 click */
  threshold?: number;
}

/** 自定义事件：Dock 监听这些事件以激活/熄灭 */
export const DOCK_EVENTS = {
  START: 'map-dock:start',
  END: 'map-dock:end',
  DROP: 'map-dock:drop',
} as const;

export interface DockStartDetail {
  mime: string;
  id: string;
}

export interface DockDropDetail {
  mime: string;
  id: string;
  slotKey: string;
}

/**
 * Hook：给可拖拽元素挂 `onPointerDown`。
 *
 * 用法：
 * ```tsx
 * const { onPointerDown } = useDockDrag({ mime: SITE_MIME, id: site.id, label: site.title });
 * <div onPointerDown={onPointerDown} className="cursor-grab">...</div>
 * ```
 *
 * Slot 侧用 `data-dock-slot="key"` 和 `data-dock-mime="xxx"` 标识自己。
 */
export function useDockDrag(options: DockDragOptions) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // 只响应鼠标左键 / 触屏 / 笔
    if (e.button !== 0) return;
    // 按钮/链接/输入框内按下：跳过（避免打断原交互）
    const target = e.target as HTMLElement | null;
    if (target?.closest('button,a,input,textarea,select,[data-no-drag]')) return;

    const { mime, id, label, icon, threshold = 4 } = optsRef.current;
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    let lastSlot: HTMLElement | null = null;
    let started = false;

    const createGhost = (): HTMLDivElement => {
      const el = document.createElement('div');
      el.setAttribute('data-dock-ghost', '1');
      el.style.cssText = [
        'position: fixed',
        'left: 0',
        'top: 0',
        'pointer-events: none',
        'z-index: 9999',
        'padding: 8px 12px',
        'border-radius: 10px',
        'background: rgba(14, 15, 20, 0.92)',
        'border: 1px solid rgba(255, 255, 255, 0.18)',
        'box-shadow: 0 12px 32px -8px rgba(0,0,0,0.6), 0 0 24px rgba(56,189,248,0.25)',
        'color: rgba(255,255,255,0.92)',
        'font-size: 12px',
        'font-weight: 500',
        'max-width: 220px',
        'white-space: nowrap',
        'overflow: hidden',
        'text-overflow: ellipsis',
        'transform: translate(-9999px, -9999px)',
        'will-change: transform',
        'user-select: none',
        'transition: transform 40ms linear',
      ].join(';');
      el.textContent = `${icon ?? '📦'}  ${label ?? id.slice(0, 8)}`;
      return el;
    };

    const hoverOn = (slot: HTMLElement | null) => {
      if (slot === lastSlot) return;
      if (lastSlot) lastSlot.setAttribute('data-dock-hover', 'false');
      if (slot) slot.setAttribute('data-dock-hover', 'true');
      lastSlot = slot;
    };

    const findSlot = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const slot = (el as HTMLElement).closest(
        `[data-dock-slot][data-dock-mime="${mime}"]`,
      ) as HTMLElement | null;
      return slot;
    };

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.hypot(dx, dy) < threshold) return;
        started = true;
        ghost = createGhost();
        document.body.appendChild(ghost);
        document.body.style.cursor = 'grabbing';
        window.dispatchEvent(
          new CustomEvent<DockStartDetail>(DOCK_EVENTS.START, { detail: { mime, id } }),
        );
      }
      if (ghost) {
        ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      }
      hoverOn(findSlot(ev.clientX, ev.clientY));
      ev.preventDefault();
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      hoverOn(null);
      if (ghost) ghost.remove();
      ghost = null;
      document.body.style.cursor = '';
      if (started) {
        window.dispatchEvent(
          new CustomEvent<DockStartDetail>(DOCK_EVENTS.END, { detail: { mime, id } }),
        );
      }
    };

    const onUp = (ev: PointerEvent) => {
      if (!started) {
        cleanup();
        return;
      }
      const slot = findSlot(ev.clientX, ev.clientY);
      cleanup();
      if (slot) {
        const slotKey = slot.getAttribute('data-dock-slot') ?? '';
        window.dispatchEvent(
          new CustomEvent<DockDropDetail>(DOCK_EVENTS.DROP, {
            detail: { mime, id, slotKey },
          }),
        );
      }
    };

    const onCancel = () => cleanup();

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, []);

  return { onPointerDown };
}
