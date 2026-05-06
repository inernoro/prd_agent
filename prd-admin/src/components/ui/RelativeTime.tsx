import { useEffect, useState, memo } from 'react';

type TimeInput = number | string | Date | null | undefined;

function toDate(input: TimeInput): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(input).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatAbsolute(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatRelative(d: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hour = Math.floor(min / 60);

  if (sec < 30 && !future) return '刚刚';
  if (min < 1) return future ? '即将' : '刚刚';
  if (min < 60) return future ? `${min} 分钟后` : `${min} 分钟前`;
  if (hour < 24) {
    // 过去时：跨午夜的情形让"昨天 HH:mm"分支接管（信息更明确）；同日才走相对小时
    // 未来时：跨午夜也直接给"X 小时后"，避免掉到 "MM-DD HH:mm" 格式
    if (future) return `${hour} 小时后`;
    if (isSameDay(d, now)) return `${hour} 小时前`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) {
    return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  const day = Math.floor(hour / 24);
  if (day < 7 && !future) return `${day} 天前`;

  if (d.getFullYear() === now.getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface RelativeTimeProps {
  value: TimeInput;
  className?: string;
  /** 不可解析时回退显示，默认空字符串 */
  fallback?: string;
  /** 自动刷新频率（毫秒），默认 60000；传 0 关闭自动刷新 */
  refreshIntervalMs?: number;
  /** 自定义 title（默认是完整时间） */
  title?: string;
  /** 渲染包裹标签，默认 span */
  as?: 'span' | 'time' | 'div';
}

/**
 * 相对时间显示：刚刚 / X 分钟前 / 昨天 HH:mm / MM-DD HH:mm / yyyy-MM-dd
 * 默认每分钟自动刷新一次，使"刚刚"会自然过渡到"1 分钟前"。
 * 鼠标悬停显示完整时间。
 */
export const RelativeTime = memo(function RelativeTime({
  value,
  className,
  fallback = '',
  refreshIntervalMs = 60_000,
  title,
  as = 'span',
}: RelativeTimeProps) {
  const date = toDate(value);
  const dateMs = date ? date.getTime() : 0;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!dateMs || refreshIntervalMs <= 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [dateMs, refreshIntervalMs]);

  if (!date) return <>{fallback}</>;
  const text = formatRelative(date);
  const tip = title ?? formatAbsolute(date);
  const Tag = as;
  return (
    <Tag className={className} title={tip}>
      {text}
    </Tag>
  );
});

export default RelativeTime;
