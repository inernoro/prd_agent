import { Activity, ArrowLeft, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { resolveMapHomeHref, usePlatformMapHome } from '@/lib/mapNavigation';

const MAP_SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function takeMapSsoCode(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = params.get('code');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return code && MAP_SSO_CODE_PATTERN.test(code) ? code : null;
}

export function takeSafeMapReturnTo(search: string): string {
  const value = new URLSearchParams(search).get('returnTo');
  const hasControlCharacter = [...(value ?? '')].some(char => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!value || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || hasControlCharacter) return '/';
  return value;
}

export function MapSsoPage() {
  const { loginWithMapCode } = useAuth();
  // 同上：失败态那条「返回 MAP」链接要能等到权威地址。
  usePlatformMapHome();
  const navigate = useNavigate();
  const [code] = useState(takeMapSsoCode);
  const [returnTo] = useState(() => takeSafeMapReturnTo(window.location.search));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!code) {
      setError('登录链接无效或已过期，请从 MAP 重新打开模型网关。');
      return () => { active = false; };
    }

    void loginWithMapCode(code).then((result) => {
      if (!active) return;
      if (result.success) {
        navigate(returnTo, { replace: true });
        return;
      }
      setError('安全登录未完成。一次性链接可能已使用或已过期，请从 MAP 重新打开。');
    });
    return () => { active = false; };
  }, [code, loginWithMapCode, navigate, returnTo]);

  return (
    <main className="lg-map-sso-page">
      <section className="lg-map-sso-card" aria-labelledby="map-sso-title">
        <span className="lg-map-sso-mark" aria-hidden="true"><Activity size={22} /></span>
        {error ? <ShieldCheck size={28} aria-hidden="true" /> : <LoaderCircle className="lg-map-sso-spinner" size={28} aria-hidden="true" />}
        <div>
          <p>MAP 与 LLM Gateway</p>
          <h1 id="map-sso-title">{error ? '需要重新发起安全登录' : '正在从 MAP 安全登录'}</h1>
          <span role={error ? 'alert' : 'status'} aria-live="polite">
            {error ?? '正在核验一次性授权并建立管理员会话，请稍候。'}
          </span>
        </div>
        {error ? (
          <a className="lg-map-sso-return" href={resolveMapHomeHref()}>
            <ArrowLeft size={16} />返回 MAP 重新打开
          </a>
        ) : (
          <div className="lg-map-sso-progress" aria-hidden="true"><span /></div>
        )}
      </section>
    </main>
  );
}
