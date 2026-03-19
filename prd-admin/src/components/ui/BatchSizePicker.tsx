import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Maximize2 } from 'lucide-react';
import { glassPanel } from '@/lib/glassStyles';
import { Button } from '@/components/design/Button';
import type { SizesByResolution } from '@/lib/imageAspectOptions';

type SizeOption = { size: string; aspectRatio: string };

interface BatchSizePickerProps {
  sizesByResolution: SizesByResolution;
  disabled?: boolean;
  onApply: (size: string) => void;
}

/**
 * 批量尺寸选择器 — 选择一个尺寸后统一应用到所有配图
 */
export function BatchSizePicker({ sizesByResolution, disabled, onApply }: BatchSizePickerProps) {
  const [open, setOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<'1k' | '2k' | '4k'>('1k');

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

  const availableTiers = (['1k', '2k', '4k'] as const).filter((t) => ratiosByResolution[t].size > 0);
  const effectiveTier = availableTiers.includes(selectedTier) ? selectedTier : (availableTiers[0] || '1k');

  if (availableTiers.length === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={(o) => { if (!disabled) setOpen(o); }}>
      <Popover.Trigger asChild>
        <Button
          size="xs"
          variant="secondary"
          disabled={disabled}
          title="批量修改所有配图的尺寸"
          onClick={(e) => e.stopPropagation()}
        >
          <Maximize2 size={12} />
          尺寸
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 rounded-[16px] p-3"
          style={{
            ...glassPanel,
            width: 280,
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
        >
          <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
            批量修改所有配图尺寸
          </div>
          {/* 分辨率档位 */}
          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>分辨率</div>
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
                  onClick={() => setSelectedTier(tier)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* 比例网格 */}
          <div className="text-[11px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>尺寸</div>
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
                      background: 'rgba(255,255,255,0.08)',
                      border: '1px solid rgba(255,255,255,0.14)',
                      color: 'rgba(255,255,255,0.88)',
                    }}
                    onClick={() => {
                      onApply(opt.size);
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
