import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 锚定下拉菜单（AnchoredMenu）
 *
 * 解决「下拉被父容器裁掉 / 被同级内容盖住」的高频问题：菜单走 createPortal 挂到
 * document.body，用 fixed + 锚点 getBoundingClientRect 定位，物理脱离任何祖先的
 * overflow-hidden / transform / 独立 stacking context（PageHeader 自身就是
 * overflow-hidden 的圆角玻璃条，绝对定位的下拉一律会被它裁掉）。
 *
 * 见 .claude/rules/frontend-modal.md：任何浮层（Modal / Dropdown / Popover）都必须
 * createPortal 到 body，布局关键尺寸走 inline style。
 *
 * 锚点可传 anchorRef（包裹按钮的 ref）或 anchorEl（在 .map 列表里用 e.currentTarget
 * 存进 state 的元素），二选一。组件自带：视口边界夹取 + 下方放不下自动上翻 + 点外关闭
 * （排除锚点自身，便于按钮 toggle）+ ESC 关闭 + 滚动/缩放跟随重定位。
 *
 * 锚点在模态弹窗里时（如网页工作台），菜单挂进那个弹窗而不是 body：Radix 模态会把 body
 * 设成 pointer-events:none、把焦点锁在弹窗内容里，挂在 body 下的菜单点不动、输入框也拿不到
 * 焦点（2026-09-25 验收：工作台「发布给客户 → 生成链接并复制」点了没反应）。
 */

type ClosestCapable = { closest(selector: string): Element | null };

/** 菜单该挂到哪：锚点所在的弹窗，没有就是 body。 */
export function resolveMenuPortalTarget<T>(anchor: ClosestCapable | null, body: T): Element | T {
  return anchor?.closest('[role="dialog"]') ?? body;
}

/**
 * 点在菜单与锚点之外时要不要关菜单。
 * 从菜单里弹出的确认对话框渲染在别的弹窗里：在那里点按钮是这次菜单操作的一部分，不关；
 * 但菜单所在的那个弹窗本身也是 dialog，点它的其它地方就是点外面，照常关。
 */
export function shouldCloseOnOutsidePointer(target: ClosestCapable | null, anchor: Node | null): boolean {
  const dialog = target?.closest('[role="dialog"]');
  if (!dialog) return true;
  return anchor ? dialog.contains(anchor) : false;
}

type AnchoredMenuProps = {
  open: boolean;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorEl?: HTMLElement | null;
  children: ReactNode;
  /** 默认对齐锚点右缘。窄屏也可贴视口右缘。 */
  align?: 'left' | 'right' | 'viewport-right';
  offsetX?: number;
  /** 菜单与锚点之间的垂直间距 */
  gap?: number;
  minWidth?: number;
  className?: string;
  theme?: 'light' | 'dark';
  style?: CSSProperties;
  ignoreAutomaticFrameFocus?: boolean;
};

