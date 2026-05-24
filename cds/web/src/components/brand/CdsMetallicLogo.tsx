import { useId, type ReactNode, type SVGProps } from 'react';
import { cn } from '@/lib/utils';

export function CdsMetallicLogo({
  className,
  title = 'CDS',
  ...props
}: {
  className?: string;
  title?: string;
} & SVGProps<SVGSVGElement>): JSX.Element {
  const baseId = useId().replace(/:/g, '');
  const paintId = `${baseId}-cds-metallic-logo-paint`;
  const glowId = `${baseId}-cds-metallic-logo-glow`;

  return (
    <svg
      className={cn('cds-metallic-logo', className)}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      {...props}
    >
      <defs>
        <linearGradient id={paintId} x1="0%" y1="18%" x2="100%" y2="82%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="22%" stopColor="#bfc7d6" />
          <stop offset="42%" stopColor="#f8fafc" />
          <stop offset="58%" stopColor="#7c8595" />
          <stop offset="76%" stopColor="#f2f6ff" />
          <stop offset="100%" stopColor="#a8b1c2" />
        </linearGradient>
        <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.4" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0.55  0 1 0 0 0.72  0 0 1 0 1  0 0 0 .62 0"
            result="glow"
          />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g
        className="cds-metallic-logo-orbits"
        fill="none"
        filter={`url(#${glowId})`}
        stroke={`url(#${paintId})`}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <ellipse cx="32" cy="32" rx="24" ry="9.5" />
        <ellipse cx="32" cy="32" rx="24" ry="9.5" transform="rotate(60 32 32)" />
        <ellipse cx="32" cy="32" rx="24" ry="9.5" transform="rotate(120 32 32)" />
      </g>
      <circle className="cds-metallic-logo-core" cx="32" cy="32" r="5.3" fill={`url(#${paintId})`} />
    </svg>
  );
}

const logoLoaderSizes = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
  xl: 'h-12 w-12',
} as const;

type CdsLogoLoaderSize = keyof typeof logoLoaderSizes;

export function CdsLogoLoader({
  className,
  logoClassName,
  label,
  size = 'sm',
  inline = true,
}: {
  className?: string;
  logoClassName?: string;
  label?: ReactNode;
  size?: CdsLogoLoaderSize;
  inline?: boolean;
}): JSX.Element {
  return (
    <span
      className={cn(
        'cds-logo-loader',
        inline ? 'inline-flex' : 'flex',
        label ? 'items-center gap-2' : 'items-center justify-center',
        className,
      )}
      role={label ? 'status' : 'img'}
      aria-live={label ? 'polite' : undefined}
      aria-label={label ? undefined : 'CDS 正在加载'}
    >
      <span className="cds-logo-loader-mark" aria-hidden="true">
        <CdsMetallicLogo className={cn(logoLoaderSizes[size], logoClassName)} />
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  );
}
