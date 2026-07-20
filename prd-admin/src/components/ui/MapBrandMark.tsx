import { cn } from '@/lib/cn';

type MapBrandMarkProps = {
  expanded?: boolean;
  className?: string;
};

/**
 * MAP 品牌标识：字母 M 同时是一条带三个节点的路径，表达“从目标到智能体再到结果”。
 * 仅使用主题 token，在深浅皮肤下保持同一品牌结构与清晰度。
 */
export function MapBrandMark({ expanded = false, className }: MapBrandMarkProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <span
        className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[11px]"
        style={{
          color: 'var(--accent-primary)',
          background: 'radial-gradient(circle at 28% 22%, var(--launcher-theme-icon-bg), var(--launcher-control-bg) 72%)',
          border: '1px solid var(--launcher-control-border)',
          boxShadow: 'inset 0 1px 0 var(--border-faint)',
        }}
      >
        <svg
          viewBox="0 0 32 32"
          width="28"
          height="28"
          role="img"
          aria-label="MAP"
          data-testid="map-brand-mark"
        >
          <title>MAP</title>
          <path
            d="M7.5 23.5V9.5L16 19l8.5-9.5v14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7.5" cy="9.5" r="2" fill="var(--semantic-info-text)" />
          <circle cx="16" cy="19" r="2" fill="var(--semantic-success-text)" />
          <circle cx="24.5" cy="9.5" r="2" fill="var(--launcher-theme-icon)" />
        </svg>
      </span>

      {expanded && (
        <span className="min-w-0 text-left leading-none">
          <span className="block text-[13px] font-semibold tracking-[0.16em] text-token-primary">MAP</span>
          <span className="mt-1 block truncate text-[9px] tracking-[0.08em] text-token-muted">智能体平台</span>
        </span>
      )}
    </span>
  );
}
