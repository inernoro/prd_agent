import CountUp from '@/components/reactbits/CountUp';
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
  return (
    <CountUp
      to={end}
      direction="up"
      duration={duration / 1000}
      suffix={suffix}
      prefix={prefix}
      decimals={decimals}
      startWhen={startOnView}
      className={cn('tabular-nums', className)}
      separator=","
    />
  );
}