export function AnchoredMenu({
  open,
  onClose,
  anchorRef,
  anchorEl,
  children,
  align = 'right',
  offsetX = 0,
  gap = 6,
  minWidth = 180,
  className = '',
  theme,
  style,
  ignoreAutomaticFrameFocus = false,
}: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const getAnchor = useCallback(
    () => anchorEl ?? anchorRef?.current ?? null,
    [anchorEl, anchorRef],
  );

  const reposition = useCallback(() => {
    const anchor = getAnchor();
    // anchorEl 可能指向已被卸载（切 tab / 列表重挂载）的旧元素：detached 元素 rect 全为 0，
    // 会把菜单定位到左上角错位显示。此时不定位（保持隐藏），交给下面的 effect 关闭。
    if (!anchor || !anchor.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const menu = menuRef.current;
    // 固定原点与菜单共用弹窗参照系，不依赖正在更新的菜单坐标。
    const origin = originRef.current?.getBoundingClientRect();
    const scaleX = origin?.width || 1;
    const scaleY = origin?.height || 1;
    const mw = (menu?.offsetWidth || minWidth) * scaleX;
    const mh = (menu?.offsetHeight || 0) * scaleY;

    let left = (align === 'viewport-right' ? window.innerWidth - mw - 8 : align === 'right' ? a.right - mw : a.left) + offsetX;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - mw - 8));

    let top = a.bottom + gap;
    // 下方放不下 → 翻到锚点上方；上方也放不下 → 贴底夹取
    if (mh && top + mh > window.innerHeight - 8) {
      const above = a.top - gap - mh;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - mh - 8);
    }
    setPos({ top: (top - (origin?.top ?? 0)) / scaleY, left: (left - (origin?.left ?? 0)) / scaleX });
  }, [getAnchor, align, offsetX, gap, minWidth]);

  // 打开时先定位一次，拿到真实尺寸后再用 rAF 校正一次（对齐 / 夹取 / 上翻）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    // 锚点已随父组件卸载（如 anchorEl 指向切 tab 前的旧按钮）：直接关闭，避免错位浮层 +
    // 让父级 open 状态复位（否则回到原卡片首次点击只会 toggle 关掉、打不开）。
    const anchor = getAnchor();
    if (anchor && !anchor.isConnected) {
      onClose();
      return;
    }
    reposition();
    const raf = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(raf);
  }, [open, reposition, getAnchor, onClose]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => reposition();
    const onResize = () => reposition();
    let closing = false;
    const closeOutside = (target: Node) => {
      if (closing) return;
      if (menuRef.current?.contains(target)) return;
      if (getAnchor()?.contains(target)) return; // 锚点自己负责 toggle
      // 从菜单里弹出的模态对话框（如发布前私有资料确认）渲染在别的 portal 里，DOM 上不在菜单内，
      // 但它是这次菜单操作的一部分：在对话框里点按钮不该把下层菜单关掉，否则确认后的结果
      // （例如刚生成的分享链接）没有地方就地显示。判定见 shouldCloseOnOutsidePointer。
      if (!shouldCloseOnOutsidePointer(target instanceof Element ? target : null, getAnchor())) return;
      closing = true; onClose();
    };
    const onDown = (event: PointerEvent | MouseEvent) => { if (event.target instanceof Node) closeOutside(event.target); };
    // A focus change alone does not reliably report touches inside a cross-origin document.
    const onFrameDown = (event: Event) => {
      const frame = (event as CustomEvent<unknown>).detail;
      if (frame instanceof HTMLIFrameElement && frame.isConnected) closeOutside(frame);
    };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        const target = document.activeElement;
        const anchor = getAnchor();
        if (!(target instanceof HTMLIFrameElement) || menuRef.current?.contains(target)
          || anchor?.contains(target) || !shouldCloseOnOutsidePointer(target, anchor) || closing) return;
        // A hosted page may acquire focus during startup while the pointer is still on the toolbar.
        if (ignoreAutomaticFrameFocus && !target.matches(':hover')) {
          anchor?.focus({ preventScroll: true });
          return;
        }
        closing = true;
        onClose();
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 捕获阶段监听滚动，任意祖先滚动都能跟随
    // 列表切换、标签筛选等会改变菜单尺寸，需重新夹取视口边界。
    const sizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    if (menuRef.current) sizeObserver?.observe(menuRef.current);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('map-iframe-pointerdown', onFrameDown);
    window.addEventListener('blur', onBlur);
    document.addEventListener('keydown', onKey);
    // 弹窗出场动画期间带 transform、是 fixed 的参照系；动画一结束参照系换回视口，
    // 在这期间打开的菜单要按新参照系重算一次，否则会停在错位的位置上。
    const host = resolveMenuPortalTarget(getAnchor(), null);
    host?.addEventListener('animationend', onResize);
    return () => {
      host?.removeEventListener('animationend', onResize);
      sizeObserver?.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('map-iframe-pointerdown', onFrameDown);
      window.removeEventListener('blur', onBlur);
      clearTimeout(blurTimer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, reposition, onClose, getAnchor, ignoreAutomaticFrameFocus]);

  if (!open) return null;

  const portalTarget = resolveMenuPortalTarget(getAnchor(), document.body);
  return createPortal(<>
    {portalTarget !== document.body && <span ref={originRef} aria-hidden="true"
      style={{ position: 'fixed', inset: '0 auto auto 0', width: 1, height: 1, visibility: 'hidden', pointerEvents: 'none' }} />}
    <div
      ref={menuRef}
      data-theme={theme}
      className={`fixed z-[9999] rounded-[10px] py-1 ${className} border border-token-subtle`}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, minWidth: `min(${minWidth}px, calc(100vw - 16px))`, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 16px)', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', visibility: pos ? 'visible' : 'hidden', background: 'var(--overlay-panel-solid)', boxShadow: 'var(--shadow-glass-dropdown)', ...style }}
      // portal 的 React 事件仍按组件树冒泡：挡住 mousedown/click，避免落到下层卡片的
      // onClick（导航）或触发其它点外关闭逻辑
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
    </>, portalTarget,
  );
}

export default AnchoredMenu;
