import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ChevronsRight, ChevronsLeft, GripVertical, UploadCloud } from 'lucide-react';
import { DOCK_EVENTS, type DockStartDetail, type DockDropDetail } from './useDockDrag';
import { LiquidGlassSurface } from '../effects/LiquidGlassSurface';
import './ShareDock.css';

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

export interface ShareDockDropzone {
  /** 提示文案，默认"拖文件到此上传" */
  hint?: string;
  /** 接受的扩展名列表（点开头），仅用于显示的次要提示文案 */
  accept?: string[];
  /** 接收到外部文件时回调 */
  onFiles: (files: File[]) => void;
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
  /** 顶部"拖文件到此上传"区域，仅响应 OS 文件拖入，不影响内部卡片拖拽 */
  dropzone?: ShareDockDropzone;
  /** 槽位横向紧凑排列（默认纵向）。配合 dropzone 时面板更接近正方形 */
  compactSlots?: boolean;
}

/* 槽位 tone → CSS class（具体样式见 ShareDock.css），这里只做字面量映射
 * 使用普通 CSS class 而不是 Tailwind 字面量，避免 JIT 扫描不到的坑，
 * 也让 hover 效果能组合多层 box-shadow + 发光。 */

const DOCK_W_DEFAULT = 192;
const DOCK_W_COMPACT = 232; // 配合 dropzone + 横排槽位时稍宽，整体接近正方形
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
  dropzone,
  compactSlots,
}: ShareDockProps) {
  const storageKey = persistKey ? `share-dock:${persistKey}` : null;
  // 有 dropzone 或显式 compactSlots 时使用较宽的方形布局
  const dockW = (compactSlots || dropzone) ? DOCK_W_COMPACT : DOCK_W_DEFAULT;
  const horizontalSlots = compactSlots || !!dropzone;

  const getDefaultPos = useCallback((): { left: number; top: number } => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const h = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = w - dockW - DOCK_MARGIN;
    const top =
      defaultAnchor === 'right-middle'
        ? Math.max(80, Math.round(h / 2 - 160))
        : 96;
    return { left, top };
  }, [defaultAnchor, dockW]);

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
  const [fileOver, setFileOver] = useState(false);       // 外部文件拖入 dropzone
  const dockRef = useRef<HTMLDivElement>(null);

  // 真液态玻璃:Reduce Motion 用户关掉 blob 漂移(canvas 仍然渲染,只是静止)
  const liquidAnimated = useMemo(() => {
    if (typeof window === 'undefined') return true;
    return !(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  }, []);

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
      setPos((p) => clampPos(p, collapsed, dockW));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed, dockW]);

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
        dockW,
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
        style={{ left: pos.left + dockW - 36, top: pos.top }}
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
      style={{ left: pos.left, top: pos.top, width: dockW }}
    >
      <div
        className={[
          'relative w-full overflow-hidden rounded-2xl border border-white/15',
          // 底色仅作为 WebGL canvas 渲染失败时的兜底（深色基底）;
          // 真液态玻璃（LiquidGlassSurface）叠在底色上面渲染真折射。
          'bg-black/40 shadow-2xl shadow-black/40 transition-all duration-200',
          dragging ? 'scale-[1.03] border-white/30 shadow-[0_0_32px_rgba(56,189,248,0.3)]' : '',
          movingDock ? 'opacity-85' : '',
        ].join(' ')}
      >
        {/* 真液态大玻璃背板:WebGL MeshTransmissionMaterial 真折射,替代之前的 backdrop-blur 假玻璃 */}
        <LiquidGlassSurface tone="cool" animated={liquidAnimated && !movingDock} />

        {/* 内容层:relative + z-[1] 确保盖在 canvas 之上 */}
        <div className="relative z-[1]">
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

        {/* 外部文件 dropzone（仅响应 OS 文件拖入，不影响内部卡片拖拽） */}
        {dropzone && (
          <div
            className={[
              'mx-2 mt-2 flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-2 py-3 text-center transition-all',
              fileOver
                ? 'border-sky-300/80 bg-sky-500/15 text-sky-50'
                : 'border-white/15 bg-white/[0.03] text-white/70 hover:bg-white/[0.05]',
            ].join(' ')}
            onDragOver={(e) => {
              // 仅响应 OS 文件拖入；内部卡片拖拽走 Pointer Events，不会触发这里
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!fileOver) setFileOver(true);
            }}
            onDragLeave={(e) => {
              // 离开本元素而非进入子元素时才熄灭
              const r = e.currentTarget.getBoundingClientRect();
              if (
                e.clientX < r.left ||
                e.clientX >= r.right ||
                e.clientY < r.top ||
                e.clientY >= r.bottom
              ) {
                setFileOver(false);
              }
            }}
            onDrop={(e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              setFileOver(false);
              const files = Array.from(e.dataTransfer.files);
              if (files.length) dropzone.onFiles(files);
            }}
          >
            <UploadCloud size={20} className="opacity-80" />
            <div className="text-[11.5px] font-medium leading-tight">
              {dropzone.hint ?? '拖文件到此上传'}
            </div>
            {dropzone.accept && dropzone.accept.length > 0 && (
              <div className="text-[10px] leading-tight text-white/45">
                {dropzone.accept.join(' / ')}
              </div>
            )}
          </div>
        )}

        {/* 槽位区 */}
        <div
          className={[
            horizontalSlots ? 'grid grid-cols-3 gap-1.5 p-2' : 'flex flex-col gap-2 p-2',
            dragging ? 'dock-active' : '',
          ].join(' ')}
        >
          {slots.map((s) => (
            <div
              key={s.key}
              data-dock-slot={s.key}
              data-dock-mime={mime}
              className={[
                'dock-slot',
                `dock-slot--${s.tone}`,
                horizontalSlots ? 'dock-slot--compact' : '',
              ].join(' ')}
              role="button"
              aria-label={`拖到此处以${s.label}`}
              title={s.hint}
            >
              {horizontalSlots ? (
                <div className="flex flex-col items-center gap-1 py-1">
                  <span className="text-current">{s.icon}</span>
                  <span className="text-[11px] font-medium leading-none">{s.label}</span>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    {s.icon}
                    <span className="text-sm font-medium">{s.label}</span>
                  </div>
                  <div className="dock-slot__hint mt-0.5 text-[10.5px] leading-snug text-white/55">
                    {s.hint}
                  </div>
                </>
              )}
            </div>
          ))}
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
    </div>
  );
}

function clampPos(p: { left: number; top: number }, collapsed: boolean, fullW: number) {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  const dockW = collapsed ? 36 : fullW;
  const minVisible = 40;
  return {
    left: Math.max(-dockW + minVisible, Math.min(p.left, w - minVisible)),
    top: Math.max(8, Math.min(p.top, h - minVisible)),
  };
}
