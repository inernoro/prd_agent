import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';

/** 发起跳转时把「这次是去哪台源站」记在这里，回调时凭 state 取回。 */
export const DATA_SYNC_PENDING_KEY = 'data-sync:pending';

/**
 * 授权回跳落地页。
 *
 * 授权码走 URL fragment（`#code=...`）而不是 query：fragment 不会被浏览器发给服务器、
 * 不会进 nginx 访问日志、不会进 Referer。拿到后立刻交给本站服务端换令牌，并把地址栏
 * 里的 fragment 抹掉，免得它留在历史记录里。
 */
export default function DataSyncCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  // React 18 严格模式下 effect 会跑两次；授权码只能用一次，第二次必然失败并报错。
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = hash.get('code') || '';
    const state = hash.get('state') || '';
    window.history.replaceState(null, '', window.location.pathname);

    let pending: { state: string; sourceOrigin: string } | null = null;
    try {
      pending = JSON.parse(sessionStorage.getItem(DATA_SYNC_PENDING_KEY) || 'null');
    } catch {
      pending = null;
    }
    sessionStorage.removeItem(DATA_SYNC_PENDING_KEY);

    if (!code || !state || !pending || pending.state !== state) {
      // state 对不上说明这不是本浏览器发起的那次授权，直接拒绝，不去换票。
      setError('这次回跳与本机发起的授权对不上，请回到数据同步页重新发起。');
      return;
    }

    void apiRequest<{ runId: string }>('/api/instance-sync/runs/callback', {
      method: 'POST',
      body: { sourceOrigin: pending.sourceOrigin, code, state },
    }).then((res) => {
      if (!res.success || !res.data?.runId) {
        setError(res.error?.message || '换取导出授权失败');
        return;
      }
      navigate(`/data-sync?run=${encodeURIComponent(res.data.runId)}`, { replace: true });
    });
  }, [navigate]);

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-5" style={{ background: 'var(--bg-base)' }}>
      <section
        className="w-full max-w-md rounded-2xl p-7 text-center"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-raised)',
        }}
        role={error ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{ background: 'rgba(var(--accent-primary-rgb), 0.14)', color: 'var(--accent-primary)' }}
        >
          {error ? <ShieldAlert size={22} /> : <MapSpinner size={22} />}
        </div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {error ? '授权没有完成' : '正在换取一次性导出授权'}
        </h1>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          {error || '源站已经同意，正在把授权换成本次同步的凭据，马上带你去确认同步范围。'}
        </p>
        {error ? (
          <button
            type="button"
            className="mt-5 rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
            onClick={() => navigate('/data-sync', { replace: true })}
          >
            回到数据同步
          </button>
        ) : null}
      </section>
    </main>
  );
}
