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
 */
type AnchoredMenuProps = {
  open: boolean;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorEl?: HTMLElement | null;
  children: ReactNode;
  /** 菜单右边缘对齐锚点右边缘（默认 right），或左对齐 */
  align?: 'left' | 'right';
  /** 菜单与锚点之间的垂直间距 */
  gap?: number;
  minWidth?: number;
  className?: string;
  style?: CSSProperties;
};

export function AnchoredMenu({
  open,
  onClose,
  anchorRef,
  anchorEl,
  children,
  align = 'right',
  gap = 6,
  minWidth = 180,
  className = '',
  style,
}: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const getAnchor = useCallback(
    () => anchorEl ?? anchorRef?.current ?? null,
    [anchorEl, anchorRef],
  );

  const reposition = useCallback(() => {
    const anchor = getAnchor();
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const menu = menuRef.current;
    const mw = menu?.offsetWidth || minWidth;
    const mh = menu?.offsetHeight || 0;

    let left = align === 'right' ? a.right - mw : a.left;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - mw - 8));

    let top = a.bottom + gap;
    // 下方放不下 → 翻到锚点上方；上方也放不下 → 贴底夹取
    if (mh && top + mh > window.innerHeight - 8) {
      const above = a.top - gap - mh;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - mh - 8);
    }
    setPos({ top, left });
  }, [getAnchor, align, gap, minWidth]);

  // 打开时先定位一次，拿到真实尺寸后再用 rAF 校正一次（对齐 / 夹取 / 上翻）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
    const raf = requestAnimationFrame(reposition);
    return () => cancelAnimationFrame(raf);
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => reposition();
    const onResize = () => reposition();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (getAnchor()?.contains(t)) return; // 锚点自己负责 toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 捕获阶段监听滚动，任意祖先滚动都能跟随
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, reposition, onClose, getAnchor]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`fixed z-[9999] rounded-[10px] py-1 ${className}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        minWidth,
        // 首帧（未测量出真实尺寸前）先隐藏，避免左上角闪一下
        visibility: pos ? 'visible' : 'hidden',
        background: 'var(--bg-elevated)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        ...style,
      }}
      // portal 的 React 事件仍按组件树冒泡：挡住 mousedown/click，避免落到下层卡片的
      // onClick（导航）或触发其它点外关闭逻辑
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export default AnchoredMenu;
