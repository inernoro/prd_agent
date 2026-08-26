import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';

/**
 * 表格行的操作收纳器：主操作留在行里，其余收进「更多」。
 *
 * 起因：Provider 表一行平铺八个操作（测试连接 / 查看模型 / 更新密钥 / 清除密钥 / 编辑 /
 * 停用 / 查看日志 / 删除），横向排成一堵墙，主次不分——真正常用的只有前两个，
 * 而「删除」这种不可逆动作反倒和它们等权并排（chief-designer-usability 第二原则：
 * 首屏只暴露 80% 场景需要的控件，其余渐进展开；第三原则：主操作要一眼可见）。
 *
 * 定位与关闭行为照抄 LogTableSettings 的既有 popover：portal 到 body（躲开表格的
 * overflow 裁剪）、按可用空间上下翻转、窄屏贴底、点外面或 Esc 关闭。
 */

export type RowAction = {
  key: string;
  label: string;
  /** 点击回调；与 to 二选一 */
  onSelect?: () => void;
  /** 站内跳转；与 onSelect 二选一 */
  to?: string;
  disabled?: boolean;
  /** 禁用时尤其要说清为什么，否则用户只看到一个点不动的灰按钮 */
  title?: string;
  /** 不可逆动作，菜单里用警示色并排在最后 */
  danger?: boolean;
};

export function RowActions({
  primary,
  actions,
  label = '更多操作',
}: {
  /** 留在行内的主操作，通常 1-2 个 */
  primary?: ReactNode;
  actions: RowAction[];
  label?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const position = () => {
      const trigger = rootRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw <= 720) {
        setStyle({ top: 'auto', right: 10, bottom: 10, left: 10, width: 'auto', visibility: 'visible' });
        return;
      }
      const width = 184;
      const gap = 6;
      const edge = 12;
      const spaceAbove = Math.max(120, trigger.top - gap - edge);
      const spaceBelow = Math.max(120, vh - trigger.bottom - gap - edge);
      const needed = actions.length * 34 + 12;
      const openBelow = spaceBelow >= needed || spaceBelow >= spaceAbove;
      const left = Math.min(vw - width - edge, Math.max(edge, trigger.right - width));
      setStyle(openBelow
        ? { top: trigger.bottom + gap, bottom: 'auto', left, width, maxHeight: Math.min(420, spaceBelow), visibility: 'visible' }
        : { top: 'auto', bottom: vh - trigger.top + gap, left, width, maxHeight: Math.min(420, spaceAbove), visibility: 'visible' });
    };
    position();
    window.addEventListener('resize', position);
    // 表格是滚动容器，捕获阶段监听才能跟住行的位置
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const visible = actions.filter(Boolean);

  return (
    <span className="lg-row-actions" ref={rootRef}>
      {primary}
      {visible.length > 0 ? (
        <>
          <button
            type="button"
            className="lg-row-actions-trigger"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            title={label}
            onClick={() => setOpen((v) => !v)}
          >
            <MoreHorizontal size={15} />
          </button>
          {open ? createPortal(
            <div ref={popoverRef} className="lg-row-actions-popover" role="menu" aria-label={label} style={style}>
              {visible.map((action) => {
                const cls = `lg-row-actions-item${action.danger ? ' is-danger' : ''}`;
                if (action.to && !action.disabled) {
                  return (
                    <Link
                      key={action.key}
                      role="menuitem"
                      className={cls}
                      to={action.to}
                      title={action.title}
                      onClick={() => setOpen(false)}
                    >
                      {action.label}
                    </Link>
                  );
                }
                return (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    className={cls}
                    disabled={action.disabled}
                    title={action.title}
                    onClick={() => { setOpen(false); action.onSelect?.(); }}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>,
            document.body,
          ) : null}
        </>
      ) : null}
    </span>
  );
}
