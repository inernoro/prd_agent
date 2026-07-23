import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  CREATE_PALETTE_DOUBLE_ACTIVATION_MS,
  isCreatePaletteDoubleActivation,
} from './createPaletteGesture';

/**
 * 库内唯一「新增」入口：右下角悬浮「+」，点击后竖排展开动作菜单（speed-dial）。
 *
 * 设计沿革：
 * - 2026-07-10 首版为「调色盘」弧形展开，动作沿左上四分之一圆弧散开；
 * - 2026-07-12 用户反馈弧形布局在移动端互相遮挡（6 项时相邻按钮弦距约 37px，
 *   小于按钮本身 44px，标签压住相邻图标），且动作太多没有归类。
 *   改为竖排菜单 + 分组：上传类动作收进「上传与导入」分组，点分组展开子项、
 *   再点收起；竖排固定行距，物理上不可能遮挡。
 * - 新增入口仍只有一个，用户心智 = 「想加东西就点右下角」；点空白/ESC 收起。
 */
export type PaletteAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 叶子动作：点击后收起菜单并执行。分组项（有 children）忽略此字段 */
  onClick?: () => void;
  /** 可选强调色（图标底色），默认走 accent 蓝 */
  hue?: string;
  /** 分组：点击展开/收起子动作（再次点击可收起） */
  children?: PaletteAction[];
};

export function CreatePaletteFab({ actions, onDoubleActivation }: {
  actions: PaletteAction[];
  /** 双击右下角主按钮时直接执行；单击仍展开原有新增菜单。 */
  onDoubleActivation?: () => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const lastActivationRef = useRef<number | null>(null);
  const singleActivationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => () => {
    if (singleActivationTimerRef.current !== null) {
      window.clearTimeout(singleActivationTimerRef.current);
    }
  }, []);

  // 关闭时重置分组展开态，下次打开回到干净的一级菜单
  useEffect(() => {
    if (!open) setExpandedGroup(null);
  }, [open]);

  if (actions.length === 0) return null;

  // 手机端悬浮在底部 TabBar 之上；桌面端贴右下角
  const bottom = isMobile
    ? 'calc(env(safe-area-inset-bottom, 0px) + var(--mobile-tab-height, 56px) + 16px)'
    : '24px';
  const right = isMobile ? '16px' : '24px';

  const fireLeaf = (a: PaletteAction) => {
    setOpen(false);
    a.onClick?.();
  };

  const handleMainActivation = (event: MouseEvent<HTMLButtonElement>) => {
    if (!onDoubleActivation) {
      setOpen(value => !value);
      return;
    }

    const now = event.timeStamp;
    if (isCreatePaletteDoubleActivation(lastActivationRef.current, now)) {
      lastActivationRef.current = null;
      if (singleActivationTimerRef.current !== null) {
        window.clearTimeout(singleActivationTimerRef.current);
        singleActivationTimerRef.current = null;
      }
      setOpen(false);
      onDoubleActivation();
      return;
    }

    lastActivationRef.current = now;
    singleActivationTimerRef.current = window.setTimeout(() => {
      singleActivationTimerRef.current = null;
      lastActivationRef.current = null;
      setOpen(value => !value);
    }, CREATE_PALETTE_DOUBLE_ACTIVATION_MS);
  };

  const renderRow = (a: PaletteAction, opts: { child?: boolean; index: number }) => {
    const Icon = a.icon;
    const isGroup = !!a.children?.length;
    const expanded = expandedGroup === a.key;
    const size = opts.child ? 38 : 44;
    return (
      <motion.button
        key={a.key}
        layout
        className="flex cursor-pointer items-center justify-end gap-2"
        initial={{ opacity: 0, y: 10, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.9, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 460, damping: 30, delay: opts.index * 0.025 }}
        aria-expanded={isGroup ? expanded : undefined}
        onClick={() => {
          if (isGroup) setExpandedGroup(prev => (prev === a.key ? null : a.key));
          else fireLeaf(a);
        }}
      >
        <span
          className="flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold"
          style={{
            background: 'var(--bg-card, rgba(20,20,24,0.92))',
            border: '1px solid var(--border-faint)',
            color: expanded ? 'var(--text-muted)' : 'var(--text-primary)',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
          }}>
          {a.label}
          {isGroup && (
            <motion.span
              className="flex items-center"
              animate={{ rotate: expanded ? 180 : 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 24 }}>
              <ChevronDown size={12} />
            </motion.span>
          )}
        </span>
        <span
          className="flex flex-shrink-0 items-center justify-center rounded-full"
          style={{
            height: size,
            width: size,
            // 子项与一级项的图标圆心对齐同一竖线（相对 44px 基准居中缩进）
            marginRight: (44 - size) / 2,
            background: a.hue ?? 'var(--button-primary-bg)',
            color: '#fff',
            opacity: isGroup && expanded ? 0.85 : 1,
            boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
          }}>
          <Icon size={opts.child ? 16 : 18} />
        </span>
      </motion.button>
    );
  };

  // 展开分组时，把子项行插到分组行之后（同一竖列，layout 动画让其余行平滑让位）
  const rows: Array<{ action: PaletteAction; child?: boolean }> = [];
  actions.forEach((a) => {
    rows.push({ action: a });
    if (a.children?.length && expandedGroup === a.key) {
      a.children.forEach(c => rows.push({ action: c, child: true }));
    }
  });

  const fab = (
    <>
      {/* 展开时的暗色蒙层：点空白收起 */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[58]"
            style={{ background: 'rgba(0,0,0,0.38)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setOpen(false)}
          />
        )}
      </AnimatePresence>

      <div className="fixed z-[60]" style={{ bottom, right }}>
        {/* 竖排动作菜单：固定行距，永不遮挡；超长时列内滚动 */}
        <AnimatePresence>
          {open && (
            <motion.div
              className="absolute flex flex-col items-end gap-2.5"
              style={{
                bottom: 68,
                right: 6,
                maxHeight: 'calc(100vh - 200px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                // 图标阴影不被滚动容器裁掉
                padding: '8px 2px 2px 8px',
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
            >
              <AnimatePresence mode="popLayout">
                {rows.map((r, i) => renderRow(r.action, { child: r.child, index: i }))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 主按钮：展开时「+」旋转 45 度变关闭 */}
        <motion.button
          data-tour-id="doc-create-fab"
          aria-label={open ? '收起新增菜单；双击开始录音' : '新增内容；双击开始录音'}
          title="单击新增内容，双击直接录音"
          className="relative flex h-14 w-14 cursor-pointer items-center justify-center rounded-full"
          style={{
            background: 'var(--button-primary-bg)',
            color: 'var(--button-primary-fg)',
            boxShadow: 'var(--button-primary-shadow)',
            touchAction: 'manipulation',
          }}
          whileTap={{ scale: 0.92 }}
          onClick={handleMainActivation}
        >
          <motion.span
            className="flex items-center justify-center"
            animate={{ rotate: open ? 45 : 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 22 }}>
            <Plus size={26} strokeWidth={2.4} />
          </motion.span>
        </motion.button>
      </div>
    </>
  );

  return createPortal(fab, document.body);
}
