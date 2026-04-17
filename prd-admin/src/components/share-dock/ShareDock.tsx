import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronsRight, ChevronsLeft, GripVertical } from 'lucide-react';
import { DOCK_EVENTS, type DockStartDetail, type DockDropDetail } from './useDockDrag';

export interface ShareDockSlot {
  key: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** 主题色，决定 hover 时的光晕 */
  tone: 'sky' | 'violet' | 'rose' | 'emerald' | 'amber' | 'indigo';
  /** 落点处理：收到被拖过来的对象 ID */
  onDrop: (id: string) => void;
}

export interface ShareDockProps {
  /** 自定义 MIME，与可拖卡片的 useDockDrag({ mime }) 保持一致 */
  mime: string;
  /** 槽位配置，数量建议 2-5 个 */
  slots: ShareDockSlot[];
  /** 头部标题（默认"投放面板"） */
  title?: string;
  /** 头部右上徽章数字（0 不显示） */
  badgeCount?: number;
  /** 徽章右侧的"查看公开页"链接（可选） */
  footerHref?: string;
  /** 底部链接文案 */
  footerText?: string;
  /** 持久化 key，用于记忆位置/折叠态，不同页面传不同 key */
  persistKey?: string;
  /** 默认吸附位置，未持久化时使用 */
  defaultAnchor?: 'right' | 'right-middle';
}

/**
 * 每个 tone 包含基础色 + data-dock-hover=true 时的 ring/scale/色阶加强。
 * 使用 Tailwind 的 data-[attr=val]: 变体，必须写完整字面量，不能动态拼接（JIT 扫描不到）。
 */
const TONE_STYLES: Record<ShareDockSlot['tone'], string> = {
  sky:
    'from-sky-500/15 to-cyan-400/5 border-sky-400/25 text-sky-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-sky-300/70 ' +
    'data-[dock-hover=true]:from-sky-500/35 data-[dock-hover=true]:to-cyan-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
  violet:
    'from-violet-500/15 to-purple-400/5 border-violet-400/25 text-violet-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-violet-300/70 ' +
    'data-[dock-hover=true]:from-violet-500/35 data-[dock-hover=true]:to-purple-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
  rose:
    'from-rose-500/15 to-red-400/5 border-rose-400/25 text-rose-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-rose-300/70 ' +
    'data-[dock-hover=true]:from-rose-500/35 data-[dock-hover=true]:to-red-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
  emerald:
    'from-emerald-500/15 to-green-400/5 border-emerald-400/25 text-emerald-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-emerald-300/70 ' +
    'data-[dock-hover=true]:from-emerald-500/35 data-[dock-hover=true]:to-green-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
  amber:
    'from-amber-500/15 to-orange-400/5 border-amber-400/25 text-amber-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-amber-300/70 ' +
    'data-[dock-hover=true]:from-amber-500/35 data-[dock-hover=true]:to-orange-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
  indigo:
    'from-indigo-500/15 to-blue-400/5 border-indigo-400/25 text-indigo-100 ' +
    'data-[dock-hover=true]:ring-2 data-[dock-hover=true]:ring-indigo-300/70 ' +
    'data-[dock-hover=true]:from-indigo-500/35 data-[dock-hover=true]:to-blue-400/20 ' +
    'data-[dock-hover=true]:scale-[1.04]',
};

const DOCK_W = 192;
const DOCK_MARGIN = 16;

/**
 * 通用投放面板（ShareDock）。
 *
 * 视觉：固定悬浮窗，默认右侧中部。用户可拖动头部改变位置，可收起成 36px 竖条。
 * 交互：拖拽配对用 useDockDrag hook（Pointer Events 方案，跟手 + 支持触屏）。
 */
