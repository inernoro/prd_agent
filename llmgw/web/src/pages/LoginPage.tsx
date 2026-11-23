import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Volume2, VolumeX } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { resolveMapHomeHref, usePlatformMapHome } from '@/lib/mapNavigation';
import { ConsciousnessScene } from '@/components/entry/ConsciousnessScene';
import { EntryAudio } from '@/components/entry/entryAudio';
import { gatewayLoginDestination, markQuickstartArrival } from '@/components/entry/quickstartArrival';
import './GatewayEntry.css';

export { resolveMapHomeHref } from '@/lib/mapNavigation';
export function LoginPage() {
  const { login, sessionExpiredReason } = useAuth();
  usePlatformMapHome();
  const navigate = useNavigate();
  const location = useLocation();
  const candidate = (location.state as { from?: string } | null)?.from;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const audioTransferred = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('llmgw-entry-sound') !== 'off'; } catch { return true; } });
  const audio = useRef<EntryAudio | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    audio.current = new EntryAudio();
    audio.current.setEnabled(sound);
    const silence = () => { if (document.visibilityState !== 'visible') audio.current?.stop(); };
    document.addEventListener('visibilitychange', silence);
    return () => { mounted.current = false; if (!audioTransferred.current) audio.current?.dispose(); document.removeEventListener('visibilitychange', silence); };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !username.trim() || !password) return;
    pending.current = true; setBusy(true); setError(null);
    if (sound) audio.current?.unlock();
    try {
      const res = await login(username.trim(), password);
      if (!mounted.current) return;
      if (!res.success) { setError(res.error?.message || '登录失败，请检查账号密码'); return; }
      const from = gatewayLoginDestination(candidate, res.data?.tenant);
      if (!res.data?.mustChangePassword && from.split(/[?#]/)[0] === '/quickstart') {
        audioTransferred.current = markQuickstartArrival(sound ? audio.current : null);
      }
      navigate(res.data?.mustChangePassword ? '/change-password' : from, { replace: true });
    } catch {
      if (mounted.current) setError('暂时无法连接，请稍后重试');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggleSound = () => {
    const enabled = !sound; setSound(enabled); audio.current?.setEnabled(enabled);
    try { localStorage.setItem('llmgw-entry-sound', enabled ? 'on' : 'off'); } catch { /* device preference only */ }
    if (enabled) { audio.current?.unlock(); audio.current?.play('verified'); } else audio.current?.stop();
  };
  return <div className="gateway-entry cinema-login gateway-login" data-phase={busy ? 'verifying' : 'idle'} data-sound={sound ? 'on' : 'off'}>
    <ConsciousnessScene stillLogin />
    <main className="cinema-login-center" aria-labelledby="llmgw-login-title">
      <div className="gateway-login-form">
        <h1 className="cinema-form-heading" id="llmgw-login-title">登录模型网关</h1>
        <p className="cinema-form-description">使用你的独立租户账号</p>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor="llmgw-username">用户名</label><input id="llmgw-username" autoComplete="username" placeholder="输入用户名" value={username} onChange={e => setUsername(e.target.value)} readOnly={busy} required />
          <label htmlFor="llmgw-password">密码</label><input id="llmgw-password" type="password" autoComplete="current-password" placeholder="输入密码" value={password} onChange={e => setPassword(e.target.value)} readOnly={busy} required />
          {error && <div className="gateway-login-message" role="alert">{error}</div>}
          {!error && sessionExpiredReason && <div className="gateway-login-message" role="status">{sessionExpiredReason === 'revoked' ? '账号权限已变更，请重新登录。' : '登录状态已过期，请重新登录。'}</div>}
          <button className="gateway-login-submit" type="submit" disabled={busy || !username.trim() || !password}>{busy ? '正在验证账号…' : '开始身份确认'}<ArrowRight size={15} /></button>
        </form>
        <details className="gateway-account-help"><summary>账号与登录帮助</summary><p>MAP 与 Gateway 账号相互独立。没有账号，请联系租户管理员；应用密钥不能登录控制台。</p></details>
        <div className="gateway-login-actions">
          <a className="gateway-back" href={resolveMapHomeHref()}><ArrowLeft size={14} />返回 MAP</a>
          <button className="gateway-sound" type="button" aria-pressed={sound} onClick={toggleSound} aria-label={sound ? '关闭进入音效' : '开启进入音效'}>
            {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        </div>
      </div>
      <p className="gateway-login-service" role="status">{busy ? '正在验证账号…' : ''}</p>
    </main>
  </div>;
}
