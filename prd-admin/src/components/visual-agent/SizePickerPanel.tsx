import { ASPECT_OPTIONS, detectTierFromSize, resolveAspectRatio } from '@/lib/imageAspectOptions';
import { flattenSizes, RESOLUTION_TIERS, type ResolutionTier, type SizesByResolution } from '@/lib/visualModelSizes';
import { RectangleHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type SizePickerPanelProps = {
  /** 当前尺寸字符串，如 "1024x1024" */
  size: string;
  /** 尺寸变化回调 */
  onSizeChange: (size: string) => void;
  /** 面板宽度，默认 260 */
  width?: number;
  /**
   * 当前模型支持的尺寸（adapter-info 返回）。给了就只显示这些档位和比例，
   * **拿不到就传 null**——退回静态表，而不是编一份「这个模型大概支持这些」。
   */
  availableSizes?: SizesByResolution | null;
};

/**
 * 尺寸选择面板（分辨率 + 比例网格），可复用于编辑器和首页。
 * 弹出层定位由调用方控制（absolute/popover），此组件仅渲染面板内容。
 */
export function SizePickerPanel({ size, onSizeChange, width = 260, availableSizes }: SizePickerPanelProps) {
  const currentTier = detectTierFromSize(size) ?? '1k';
  // 先认后端目录再退静态表：`1344x768` 这类不在静态表里的档位，
  // 直接判 null 会把当前比例当成 1:1，换档时把 16:9 悄悄改成方图。
  const currentAspect = resolveAspectRatio(size, availableSizes);

  // 模型给了尺寸清单就按它渲染：档位只留有内容的，比例只留该档真支持的。
  // 静态 ASPECT_OPTIONS 是所有模型的并集，直接摆出来等于让用户选一个会失败的组合。
  const model = availableSizes && flattenSizes(availableSizes).length > 0 ? availableSizes : null;
  const tiers = model
    ? RESOLUTION_TIERS.filter((t) => model[t].length > 0)
    : (['1k', '2k', '4k'] as const).filter(() => true);
  const tierForGrid: ResolutionTier = model && !model[currentTier as ResolutionTier]?.length
    ? (tiers[0] ?? '1k')
    : (currentTier as ResolutionTier);
  // 同一比例可能有多个尺寸，取第一个即可（编辑器那边也是这个口径）。
  const modelAspects = model
    ? (() => {
      const seen = new Map<string, string>();
      for (const opt of model[tierForGrid]) {
        const ratio = opt.aspectRatio || '1:1';
        if (!seen.has(ratio)) seen.set(ratio, opt.size);
      }
      return [...seen.entries()].map(([id, sizeStr]) => ({ id, sizeStr }));
    })()
    : null;

  return (
    <div
      className="surface-tone-dark rounded-[14px] p-3"
      style={{
        width,
        background: 'rgba(32, 32, 36, 0.96)',
        border: '1px solid rgba(255, 255, 255, 0.18)',
        boxShadow: '0 18px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255, 255, 255, 0.08) inset',
      }}
    >
      {/* 分辨率（档位） */}
      <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>分辨率</div>
      <div className="flex gap-1.5 mb-3">
        {tiers.map((tier) => {
          const isSelected = tierForGrid === tier;
          const label = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
          return (
            <button
              key={tier}
              type="button"
              className="h-7 flex-1 rounded-[8px] text-[12px] font-semibold transition-colors"
              style={{
                background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
              }}
              onClick={() => {
                if (model) {
                  // 换档时尽量保住当前比例；该档没有这个比例就退该档第一个。
                  const inTier = model[tier];
                  const keep = inTier.find((o) => (o.aspectRatio || '1:1') === currentAspect);
                  onSizeChange((keep ?? inTier[0])?.size ?? size);
                  return;
                }
                const targetOpt = ASPECT_OPTIONS.find((o) => o.id === currentAspect);
                if (targetOpt) {
                  const newSize = tier === '1k' ? targetOpt.size1k : tier === '2k' ? targetOpt.size2k : targetOpt.size4k;
                  onSizeChange(newSize);
                } else {
                  // 当前比例无匹配，fallback 到 1:1
                  const fallback = ASPECT_OPTIONS[0];
                  const newSize = tier === '1k' ? fallback.size1k : tier === '2k' ? fallback.size2k : fallback.size4k;
                  onSizeChange(newSize);
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* 比例 */}
      <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>Size</div>
      <div className="grid grid-cols-4 gap-1.5">
        {(modelAspects ?? ASPECT_OPTIONS.map((o) => ({
          id: o.id,
          sizeStr: tierForGrid === '1k' ? o.size1k : tierForGrid === '2k' ? o.size2k : o.size4k,
        }))).map((opt) => {
          const sizeStr = opt.sizeStr;
          const isSelected = opt.id === currentAspect;
          const [rw, rh] = opt.id.includes(':') ? opt.id.split(':').map(Number) : [1, 1];
          const aspectVal = rw && rh ? rw / rh : 1;
          const iconW = aspectVal >= 1 ? 24 : Math.round(24 * aspectVal);
          const iconH = aspectVal <= 1 ? 24 : Math.round(24 / aspectVal);
          return (
            <button
              key={opt.id}
              type="button"
              className="flex flex-col items-center justify-center gap-1 py-2 rounded-[8px] transition-colors"
              style={{
                background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
              }}
              onClick={() => onSizeChange(sizeStr)}
            >
              <div style={{ width: iconW, height: iconH, border: '1.5px solid currentColor', borderRadius: 3, opacity: 0.7 }} />
              <span className="text-[10px] font-medium">{opt.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 尺寸选择按钮 + 弹出面板，用于底部工具栏等场景。
 * 使用 Portal 渲染到 body，避免被父级 overflow:hidden 裁剪。
 */
export function SizePickerButton({ size, onSizeChange, availableSizes }: { size: string; onSizeChange: (s: string) => void; availableSizes?: SizesByResolution | null }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // 计算面板位置（按钮上方）
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setPos({ top: rect.top - 8, left: rect.left });
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const tier = detectTierFromSize(size) ?? '1k';
  // chip 上显示的比例同理——它和面板里高亮的那一格必须是同一个判断。
  const aspect = resolveAspectRatio(size, availableSizes);
  const tierLabel = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';

  return (
    <>
      {/*
        和同一条工具行上的「参考图」「模型」「反馈」同一档：透明底、36px 高、
        radius 7、10px 字。原来这里是一枚靛蓝药丸——那是这条行里唯一一个
        带色块的控件，也是整页唯一和品牌色无关的颜色，用户一眼就看出它是旧的。
        它并不比旁边两个更重要，不该是唯一被强调的那个。
      */}
      <button
        ref={btnRef}
        type="button"
        className="inline-flex items-center gap-1.5 hover-bg-soft transition-colors"
        style={{
          minHeight: 36,
          padding: '0 9px',
          borderRadius: 7,
          border: 0,
          background: open ? 'var(--bg-secondary)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontSize: 10,
          cursor: 'pointer',
        }}
        title="选择分辨率和尺寸比例"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <RectangleHorizontal size={13} className="shrink-0" />
        <span style={{ whiteSpace: 'nowrap' }}>{tierLabel} · {aspect}</span>
        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>▾</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translateY(-100%)',
            zIndex: 9999,
          }}
        >
          <SizePickerPanel
            availableSizes={availableSizes}
            size={size}
            onSizeChange={(s) => {
              onSizeChange(s);
              setOpen(false);
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
