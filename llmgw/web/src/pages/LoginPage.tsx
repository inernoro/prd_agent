import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Volume2, VolumeX } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getHealth } from '@/lib/api';
import { resolveMapHomeHref, usePlatformMapHome } from '@/lib/mapNavigation';
import { ConsciousnessHud, ConsciousnessScene, IdentityScanner, type IdentityPhase } from '@/components/entry/ConsciousnessScene';
import { loadPortraitImages, preloadPortraitMotion } from '@/components/entry/portraitRenderer';
import { EntryAudio } from '@/components/entry/entryAudio';
import { gatewayLoginDestination, markQuickstartArrival } from '@/components/entry/quickstartArrival';
import './GatewayEntry.css';

export { resolveMapHomeHref } from '@/lib/mapNavigation';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LoginPage() {
  const { login, sessionExpiredReason } = useAuth();
  usePlatformMapHome();
  const navigate = useNavigate();
  const location = useLocation();
  const candidate = (location.state as { from?: string } | null)?.from;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<IdentityPhase>('idle');
  const audioTransferred = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState('正在检查服务');
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('llmgw-entry-sound') !== 'off'; } catch { return true; } });
  const audio = useRef<EntryAudio | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const busy = phase !== 'idle';
  const authorized = phase === 'authorized' || phase === 'entering';
  useEffect(() => {
    mounted.current = true;
    audio.current = new EntryAudio();
    audio.current.setEnabled(sound);
    preloadPortraitMotion();
    void loadPortraitImages().catch(() => {});
    void getHealth().then(res => { if (mounted.current) setHealth(res.success && res.data?.status === 'ok' ? 'Gateway 服务正常' : '暂时无法确认服务状态'); }).catch(() => { if (mounted.current) setHealth('暂时无法确认服务状态'); });
    const silence = () => { if (document.visibilityState !== 'visible') audio.current?.stop(); };
    document.addEventListener('visibilitychange', silence);
    return () => { mounted.current = false; if (!audioTransferred.current) audio.current?.dispose(); document.removeEventListener('visibilitychange', silence); };
  }, []);
  const pause = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !username.trim() || !password) return;
    pending.current = true; setPhase('verifying'); setError(null);
    if (sound) { audio.current?.unlock(); audio.current?.play('scan'); }
    try {
      const res = await login(username.trim(), password);
      if (!mounted.current) return;
      if (!res.success) { setError(res.error?.message || '登录失败，请检查账号密码'); setPhase('idle'); return; }
      const from = gatewayLoginDestination(candidate, res.data?.tenant);
      if (res.data?.mustChangePassword || reducedMotion()) { navigate(res.data?.mustChangePassword ? '/change-password' : from, { replace: true }); return; }
      setPhase('authorized'); if (sound) audio.current?.play('verified');
      await pause(760); if (!mounted.current) return;
      setPhase('entering'); await pause(820); if (!mounted.current) return;
      if (from.split(/[?#]/)[0] === '/quickstart') audioTransferred.current = markQuickstartArrival(audio.current);
      navigate(from, { replace: true });
    } catch { if (mounted.current) { setError('暂时无法连接，请稍后重试'); setPhase('idle'); } }
    finally { pending.current = false; }
  };
  const toggleSound = () => {
    const enabled = !sound; setSound(enabled); audio.current?.setEnabled(enabled);
    try { localStorage.setItem('llmgw-entry-sound', enabled ? 'on' : 'off'); } catch { /* device preference only */ }
    if (enabled) { audio.current?.unlock(); audio.current?.play('verified'); } else audio.current?.stop();
  };
  return <div className="gateway-entry cinema-login" data-phase={phase} data-sound={sound ? 'on' : 'off'}>
    <ConsciousnessScene fog />
    <ConsciousnessHud login />
    <IdentityScanner phase={phase} />
    <button className="gateway-sound" type="button" aria-pressed={sound} onClick={toggleSound} aria-label={sound ? '关闭进入音效' : '开启进入音效'}>
      {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}<span>{sound ? '音效已开启' : '静音'}</span>
    </button>
    <main className="cinema-login-center" aria-labelledby="llmgw-login-title">
      {authorized ? <div className="cinema-identity-result" role="status"><div className="cinema-verified-copy"><p>读取完毕 · 核验通过</p><small>READ COMPLETE / VERIFIED</small></div><div className="cinema-welcome-copy"><p>WELCOME TO</p><small>YOUR MODEL WORKSPACE</small><strong>LLM Gateway</strong></div></div> : <div className="gateway-login-form">
        <div className="cinema-form-index">IDENTITY / GATEWAY</div>
        <h1 className="cinema-form-heading" id="llmgw-login-title">登录模型网关</h1>
        <p className="cinema-form-description">使用你的独立租户账号</p>
        <form onSubmit={submit}>
          <label htmlFor="llmgw-username">用户名</label><input id="llmgw-username" autoComplete="username" placeholder="输入用户名" value={username} onChange={e => setUsername(e.target.value)} disabled={busy} required />
          <label htmlFor="llmgw-password">密码</label><input id="llmgw-password" type="password" autoComplete="current-password" placeholder="输入密码" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required />
          {error && <div className="gateway-login-message" role="alert">{error}</div>}
          {!error && sessionExpiredReason && <div className="gateway-login-message" role="status">{sessionExpiredReason === 'revoked' ? '账号权限已变更，请重新登录。' : '登录状态已过期，请重新登录。'}</div>}
          <button className="gateway-login-submit" type="submit" disabled={busy || !username.trim() || !password}>{busy ? '正在验证账号…' : '开始身份确认'}<ArrowRight size={15} /></button>
        </form>
        <details className="gateway-account-help"><summary>账号与登录帮助</summary><p>MAP 与 Gateway 账号相互独立。没有账号，请联系租户管理员；应用密钥不能登录控制台。</p></details>
        <a className="gateway-back" href={resolveMapHomeHref()}><ArrowLeft size={14} />返回 MAP</a>
      </div>}
    </main>
    <div className="cinema-login-status" role="status">{busy ? authorized ? '身份已确认，正在进入工作空间' : '正在读取身份与访问权限' : health}<small>LLM GATEWAY / READY TO CONNECT</small></div>
  </div>;
}
