import { cn } from '@/lib/cn';

interface GlowOrbProps {
  className?: string;
  color?: 'indigo' | 'purple' | 'blue' | 'green';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  blur?: 'soft' | 'medium' | 'hard';
  animate?: boolean;
}

const colorMap = {
  indigo: 'bg-gradient-radial from-indigo-400/30 via-indigo-500/10 to-transparent',
  purple: 'bg-gradient-radial from-purple-500/30 via-purple-600/10 to-transparent',
  blue: 'bg-gradient-radial from-blue-500/30 via-blue-600/10 to-transparent',
  green: 'bg-gradient-radial from-emerald-400/30 via-emerald-500/10 to-transparent',
};

const sizeMap = {
  sm: 'w-32 h-32',
  md: 'w-64 h-64',
  lg: 'w-96 h-96',
  xl: 'w-[500px] h-[500px]',
};

const blurMap = {
  soft: 'blur-2xl',
  medium: 'blur-3xl',
  hard: 'blur-[100px]',
};

export function GlowOrb({
  className,
  color = 'indigo',
  size = 'lg',
  blur = 'hard',
  animate = true,
}: GlowOrbProps) {
  return (
    <div
      className={cn(
        'absolute rounded-full pointer-events-none',
        colorMap[color],
        sizeMap[size],
        blurMap[blur],
        animate && 'animate-pulse-slow',
        className
      )}
      style={{
        background: color === 'indigo'
          ? 'radial-gradient(circle, rgba(99, 102, 241, 0.4) 0%, rgba(99, 102, 241, 0.1) 40%, transparent 70%)'
          : color === 'purple'
          ? 'radial-gradient(circle, rgba(139, 92, 246, 0.4) 0%, rgba(139, 92, 246, 0.1) 40%, transparent 70%)'
          : color === 'blue'
          ? 'radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, rgba(59, 130, 246, 0.1) 40%, transparent 70%)'
          : 'radial-gradient(circle, rgba(52, 211, 153, 0.4) 0%, rgba(52, 211, 153, 0.1) 40%, transparent 70%)',
      }}
    />
  );
}
