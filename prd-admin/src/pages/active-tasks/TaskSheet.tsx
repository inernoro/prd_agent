/**
 * 浮层 —— 两端两种形态，同一份内容。
 *
 * macOS 的 sheet 从窗口顶边落下、按钮右对齐（次要在左、默认在右）、ESC 关闭；
 * iOS 的 sheet 从屏幕底边升起、顶部一条 grabber、导航栏左「取消」右「完成」。
 * 上一版两端共用一个垂直居中的卡片：手机上键盘一弹就把它顶走，桌面上又不像 Mac。
 *
 * 物理约束照 .claude/rules/frontend-modal.md：createPortal 挂 body、高度走 inline style、
 * 滚动区 minHeight:0 + overscrollBehavior:contain、z-index 100 起步。
 */
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '@/hooks/useBreakpoint';

export interface TaskSheetProps {
  title: string;
  /** 主操作的文字，如「加进去」「结案」 */
  confirmLabel: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

const FOCUSABLE = 'input,textarea,select,button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

export function TaskSheet({
  title, confirmLabel, confirmDisabled, cancelLabel = '取消', onConfirm, onClose, children,
}: TaskSheetProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // ESC 关闭 + Tab 在浮层内循环：键盘用户不该 Tab 着 Tab 着就跑到背后的列表上去
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  // 键盘监听挂的是一个**永不变身**的转发函数，真正的处理逻辑从 ref 里取最新的。
  // 为什么不能直接把 onKeyDown 当依赖：调用方普遍传内联的 onClose
  // （`onClose={() => { abort(); onClose(); }}`），每次父组件渲染都是新函数，
  // onKeyDown 跟着变身，effect 重跑，于是下面那段「焦点落到第一个可输入的东西上」
  // 每敲一个字就重放一次。派活弹窗里 select 排在标题输入框前面，
  // querySelector('input,textarea,select') 取的是文档序第一个 —— 也就是那个 select，
  // 结果就是打第一个字焦点被弹回选择框，这张表根本填不进去。
  const latestKeyDown = useRef(onKeyDown);
  latestKeyDown.current = onKeyDown;

  useEffect(() => {
    const listener = (e: KeyboardEvent) => latestKeyDown.current(e);
    restoreTo.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', listener, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 焦点落到第一个可输入的东西上；没有就落到面板自己身上。只在打开时做一次。
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('input,textarea,select') ?? panel;
    target?.focus();
    return () => {
      document.removeEventListener('keydown', listener, true);
      document.body.style.overflow = prevOverflow;
      restoreTo.current?.focus?.();
    };
    // 故意只跑一次：这段是「浮层打开/关闭」的一次性布置，不是每次渲染的同步。
    // 上面那个转发函数不进依赖，所以这里不需要 eslint-disable —— 留着会被报成失效指令
  }, []);

  const sheet = (
    <div
      className={`atb-sheet-backdrop${isMobile ? ' atb-sheet-backdrop--bottom' : ''}`}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        className={`atb-sheet${isMobile ? ' atb-sheet--bottom' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ maxHeight: isMobile ? '88vh' : '80vh' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isMobile ? (
          <>
            <span className="atb-grabber" aria-hidden="true" />
            <div className="atb-navbar">
              <button className="atb-navbtn" onClick={onClose}>{cancelLabel}</button>
              <span className="atb-navbar__title">{title}</span>
              <button className="atb-navbtn atb-navbtn--go" disabled={confirmDisabled} onClick={onConfirm}>
                {confirmLabel}
              </button>
            </div>
            <div className="atb-sheet__body" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {children}
            </div>
          </>
        ) : (
          <>
            <span className="atb-sheet__title">{title}</span>
            <div className="atb-sheet__body" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {children}
            </div>
            <div className="atb-actions">
              <button className="atb-btn atb-btn--quiet" onClick={onClose}>{cancelLabel}</button>
              <button className="atb-btn" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}

export default TaskSheet;
