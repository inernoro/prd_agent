import { useRef, useState } from 'react';
import { debugClaimNotice } from '@/services/real/productClaimWebhook';

/** 已生成编号后才展示，手工放行不会再次申领或修改版本记录。 */
export function DebugClaimNotificationButton({ kind, id, visible }: { kind: 'T' | 'V'; id: string; visible: boolean }) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [message, setMessage] = useState('');
  if (!visible) return null;
  const send = async () => {
    if (submitting.current || queued) return;
    submitting.current = true; setBusy(true); setMessage('');
    try {
      const result = await debugClaimNotice(kind, id);
      if (result.success) { setQueued(true); setMessage('已提交推送，可在Webhook配置中查看发送结果。'); }
      else setMessage(result.error.message);
    } catch { setMessage('推送结果暂未确认，请在Webhook配置中核对，勿重复点击。'); setQueued(true); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" disabled={busy || queued} onClick={() => void send()} className="rounded-lg border border-token-subtle px-3 py-1.5 text-xs hover-bg-soft disabled:opacity-50">{busy ? '正在提交…' : queued ? '已提交推送' : '调试通知'}</button>
    {message && <span role="status" className="text-xs text-token-secondary">{message}</span>}
  </span>;
}
