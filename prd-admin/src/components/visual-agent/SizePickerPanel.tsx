import { ASPECT_OPTIONS, detectTierFromSize, detectAspectFromSize } from '@/lib/imageAspectOptions';
import { useEffect, useRef, useState } from 'react';

type SizePickerPanelProps = {
  /** 当前尺寸字符串，如 "1024x1024" */
  size: string;
  /** 尺寸变化回调 */
  onSizeChange: (size: string) => void;
  /** 面板宽度，默认 260 */
  width?: number;
};

/**
 * 尺寸选择面板（分辨率 + 比例网格），可复用于编辑器和首页。
 * 弹出层定位由调用方控制（absolute/popover），此组件仅渲染面板内容。
 */
export function SizePickerPanel({ size, onSizeChange, width = 260 }: SizePickerPanelProps) {
  const currentTier = detectTierFromSize(size) ?? '1k';
  const currentAspect = detectAspectFromSize(size) ?? '1:1';

  return (
    <div
      className="rounded-[14px] p-3"
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
        {(['1k', '2k', '4k'] as const).map((tier) => {
          const isSelected = currentTier === tier;
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
        {ASPECT_OPTIONS.map((opt) => {
          const sizeStr = currentTier === '1k' ? opt.size1k : currentTier === '2k' ? opt.size2k : opt.size4k;
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
 * 集成了 popover 定位和点击外部关闭逻辑。
 */
export function SizePickerButton({ size, onSizeChange }: { size: string; onSizeChange: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const tier = detectTierFromSize(size) ?? '1k';
  const aspect = detectAspectFromSize(size) ?? '1:1';
  const tierLabel = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-[13px] font-medium transition-all duration-200 hover:bg-white/8"
        style={{
          background: open ? 'rgba(99, 102, 241, 0.18)' : 'rgba(99, 102, 241, 0.1)',
          color: open ? 'rgba(199, 210, 254, 0.85)' : 'rgba(199, 210, 254, 0.55)',
          border: open ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid rgba(99, 102, 241, 0.15)',
        }}
        title="选择分辨率和尺寸比例"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{tierLabel} · {aspect}</span>
        <span className="text-[9px]" style={{ color: 'rgba(255,255,255,0.45)' }}>▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-50">
          <SizePickerPanel
            size={size}
            onSizeChange={(s) => {
              onSizeChange(s);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
