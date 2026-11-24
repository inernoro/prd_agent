import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest } from '@/services/real/apiClient';

type AuthorizeResponse = {
  redirectUrl: string;
};

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string;
};

function readAuthorizeParams(): AuthorizeParams {
  const params = new URLSearchParams(window.location.search);
  return {
    clientId: params.get('client_id') || '',
    redirectUri: params.get('redirect_uri') || '',
    state: params.get('state') || '',
  };
}

export default function ConsoleSsoAuthorizePage() {
  const params = useMemo(readAuthorizeParams, []);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError('');
    void apiRequest<AuthorizeResponse>('/api/console-sso/authorize', {
      method: 'POST',
      body: {
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        state: params.state,
      },
    }).then((response) => {
      if (!alive) return;
      if (!response.success || !response.data?.redirectUrl) {
        setError(response.error?.message || '无法完成 SSO 授权，请检查登录身份与回调配置。');
        return;
      }
      window.location.replace(response.data.redirectUrl);
    }).catch(() => {
      if (alive) setError('SSO 授权服务暂时不可用，请稍后重试。');
    });
    return () => {
      alive = false;
    };
  }, [attempt, params]);

  return (
    <main
      className="min-h-screen w-full flex items-center justify-center px-5"
      style={{ background: 'var(--bg-base)' }}
    >
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
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{
            background: 'rgba(var(--accent-primary-rgb), 0.14)',
            color: 'var(--accent-primary)',
          }}
        >
          {error ? <ShieldCheck size={22} /> : <MapSpinner size={22} />}
        </div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {error ? 'SSO 授权未完成' : '正在授权 CDS 登录'}
        </h1>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          {error || '正在使用当前 MAP 管理会话签发一次性登录票据，完成后会自动返回 CDS。'}
        </p>
        {error ? (
          <button
            type="button"
            className="mt-5 rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新授权
          </button>
        ) : null}
      </section>
    </main>
  );
}
