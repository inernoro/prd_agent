import { cn } from '@/lib/utils';
import type { SVGProps } from 'react';

export function CdsMetallicLogo({
  className,
  title = 'CDS',
  ...props
}: {
  className?: string;
  title?: string;
} & SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      className={cn('cds-metallic-logo', className)}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      {...props}
    >
      <defs>
        <linearGradient id="cds-metallic-logo-paint" x1="0%" y1="18%" x2="100%" y2="82%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="22%" stopColor="#bfc7d6" />
          <stop offset="42%" stopColor="#f8fafc" />
          <stop offset="58%" stopColor="#7c8595" />
          <stop offset="76%" stopColor="#f2f6ff" />
          <stop offset="100%" stopColor="#a8b1c2" />
        </linearGradient>
        <filter id="cds-metallic-logo-glow" x="-60%" y="-60%" width="220%" height="220%">
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
      <g className="cds-metallic-logo-orbits" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="32" cy="32" rx="24" ry="9.5" />
        <ellipse cx="32" cy="32" rx="24" ry="9.5" transform="rotate(60 32 32)" />
        <ellipse cx="32" cy="32" rx="24" ry="9.5" transform="rotate(120 32 32)" />
      </g>
      <circle className="cds-metallic-logo-core" cx="32" cy="32" r="5.3" />
    </svg>
  );
}
