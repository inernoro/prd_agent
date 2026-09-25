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

/**
 * fixed 定位以视口为准，但挂进弹窗后，若弹窗带 transform 等属性，fixed 会改以弹窗为参照。
 * 用「上一次写进去的坐标」与「实际落点」之差量出这个偏移，换算回视口坐标。
 */
export function containingBlockOffset(
  applied: { top: string; left: string },
  actual: { top: number; left: number },
): { dx: number; dy: number } {
  const top = parseFloat(applied.top);
  const left = parseFloat(applied.left);
  if (!Number.isFinite(top) || !Number.isFinite(left)) return { dx: 0, dy: 0 };
  return { dx: actual.left - left, dy: actual.top - top };
}
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
    // anchorEl 可能指向已被卸载（切 tab / 列表重挂载）的旧元素：detached 元素 rect 全为 0，
    // 会把菜单定位到左上角错位显示。此时不定位（保持隐藏），交给下面的 effect 关闭。
    if (!anchor || !anchor.isConnected) return;
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
    // 挂在 body 下时 fixed 就是视口坐标；挂进弹窗时按实际参照系换算
    if (menu && menu.parentElement !== document.body) {
      const r = menu.getBoundingClientRect();
      const { dx, dy } = containingBlockOffset(menu.style, r);
      top -= dy;
      left -= dx;
    }
    setPos({ top, left });
  }, [getAnchor, align, gap, minWidth]);

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
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (getAnchor()?.contains(t)) return; // 锚点自己负责 toggle
      // 从菜单里弹出的模态对话框（如发布前私有资料确认）渲染在别的 portal 里，DOM 上不在菜单内，
      // 但它是这次菜单操作的一部分：在对话框里点按钮不该把下层菜单关掉，否则确认后的结果
      // （例如刚生成的分享链接）没有地方就地显示。判定见 shouldCloseOnOutsidePointer。
      if (!shouldCloseOnOutsidePointer(t instanceof Element ? t : null, getAnchor())) return;
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
      className={`fixed z-[9999] rounded-[10px] py-1 ${className} border border-token-subtle`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth, visibility: pos ? 'visible' : 'hidden', background: 'var(--bg-elevated)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)', ...style }}
      // portal 的 React 事件仍按组件树冒泡：挡住 mousedown/click，避免落到下层卡片的
      // onClick（导航）或触发其它点外关闭逻辑
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    resolveMenuPortalTarget(getAnchor(), document.body),
  );
}

export default AnchoredMenu;
