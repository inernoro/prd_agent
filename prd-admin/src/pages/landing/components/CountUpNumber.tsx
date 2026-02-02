import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

interface CountUpNumberProps {
  end: number;
  duration?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
  decimals?: number;
  startOnView?: boolean;
}

export function CountUpNumber({
  end,
  duration = 2000,
  suffix = '',
  prefix = '',
  className,
  decimals = 0,
  startOnView = true,
}: CountUpNumberProps) {
  const [count, setCount] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!startOnView) {
      setHasStarted(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted) {
          setHasStarted(true);
        }
      },
      { threshold: 0.1 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [startOnView, hasStarted]);

  useEffect(() => {
    if (!hasStarted) return;

    const startTime = Date.now();
    const startValue = 0;

    const animate = () => {
      const now = Date.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function: easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = startValue + (end - startValue) * eased;

      setCount(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [hasStarted, end, duration]);

  const formattedNumber = decimals > 0
    ? count.toFixed(decimals)
    : Math.floor(count).toLocaleString();

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {prefix}{formattedNumber}{suffix}
    </span>
  );
}
