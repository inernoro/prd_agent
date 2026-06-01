import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronsRight, ChevronsLeft, GripVertical, UploadCloud, Check, Copy, RotateCcw, Lock, Link2 } from 'lucide-react';
import { DOCK_EVENTS, type DockStartDetail, type DockDropDetail } from './useDockDrag';
import { MapSpinner } from '@/components/ui/VideoLoader';
import './ShareDock.css';

export type DockSlotTone = 'sky' | 'violet' | 'rose' | 'emerald' | 'amber' | 'indigo';

/** 拖拽进行中按被拖对象动态覆盖槽位外观/落点（"读心"）。返回字段缺省则沿用静态配置。 */
export interface DockSlotOverride {
  label?: string;
  icon?: React.ReactNode;
  hint?: string;
  tone?: DockSlotTone;
  onDrop?: (id: string) => void;
}

export interface ShareDockSlot {
  key: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  /** 主题色，决定 hover 时的光晕 */
  tone: DockSlotTone;
  /** 落点处理：收到被拖过来的对象 ID */
  onDrop: (id: string) => void;
  /** 拖拽中按被拖对象 id 动态"读心"覆盖本槽（如已分享→取消分享）。
   *  返回 null = 用静态配置；仅在拖拽进行时调用。 */
  resolve?: (draggedId: string) => DockSlotOverride | null;
}

/** 上传成功后 dock 内联展示的分享结果（让用户一步拿到分享码） */
export interface ShareDockUploadResult {
  /** 成功提示标题，默认"上传成功" */
  title?: string;
  /** 分享链接（相对路径或完整 URL，dock 原样展示 + 一键复制） */
  shareUrl?: string;
  /** 访问密码（可选，单独展示一行） */
  password?: string;
}

/** onFiles 上传成功后的产物：
 * - 含 createShare → dock 进入"二选一"（无密码 / 有密码分享），用户点选后才创建分享
 * - 仅含 shareUrl/title（无 createShare）→ 兼容旧的一步式直显结果 */
export interface ShareDockUploadOutcome extends ShareDockUploadResult {
  /** 由用户在 dock 内二选一触发创建分享，返回最终分享结果（含链接/密码）。
   *  reject 时 dock 回到二选一态并提示错误。 */
  createShare?: (mode: 'none' | 'password') => Promise<ShareDockUploadResult>;
}

