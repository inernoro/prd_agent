import React, { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ASPECT_OPTIONS, detectTierFromSize, detectAspectFromSize } from '@/lib/imageAspectOptions';
import type { SizesByResolution } from '@/lib/imageAspectOptions';

type SizeOption = { size: string; aspectRatio: string };

/** 从 sizeToAspectMap 或 ASPECT_OPTIONS 检测比例，fallback '1:1' */
function resolveAspect(size: string, sizeToAspectMap: Map<string, string>): string {
  const mapped = sizeToAspectMap.get(size.toLowerCase());
  if (mapped) return mapped;
  return detectAspectFromSize(size) || '1:1';
}

interface ImageSizePickerProps {
  /** 按分辨率档位分组的尺寸选项 */
  sizesByResolution: SizesByResolution;
  /** 当前选中的尺寸（如 "1024x1024"） */
  value: string;
  /** 尺寸变更回调 */
  onChange: (size: string) => void;
  /** 禁用状态 */
  disabled?: boolean;
}

/**
 * 图片尺寸选择器（Popover）
 * 支持 1K/2K/4K 分辨率档位切换 + 4列比例网格
 * 从视觉创作工作台提取的共享组件
 */
export function ImageSizePicker({ sizesByResolution, value, onChange, disabled }: ImageSizePickerProps) {
  const [open, setOpen] = useState(false);

  // 按比例去重，每个比例保留一个尺寸
  const ratiosByResolution = useMemo(() => {
    const result: Record<'1k' | '2k' | '4k', Map<string, SizeOption>> = {
      '1k': new Map(),
      '2k': new Map(),
      '4k': new Map(),
    };
    for (const tier of ['1k', '2k', '4k'] as const) {
      for (const opt of sizesByResolution[tier]) {
        const ratio = opt.aspectRatio || 'unknown';
        if (!result[tier].has(ratio)) result[tier].set(ratio, opt);
      }
    }
    return result;
  }, [sizesByResolution]);

  // 尺寸→比例映射（后端数据优先，避免 GCD 计算偏差）
  const sizeToAspectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tier of ['1k', '2k', '4k'] as const) {
      for (const opt of sizesByResolution[tier]) {
        if (opt.size && opt.aspectRatio) {
          map.set(opt.size.toLowerCase(), opt.aspectRatio);
        }
      }
    }
    return map;
  }, [sizesByResolution]);

  const currentSize = value || '1024x1024';
  const currentTier = detectTierFromSize(currentSize) || '1k';
  const currentAspect = resolveAspect(currentSize, sizeToAspectMap);

  const availableTiers = (['1k', '2k', '4k'] as const).filter((t) => ratiosByResolution[t].size > 0);
  const effectiveTier = availableTiers.includes(currentTier) ? currentTier : (availableTiers[0] || '1k');
  const hasOptions = availableTiers.length > 0;

  const handleTierClick = (tier: '1k' | '2k' | '4k') => {
    const targetOpt = ratiosByResolution[tier].get(currentAspect);
    if (targetOpt) {
      onChange(targetOpt.size);
    } else {
      const first = ratiosByResolution[tier].values().next().value;
      if (first) onChange(first.size);
    }
  };

  const tierLabel = effectiveTier === '4k' ? '4K' : effectiveTier === '2k' ? '2K' : '1K';

  if (!hasOptions) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-2 h-6 text-[11px] font-medium"
        style={{
          background: 'rgba(99, 102, 241, 0.12)',
          border: '1px solid rgba(99, 102, 241, 0.24)',
          color: 'rgba(129, 140, 248, 0.95)',
        }}
      >
        {currentSize}
      </span>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={(o) => { if (!disabled) setOpen(o); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full px-2.5 h-6 text-[11px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
          style={{
            background: 'rgba(34, 197, 94, 0.12)',
            border: '1px solid rgba(34, 197, 94, 0.35)',
            color: 'rgba(74, 222, 128, 0.95)',
            opacity: disabled ? 0.5 : 1,
          }}
          title="选择尺寸"
          onClick={(e) => e.stopPropagation()}
        >
          <span style={{ whiteSpace: 'nowrap' }}>{tierLabel} · {currentAspect}</span>
          <span className="text-[8px] ml-0.5" style={{ opacity: 0.6 }}>▾</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={10}
          className="z-50 rounded-[16px] p-3"
          style={{
            width: 280,
            background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
            border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
            backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
        >
          {/* 分辨率档位 */}
          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>分辨率</div>
          <div className="flex gap-1.5 mb-3">
            {availableTiers.map((tier) => {
              const isSelected = effectiveTier === tier;
              const label = tier === '4k' ? '4K' : tier === '2k' ? '2K' : '1K';
              return (
                <button
                  key={tier}
                  type="button"
                  className="flex-1 h-7 rounded-[8px] text-[12px] font-semibold transition-colors"
                  style={{
                    background: isSelected ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)',
                    border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                    color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                  }}
                  onClick={() => handleTierClick(tier)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* 比例网格 */}
          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'rgba(255,255,255,0.55)' }}>尺寸</div>
          <div className="grid grid-cols-4 gap-1.5">
            {(() => {
              let ratios = ratiosByResolution[effectiveTier];
              if (ratios.size === 0) {
                for (const tier of ['2k', '1k', '4k'] as const) {
                  if (ratiosByResolution[tier].size > 0) {
                    ratios = ratiosByResolution[tier];
                    break;
                  }
                }
              }
              return Array.from(ratios.entries()).map(([ratio, opt]) => {
                const isSelected = ratio === currentAspect;
                const [rw, rh] = ratio.includes(':') ? ratio.split(':').map(Number) : [1, 1];
                const aspectVal = rw && rh ? rw / rh : 1;
                const iconW = aspectVal >= 1 ? 20 : Math.round(20 * aspectVal);
                const iconH = aspectVal <= 1 ? 20 : Math.round(20 / aspectVal);
                return (
                  <button
                    key={ratio}
                    type="button"
                    className="flex flex-col items-center justify-center gap-1 py-2 rounded-[8px] transition-colors"
                    style={{
                      background: isSelected ? 'rgba(99, 102, 241, 0.22)' : 'rgba(255,255,255,0.08)',
                      border: isSelected ? '1px solid rgba(99, 102, 241, 0.6)' : '1px solid rgba(255,255,255,0.14)',
                      color: isSelected ? 'rgba(129, 140, 248, 1)' : 'rgba(255,255,255,0.88)',
                    }}
                    onClick={() => {
                      onChange(opt.size);
                      setOpen(false);
                    }}
                  >
                    <div style={{ width: iconW, height: iconH, border: '1.5px solid currentColor', borderRadius: 3, opacity: 0.7 }} />
                    <span className="text-[10px] font-medium">{ratio}</span>
                  </button>
                );
              });
            })()}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
