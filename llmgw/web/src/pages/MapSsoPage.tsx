import { gatewayLoginDestination, markQuickstartArrival } from '@/components/entry/quickstartArrival';
import { ArrowLeft } from 'lucide-react';
import { ConsciousnessScene } from '@/components/entry/ConsciousnessScene';
import './GatewayEntry.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { resolveMapHomeHref, usePlatformMapHome } from '@/lib/mapNavigation';

const MAP_SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function readMapSsoCode(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const code = params.get('code');
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
  const [code] = useState(readMapSsoCode);
  const [returnTo] = useState(() => takeSafeMapReturnTo(window.location.search));
  const [error, setError] = useState<string | null>(null);
  const exchange = useRef<ReturnType<typeof loginWithMapCode> | null>(null);
  useLayoutEffect(() => { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); }, []);

  useEffect(() => {
    let active = true;
    if (!code) {
      setError('登录链接无效或已过期，请从 MAP 重新打开模型网关。');
      return () => { active = false; };
    }

    // Keep a one-time code exchange across effect restarts.
    exchange.current ??= loginWithMapCode(code);
    void exchange.current.then((result) => {
      if (!active) return;
      if (result.success) {
        const destination = gatewayLoginDestination(returnTo, result.data?.tenant);
        if (!result.data?.mustChangePassword && destination.split(/[?#]/)[0] === '/quickstart') markQuickstartArrival();
        navigate(destination, { replace: true });
        return;
      }
      setError('安全登录未完成。一次性链接可能已使用或已过期，请从 MAP 重新打开。');
    }).catch(() => {
      if (active) setError('暂时无法完成安全登录，请返回 MAP 后重试。');
    });
    return () => { active = false; };
  }, [code, loginWithMapCode, navigate, returnTo]);

  return (
    <main className="gateway-entry cinema-login gateway-login" data-phase={error ? 'idle' : 'verifying'}>
      <ConsciousnessScene stillLogin />
      <section className="cinema-login-center gateway-sso-copy" aria-labelledby="map-sso-title">
        <h1 id="map-sso-title">{error ? '需要重新发起安全登录' : '正在从 MAP 安全登录'}</h1>
        <p role={error ? 'alert' : 'status'}>{error ?? '正在验证账号…'}</p>
        {error && <a href={resolveMapHomeHref()}><ArrowLeft size={16} />返回 MAP 重新打开</a>}
      </section>
    </main>
  );
}