export interface ShareDockDropzone {
  /** 提示文案，默认"拖文件到此上传" */
  hint?: string;
  /** 接受的扩展名列表（点开头），既用于显示也用于点击上传时的 input accept */
  accept?: string[];
  /** 接收到文件（拖入或点击选择）后回调。
   * - 返回 Promise<ShareDockUploadOutcome>：dock 走「上传中 → 二选一分享 → 展示分享码」流程
   * - 返回 void：维持旧行为（仅把文件交给外部处理，如打开弹窗） */
  onFiles: (files: File[]) => Promise<ShareDockUploadOutcome | void> | void;
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
const DOCK_W_COMPACT = 236; // 配合 dropzone + 横排槽位时稍宽，方形上传区适中不夸张
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
  const [draggingId, setDraggingId] = useState<string | null>(null); // 当前被拖对象 id（供槽位 resolve 读心）
  const [movingDock, setMovingDock] = useState(false);   // 正在拖 Dock 自己
  const [fileOver, setFileOver] = useState(false);       // 外部文件拖入 dropzone
  const dockRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);   // 点击上传用的隐藏 input

  // dropzone 上传状态机：idle（待上传）→ uploading（上传中）→ choosing（二选一分享）
  //                      → sharing（创建分享中）→ done（展示分享码）
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'choosing' | 'sharing' | 'done'>('idle');
  const [uploadResult, setUploadResult] = useState<ShareDockUploadResult | null>(null);
  const [resultCopied, setResultCopied] = useState(false);
  // 上传成功后待用户二选一的分享创建器（choosing 态使用）
  const [pendingShare, setPendingShare] = useState<{ title?: string; createShare: (mode: 'none' | 'password') => Promise<ShareDockUploadResult> } | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string) => {
    try {
      navigator.clipboard.writeText(text);
      setResultCopied(true);
      window.setTimeout(() => setResultCopied(false), 2000);
    } catch { /* 剪贴板不可用时静默，用户仍可手动复制 */ }
  }, []);

  // 统一处理「拖入 / 点击选择」拿到的文件：
  // onFiles 返回 Promise 时走「上传 → 二选一分享」，返回 void 时维持旧行为
  const handleDropzoneFiles = useCallback(
    (files: File[]) => {
      if (!dropzone || files.length === 0) return;
      const ret = dropzone.onFiles(files);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        setUploadState('uploading');
        setUploadResult(null);
        setPendingShare(null);
        setShareError(null);
        (ret as Promise<ShareDockUploadOutcome | void>)
          .then((outcome) => {
            if (outcome && outcome.createShare) {
              // 上传成功 → 进入二选一，由用户点选分享方式后才真正创建分享
              setPendingShare({ title: outcome.title, createShare: outcome.createShare });
              setUploadState('choosing');
            } else if (outcome && (outcome.shareUrl || outcome.title)) {
              // 兼容旧一步式：onFiles 直接返回了分享结果
              setUploadResult(outcome);
              setUploadState('done');
              if (outcome.shareUrl) copyToClipboard(outcome.shareUrl);
            } else {
              setUploadState('idle');
            }
          })
          .catch(() => setUploadState('idle'));
      }
      // void：外部自行处理（如打开弹窗），dock 维持 idle
    },
    [dropzone, copyToClipboard],
  );

  // 用户在二选一里点了「无密码 / 有密码」→ 创建分享，成功后展示链接 + 自动复制
  const chooseShare = useCallback(async (mode: 'none' | 'password') => {
    if (!pendingShare) return;
    setUploadState('sharing');
    setShareError(null);
    try {
      const result = await pendingShare.createShare(mode);
      setUploadResult(result);
      setUploadState('done');
      if (result.shareUrl) copyToClipboard(result.shareUrl);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : '分享创建失败，请重试');
      setUploadState('choosing');
    }
  }, [pendingShare, copyToClipboard]);

  const resetUpload = useCallback(() => {
    setUploadState('idle');
    setUploadResult(null);
    setResultCopied(false);
    setPendingShare(null);
    setShareError(null);
  }, []);

  const copyResult = useCallback(() => {
    if (uploadResult?.shareUrl) copyToClipboard(uploadResult.shareUrl);
  }, [uploadResult, copyToClipboard]);

  // 监听拖拽生命周期，激活 Dock
  useEffect(() => {
    const onStart = (e: Event) => {
      const ev = e as CustomEvent<DockStartDetail>;
      if (ev.detail?.mime === mime) { setDragging(true); setDraggingId(ev.detail.id); }
    };
    const onEnd = (e: Event) => {
      const ev = e as CustomEvent<DockStartDetail>;
      if (ev.detail?.mime === mime) { setDragging(false); setDraggingId(null); }
    };
    const onDrop = (e: Event) => {
      const ev = e as CustomEvent<DockDropDetail>;
      if (ev.detail?.mime !== mime) return;
      const slot = slots.find((s) => s.key === ev.detail.slotKey);
      if (!slot) return;
      // 落点行为也走"读心"：已分享对象落到分享槽时执行取消分享而非再次分享
      const ov = slot.resolve ? slot.resolve(ev.detail.id) : null;
      (ov?.onDrop ?? slot.onDrop)(ev.detail.id);
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
      data-tour-id="share-dock-panel"
      className="fixed z-40 select-none"
      style={{ left: pos.left, top: pos.top, width: dockW }}
    >
      <div
        className={[
          'w-full overflow-hidden rounded-2xl border border-white/12',
          // 底色加实（/85），不再太透；保留 blur 让悬浮在内容上时仍有层次
          'bg-[#16181c]/90 backdrop-blur-xl shadow-2xl shadow-black/50 transition-all duration-200',
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

        {/* 文件 dropzone：1:1 方形大区域，支持「拖入 / 点击」两种上传，
            上传成功后内联展示分享码，用户一步拿到分享链接 */}
        {dropzone && (
          <div className="mx-2 mt-2 flex justify-center">
            {/* 点击上传用的隐藏 input */}
            <input
              ref={fileInputRef}
              type="file"
              data-no-drag
              className="hidden"
              accept={dropzone.accept && dropzone.accept.length > 0 ? dropzone.accept.join(',') : undefined}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = ''; // 重置以便能再次选同一个文件
                if (files.length) handleDropzoneFiles(files);
              }}
            />

            <div
              data-no-drag
              data-tour-id="webpages-dropzone"
              role={uploadState === 'idle' ? 'button' : undefined}
              tabIndex={uploadState === 'idle' ? 0 : undefined}
              aria-label={uploadState === 'idle' ? '点击或拖文件到此上传' : undefined}
              className={[
                'flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed p-2.5 text-center transition-all',
                uploadState === 'idle' ? 'cursor-pointer' : 'cursor-default',
                fileOver
                  ? 'border-sky-300/80 bg-sky-500/15 text-sky-50'
                  : (uploadState === 'done' || uploadState === 'choosing')
                    ? 'border-emerald-300/50 bg-emerald-500/10 text-emerald-50'
                    : 'border-white/15 bg-white/[0.03] text-white/70 hover:bg-white/[0.06]',
              ].join(' ')}
              // 1:1 方形并在面板内水平居中：maxWidth 限定方形尺寸（外层 flex justify-center 负责居中）；
              // 内容多时（done 态）可自然超过正方形高度
              style={{ width: '100%', maxWidth: 188, aspectRatio: '1 / 1' }}
              onClick={() => { if (uploadState === 'idle') fileInputRef.current?.click(); }}
              onKeyDown={(e) => {
                if (uploadState === 'idle' && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                if (uploadState !== 'idle') return;
                // 仅响应 OS 文件拖入；内部卡片拖拽走 Pointer Events，不会触发这里
                if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (!fileOver) setFileOver(true);
              }}
              onDragLeave={(e) => {
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
                if (uploadState !== 'idle') return;
                if (!Array.from(e.dataTransfer.types).includes('Files')) return;
                e.preventDefault();
                setFileOver(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length) handleDropzoneFiles(files);
              }}
            >
              {uploadState === 'uploading' ? (
                <>
                  <MapSpinner size={28} />
                  <div className="text-[12px] font-medium">正在上传…</div>
                </>
              ) : uploadState === 'sharing' ? (
                <>
                  <MapSpinner size={28} />
                  <div className="text-[12px] font-medium">正在创建分享…</div>
                </>
              ) : uploadState === 'choosing' ? (
                <>
                  <div className="flex items-center gap-1.5 text-emerald-200">
                    <Check size={18} />
                    <span className="text-[12.5px] font-semibold">{pendingShare?.title ?? '上传成功'}</span>
                  </div>
                  <div className="text-[10.5px] text-white/55">选择分享方式</div>
                  <div className="flex w-full flex-col gap-1.5">
                    <button
                      data-no-drag
                      onClick={(e) => { e.stopPropagation(); chooseShare('none'); }}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-sky-300/40 bg-sky-500/15 px-2 py-1.5 text-[12px] font-medium text-sky-50 transition-colors hover:bg-sky-500/25"
                    >
                      <Link2 size={13} /> 无密码分享
                    </button>
                    <button
                      data-no-drag
                      onClick={(e) => { e.stopPropagation(); chooseShare('password'); }}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-500/15 px-2 py-1.5 text-[12px] font-medium text-amber-50 transition-colors hover:bg-amber-500/25"
                    >
                      <Lock size={13} /> 有密码分享
                    </button>
                  </div>
                  {shareError && <div className="text-[10px] text-rose-300">{shareError}</div>}
                  <button
                    data-no-drag
                    onClick={(e) => { e.stopPropagation(); resetUpload(); }}
                    className="mt-0.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/55 hover:bg-white/10 hover:text-white"
                  >
                    <RotateCcw size={12} /> 再传一个
                  </button>
                </>
              ) : uploadState === 'done' && uploadResult ? (
                <>
                  <div className="flex items-center gap-1.5 text-emerald-200">
                    <Check size={18} />
                    <span className="text-[12.5px] font-semibold">{uploadResult.title ?? '上传成功'}</span>
                  </div>
                  {uploadResult.shareUrl && (
                    <>
                      <div className="text-[10px] text-emerald-100/70">分享链接已复制到剪贴板</div>
                      <div className="flex w-full items-center gap-1">
                        <input
                          data-no-drag
                          type="text"
                          readOnly
                          value={uploadResult.shareUrl}
                          onClick={(e) => (e.target as HTMLInputElement).select()}
                          className="min-w-0 flex-1 truncate rounded-md border border-white/15 bg-black/30 px-2 py-1 text-[11px] text-white/90 outline-none"
                        />
                        <button
                          data-no-drag
                          onClick={(e) => { e.stopPropagation(); copyResult(); }}
                          className="shrink-0 rounded-md border border-white/15 bg-white/5 p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
                          title="复制链接"
                          aria-label="复制分享链接"
                        >
                          {resultCopied ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
                        </button>
                      </div>
                    </>
                  )}
                  {uploadResult.password && (
                    <div className="text-[10.5px] text-white/70">
                      访问密码 <code className="font-mono font-semibold text-white">{uploadResult.password}</code>
                    </div>
                  )}
                  <button
                    data-no-drag
                    onClick={(e) => { e.stopPropagation(); resetUpload(); }}
                    className="mt-0.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    <RotateCcw size={12} /> 再传一个
                  </button>
                </>
              ) : (
                <>
                  <UploadCloud size={24} className="opacity-80" />
                  <div className="text-[12px] font-medium leading-tight">
                    {dropzone.hint ?? '拖文件到此上传'}
                  </div>
                  <div className="text-[10px] leading-tight text-white/50">
                    点击选择，或拖文件到此
                  </div>
                  {dropzone.accept && dropzone.accept.length > 0 && (
                    <div className="text-[9.5px] leading-tight text-white/40">
                      {dropzone.accept.join(' / ')}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 槽位区 */}
        <div
          className={[
            horizontalSlots ? 'grid grid-cols-3 gap-1.5 p-2' : 'flex flex-col gap-2 p-2',
            dragging ? 'dock-active' : '',
          ].join(' ')}
        >
          {slots.map((s) => {
            // 拖拽中按被拖对象"读心"：已分享对象 → 分享槽显示"取消分享"等
            const ov = (draggingId && s.resolve) ? s.resolve(draggingId) : null;
            const label = ov?.label ?? s.label;
            const icon = ov?.icon ?? s.icon;
            const hint = ov?.hint ?? s.hint;
            const tone = ov?.tone ?? s.tone;
            return (
              <div
                key={s.key}
                data-dock-slot={s.key}
                data-dock-mime={mime}
                className={[
                  'dock-slot',
                  `dock-slot--${tone}`,
                  horizontalSlots ? 'dock-slot--compact' : '',
                ].join(' ')}
                role="button"
                aria-label={`拖到此处以${label}`}
                title={hint}
              >
                {horizontalSlots ? (
                  <div className="flex flex-col items-center gap-1 py-1">
                    <span className="text-current">{icon}</span>
                    <span className="text-[11px] font-medium leading-none">{label}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      {icon}
                      <span className="text-sm font-medium">{label}</span>
                    </div>
                    <div className="dock-slot__hint mt-0.5 text-[10.5px] leading-snug text-white/55">
                      {hint}
                    </div>
                  </>
                )}
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
