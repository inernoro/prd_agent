import * as React from 'react';
import { cn } from '@/lib/cn';

type SurfaceVariant = 'default' | 'raised' | 'inset' | 'row' | 'interactive' | 'reading';

const variantClass: Record<SurfaceVariant, string> = {
  default: 'surface',
  raised: 'surface-raised',
  inset: 'surface-inset',
  row: 'surface-row',
  interactive: 'surface surface-interactive',
  reading: 'surface-reading text-crisp',
};

export type SurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: SurfaceVariant;
};

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { className, variant = 'default', ...props },
  ref,
) {
  return <div ref={ref} className={cn(variantClass[variant], className)} {...props} />;
});

Surface.displayName = 'Surface';