export function ShareDock({
  mime,
  slots,
  title = '投放面板',
  badgeCount = 0,
  footerHref,
  footerText,
  persistKey,
  defaultAnchor = 'right-middle',
}: ShareDockProps) {
  const storageKey = persistKey ? `share-dock:${persistKey}` : null;

  const getDefaultPos = useCallback((): { left: number; top: number } => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const h = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = w - DOCK_W - DOCK_MARGIN;
    const top =
      defaultAnchor === 'right-middle'
        ? Math.max(80, Math.round(h / 2 - 160))
        : 96;
    return { left, top };
  }, [defaultAnchor]);

  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    if (!storageKey) return getDefaultPos();
    try {
      const saved = sessionStorage.getItem(storageKey + ':pos');
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p?.left === 'number' && typeof p?.top === 'number') return p;
      }
    } catch { /* ignore */ }
    return getDefaultPos();
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!storageKey) return false;
    return sessionStorage.getItem(storageKey + ':collapsed') === '1';
  });

  const [dragging, setDragging] = useState(false);       // 被拖对象拖入状态
  const [movingDock, setMovingDock] = useState(false);   // 正在拖 Dock 自己
  const dockRef = useRef<HTMLDivElement>(null);

  // 监听拖拽生命周期，激活 Dock
  useEffect(() => {
    const onStart = (e: Event) => {
      const ev = e as CustomEvent<DockStartDetail>;
      if (ev.detail?.mime === mime) setDragging(true);
    };
    const onEnd = (e: Event) => {
      const ev = e as CustomEvent<DockStartDetail>;
      if (ev.detail?.mime === mime) setDragging(false);
    };
    const onDrop = (e: Event) => {
      const ev = e as CustomEvent<DockDropDetail>;
      if (ev.detail?.mime !== mime) return;
      const slot = slots.find((s) => s.key === ev.detail.slotKey);
      if (slot) slot.onDrop(ev.detail.id);
    };
    window.addEventListener(DOCK_EVENTS.START, onStart);
    window.addEventListener(DOCK_EVENTS.END, onEnd);
    window.addEventListener(DOCK_EVENTS.DROP, onDrop);
    return () => {
      window.removeEventListener(DOCK_EVENTS.START, onStart);
      window.removeEventListener(DOCK_EVENTS.END, onEnd);
      window.removeEventListener(DOCK_EVENTS.DROP, onDrop);
    };
  }, [mime, slots]);

  // 窗口变化时把 Dock 约束回可视区域
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampPos(p, collapsed));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed]);

  // 拖动 Dock 自身（头部作为 handle）
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button,[data-no-drag]')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseLeft = pos.left;
    const baseTop = pos.top;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setMovingDock(true);

    const onMove = (ev: PointerEvent) => {
      const next = clampPos(
        { left: baseLeft + ev.clientX - startX, top: baseTop + ev.clientY - startY },
        collapsed,
      );
      setPos(next);
    };
    const onUp = (ev: PointerEvent) => {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setMovingDock(false);
      setPos((p) => {
        if (storageKey) {
          try { sessionStorage.setItem(storageKey + ':pos', JSON.stringify(p)); } catch { /* ignore */ }
        }
        return p;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      if (storageKey) {
        try { sessionStorage.setItem(storageKey + ':collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      }
      return next;
    });
  };

  // 收起态：只显示一个竖条
  if (collapsed) {
    return (
      <div
        ref={dockRef}
        className="fixed z-40 select-none"
        style={{ left: pos.left + DOCK_W - 36, top: pos.top }}
      >
        <button
          onClick={toggleCollapsed}
          className={[
            'flex flex-col items-center gap-2 rounded-l-2xl border border-r-0 border-white/15',
            'bg-black/40 backdrop-blur-xl px-2 py-3 shadow-2xl shadow-black/40',
            'text-white/75 hover:text-white hover:bg-black/50 transition-all',
            dragging ? 'ring-2 ring-sky-300/70 bg-black/55' : '',
          ].join(' ')}
          aria-label="展开投放面板"
        >
          <ChevronsLeft size={14} />
          <span
            className="text-[10px] tracking-wider"
            style={{ writingMode: 'vertical-rl' }}
          >
            {title}
          </span>
          {badgeCount > 0 && (
            <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-sky-500/40 px-1 py-0.5 text-[9px] font-semibold text-sky-50">
              {badgeCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={dockRef}
      className="fixed z-40 select-none"
      style={{ left: pos.left, top: pos.top, width: DOCK_W }}
    >
      <div
        className={[
          'w-full overflow-hidden rounded-2xl border border-white/15',
          'bg-black/30 backdrop-blur-xl shadow-2xl shadow-black/40 transition-all duration-200',
          dragging ? 'scale-[1.03] border-white/30 shadow-[0_0_32px_rgba(56,189,248,0.3)]' : '',
          movingDock ? 'opacity-85' : '',
        ].join(' ')}
      >
        {/* 头部（拖拽手柄） */}
        <div
          onPointerDown={onHandlePointerDown}
          className={[
            'flex items-center justify-between gap-1 border-b border-white/10 bg-white/5 px-2 py-2 text-[11px]',
            movingDock ? 'cursor-grabbing' : 'cursor-grab',
          ].join(' ')}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-white/80">
            <GripVertical size={12} className="shrink-0 text-white/40" />
            <span className="truncate font-medium tracking-wide">{title}</span>
          </span>
          <div className="flex items-center gap-1">
            {badgeCount > 0 && (
              <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-sky-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-sky-100">
                {badgeCount}
              </span>
            )}
            <button
              data-no-drag
              onClick={toggleCollapsed}
              className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
              aria-label="收起投放面板"
              title="收起"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        </div>

        {/* 槽位区 */}
        <div className="flex flex-col gap-2 p-2">
          {slots.map((s) => {
            return (
              <div
                key={s.key}
                data-dock-slot={s.key}
                data-dock-mime={mime}
                className={[
                  'rounded-xl border bg-gradient-to-br px-3 py-2 transition-all',
                  TONE_STYLES[s.tone],
                  dragging ? 'opacity-95' : 'opacity-90',
                ].join(' ')}
                role="button"
                aria-label={`拖到此处以${s.label}`}
              >
                <div className="flex items-center gap-2">
                  {s.icon}
                  <span className="text-sm font-medium">{s.label}</span>
                </div>
                <div className="mt-0.5 text-[10.5px] leading-snug text-white/55">{s.hint}</div>
              </div>
            );
          })}
        </div>

        {/* 底部链接 */}
        {footerText && (
          <div className="border-t border-white/10 bg-black/20 px-3 py-2 text-[10.5px]">
            {footerHref ? (
              <a
                data-no-drag
                href={footerHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-white/70 transition-colors hover:text-white"
              >
                {footerText}
              </a>
            ) : (
              <span className="text-white/40">{footerText}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function clampPos(p: { left: number; top: number }, collapsed: boolean) {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  const dockW = collapsed ? 36 : DOCK_W;
  const minVisible = 40;
  return {
    left: Math.max(-dockW + minVisible, Math.min(p.left, w - minVisible)),
    top: Math.max(8, Math.min(p.top, h - minVisible)),
  };
}
