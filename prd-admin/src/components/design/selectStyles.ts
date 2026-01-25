import { cn } from '@/lib/cn';

export function selectSizeClass(uiSize: 'sm' | 'md') {
  return uiSize === 'sm' ? 'h-9 rounded-[12px] text-sm' : 'h-10 rounded-[14px] text-[13px]';
}

export function selectPaddingLeft(hasLeftIcon: boolean) {
  return hasLeftIcon ? 'pl-9' : 'px-3';
}

export const selectTriggerBase = 'relative w-full pr-9 outline-none transition-colors flex items-center';

export function selectTriggerClass(args: {
  uiSize: 'sm' | 'md';
  hasLeftIcon: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return cn(
    selectTriggerBase,
    selectPaddingLeft(args.hasLeftIcon),
    'hover:border-white/20',
    'focus-visible:ring-2 focus-visible:ring-white/20',
    selectSizeClass(args.uiSize),
    args.disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
    args.className
  );
}

export const selectTriggerStyle: React.CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: 'var(--text-primary)',
};

export const selectContentClass = 'z-[120] rounded-[14px] overflow-hidden';

export const selectContentStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
  boxShadow: '0 18px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
  backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
  WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
  minWidth: 'var(--radix-select-trigger-width)',
  maxHeight: 'var(--radix-select-content-available-height)',
};

export const selectViewportClass = 'p-1';

export const selectViewportStyle: React.CSSProperties = {
  maxHeight: 240,
  overflow: 'auto',
};

export const selectItemClass = cn(
  'px-3 py-2 rounded-[8px] text-sm cursor-pointer outline-none',
  'hover:bg-white/8',
  'focus:bg-white/8',
  'data-[highlighted]:bg-white/8',
  'data-[disabled]:opacity-40 data-[disabled]:pointer-events-none'
);

export const selectLabelClass = 'px-3 py-2 text-[11px] uppercase tracking-wide';
