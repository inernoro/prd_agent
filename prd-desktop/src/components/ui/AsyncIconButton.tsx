import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

type Status = 'idle' | 'busy' | 'done' | 'error';

export default function AsyncIconButton({
  title,
  onAction,
  icon,
  className,
  successTitle = '已复制',
  errorTitle = '复制失败',
  successMs = 900,
  errorMs = 1200,
}: {
  title: string;
  onAction: () => Promise<void> | void;
  icon: ReactNode;
  className?: string;
  successTitle?: string;
  errorTitle?: string;
  successMs?: number;
  errorMs?: number;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const shownTitle =
    status === 'done' ? successTitle : status === 'error' ? errorTitle : title;

  const handleClick = useCallback(async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === 'busy') return;

    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    setStatus('busy');
    try {
      await onAction();
      setStatus('done');
      timerRef.current = window.setTimeout(() => setStatus('idle'), successMs);
    } catch (err) {
      console.error(err);
      setStatus('error');
      timerRef.current = window.setTimeout(() => setStatus('idle'), errorMs);
    }
  }, [errorMs, onAction, status, successMs]);

  return (
    <button
      type="button"
      title={shownTitle}
      aria-label={shownTitle}
      onClick={handleClick}
      className={className}
      data-status={status}
    >
      {icon}
    </button>
  );
}


