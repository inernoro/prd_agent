import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useIsMobile } from '@/hooks/useBreakpoint';

/**
 * 库内唯一「新增」入口：右下角悬浮「+」，点击后调色盘式扇形展开动作项。
 * 设计依据（用户 2026-07-10 确认）：
 * - 新增入口只有一个，用户心智 = 「想加东西就点右下角」；
 * - 展开像调色盘：动作沿左上四分之一圆弧散开，带文字标签，点空白/ESC 收起；
 * - 取代原侧栏小「+」菜单与顶栏「上传文档」按钮（两处已下线）。
 */
export type PaletteAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** 可选强调色（图标底色），默认走 accent 蓝 */
  hue?: string;
};

export function CreatePaletteFab({ actions }: { actions: PaletteAction[] }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (actions.length === 0) return null;

  // 手机端悬浮在底部 TabBar 之上；桌面端贴右下角
  const bottom = isMobile
    ? 'calc(env(safe-area-inset-bottom, 0px) + var(--mobile-tab-height, 56px) + 16px)'
    : '24px';
  const right = isMobile ? '16px' : '24px';
  const radius = isMobile ? 118 : 148;
  const n = actions.length;

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
        {/* 调色盘动作项：沿左上四分之一圆弧展开（0=正上方 → n-1=正左方） */}
        <AnimatePresence>
          {open && actions.map((a, i) => {
            const angle = n === 1 ? Math.PI / 4 : (Math.PI / 2) * (i / (n - 1));
            const dx = -radius * Math.sin(angle);
            const dy = -radius * Math.cos(angle);
            const Icon = a.icon;
            return (
              <motion.button
                key={a.key}
                className="absolute flex cursor-pointer items-center gap-2"
                style={{ right: 4, bottom: 4, transformOrigin: 'center' }}
                initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
                animate={{ x: dx, y: dy, opacity: 1, scale: 1 }}
                exit={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
                transition={{ type: 'spring', stiffness: 420, damping: 26, delay: i * 0.03 }}
                onClick={() => { setOpen(false); a.onClick(); }}
              >
                <span
                  className="whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold"
                  style={{
                    background: 'var(--bg-card, rgba(20,20,24,0.92))',
                    border: '1px solid var(--border-faint)',
                    color: 'var(--text-primary)',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
                  }}>
                  {a.label}
                </span>
                <span
                  className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: a.hue ?? 'rgba(59,130,246,0.92)',
                    color: '#fff',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                  }}>
                  <Icon size={18} />
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>

        {/* 主按钮：展开时「+」旋转 45 度变关闭 */}
        <motion.button
          data-tour-id="doc-create-fab"
          aria-label={open ? '收起新增菜单' : '新增内容'}
          title="新增：写文章 / 录音转笔记 / 上传文件…"
          className="relative flex h-14 w-14 cursor-pointer items-center justify-center rounded-full"
          style={{
            background: 'linear-gradient(135deg, rgba(59,130,246,0.95), rgba(99,102,241,0.95))',
            color: '#fff',
            boxShadow: '0 8px 24px rgba(59,130,246,0.45)',
          }}
          whileTap={{ scale: 0.92 }}
          onClick={() => setOpen(v => !v)}
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
