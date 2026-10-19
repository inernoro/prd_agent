import { Clock3, Zap } from 'lucide-react';

export function PrebuiltRuntimeIcon({ partial, pending, label, className = '' }: {
  partial: boolean; pending: boolean; label: string; className?: string;
}) {
  const Icon = pending ? Clock3 : Zap;
  const color = pending ? 'text-muted-foreground' : partial ? 'text-express-partial' : 'text-express-full';
  return <Icon className={`h-4 w-4 ${color} ${className}`} aria-label={label} />;
}
