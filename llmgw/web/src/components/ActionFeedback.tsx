import { useEffect, useRef } from 'react';
import { Button, InlineAlert } from '@/components/ui';

/** 只让明确的成功回执退场；错误、权限与复合结果由调用方保留。 */
export function ActionFeedback({ message, transient = false, onDismiss }: { message: string | null; transient?: boolean; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!message || !transient) return;
    const timer = window.setTimeout(() => dismissRef.current(), 6000);
    return () => window.clearTimeout(timer);
  }, [message, transient]);
  if (!message) return null;
  return <InlineAlert tone={transient ? 'ok' : 'info'}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} role="status">
      <span style={{ flex: 1 }}>{message}</span>
      <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="关闭操作反馈">关闭</Button>
    </div>
  </InlineAlert>;
}
