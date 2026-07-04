/*
 * LoginPage — CDS 控制台的唯一认证入口（2026-07-02 重做）。
 *
 * 设计：左右分屏。左侧是品牌视觉板（动态六边形网格 + 品牌叙事 + 实时部署
 * feed 流，与首页 hero 同一套视觉语言），右侧是克制的认证卡片。全部走
 * surface/hairline token，双主题自动翻转；<lg 收起视觉板，单列移动形态。
 *
 * 认证逻辑与旧版完全一致：
 *   - 会话探测：已登录直接跳 redirect 目标，不闪登录框
 *   - 首次启动 bootstrap：零用户时表单变身"创建系统所有者账号"
 *   - 本地登录双端点回退（/api/auth/login → 404 → /api/login）
 *   - GitHub OAuth 入口
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Github, Loader2 } from 'lucide-react';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { ShinyText } from '@/components/effects/ShinyText';
import { CdsMetallicLogo } from '@/components/brand/CdsMetallicLogo';
import { Button } from '@/components/ui/button';
import { apiUrl, fetchBootstrapStatus, bootstrapFirstUser, fetchSessionAuthed } from '@/lib/api';
import { useTheme } from '@/lib/theme';

/* 与首页 board ticker 同一套"活的控制面"语言,登录时就能看到系统在呼吸。 */
const FEED_LINES = [
  'pull origin feature/auth-flow · 3 commits',
  'detect stack · .NET 8 + React + mongo + redis',
  'build api :5000 · admin :5500 ......  ok',
  'container.observed · health checks passing',
  'preview live · auth-flow-prd-agent.miduo.org',
];

/* feed 每行对应点亮的星座节点(数据与画面同源:pull/detect 亮分支,
   build 亮服务,observed 亮数据层,live 亮预览域名)。 */
const LIVE_TARGETS: string[][] = [
  ['branch'],
  ['branch'],
  ['api', 'admin'],
  ['mongo', 'redis'],
  ['preview'],
];

function redirectTarget(): string {
  if (typeof window === 'undefined') return '/project-list';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect') || '/project-list';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/project-list';
  // 绝不把目标指回登录路由本身 —— 否则已登录用户从 /login 跳 /login 是 no-op,
  // spinner 永远转、登录框永不出现(Bugbot Medium「Login redirect target loops」)。
  const path = raw.split(/[?#]/)[0];
  if (path === '/login') return '/project-list';
  return raw;
}

function AuthForm(): JSX.Element {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 登录失败时卡片 shake 一次;onAnimationEnd 复位保证连续出错可重播。
  const [shake, setShake] = useState(false);
  // First-run bootstrap: when the system has zero users, the login form turns
  // into a "create the first system-owner account" form instead.
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapName, setBootstrapName] = useState('');
  const target = useMemo(() => redirectTarget(), []);
  const githubLoginHref = useMemo(() => apiUrl(`/api/auth/github/login?redirect=${encodeURIComponent(target)}`), [target]);

  useEffect(() => {
    let alive = true;
    fetchBootstrapStatus()
      .then((s) => { if (alive) setNeedsBootstrap(s.needsBootstrap); })
      .catch(() => { /* endpoint absent in non-github modes — ignore */ });
    return () => { alive = false; };
  }, []);

  function goToTarget() {
    // Legacy server 路径(/settings.html?project=… 等)必须 hard-load,让 Express
    // 的 legacy→React 重定向生效;干净的 React 路由走 SPA navigate + view transition。
    if (/\.html(?:$|[?#])/i.test(target)) {
      window.location.assign(target);
    } else {
      navigate(target, { replace: true, viewTransition: true });
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (needsBootstrap) {
        await bootstrapFirstUser({ username, password, name: bootstrapName || undefined });
        goToTarget();
        return;
      }
      // github-mode 本地登录端点优先;404 时回退 legacy basic-auth /api/login,
      // 保证单用户 CDS_USERNAME 部署仍可用。
      let res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 404) {
        res = await fetch(apiUrl('/api/login'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = typeof body?.error === 'string' ? body.error : '账号或密码不正确';
        throw new Error(message);
      }
      goToTarget();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShake(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={`cds-auth-card${shake ? ' cds-auth-card--shake' : ''}`}
      aria-busy={busy}
      onAnimationEnd={(event) => {
        if (event.animationName === 'cds-auth-shake') setShake(false);
      }}
    >
      <div className="cds-auth-mark" aria-hidden>
        <CdsMetallicLogo className="h-10 w-10" />
        <span className="cds-auth-secure">
          <span className="cds-auth-pulse" />
          same-origin · secure
        </span>
      </div>
      <h1 className="cds-auth-title">{needsBootstrap ? '创建管理员账号' : '登录 CDS 控制台'}</h1>
      <p className="cds-auth-sub">
        {needsBootstrap
          ? '首次启动：先创建系统所有者账号，随后直接进入控制台。'
          : '使用操作员账号进入分支预览控制台。'}
      </p>

      <div className="cds-auth-fields">
        <label className="cds-auth-field">
          <span>用户名</span>
          <input
            className="cds-auth-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            placeholder="操作员用户名"
          />
        </label>
        {needsBootstrap ? (
          <label className="cds-auth-field">
            <span>
              显示名称
              <em>可选</em>
            </span>
            <input
              className="cds-auth-input"
              value={bootstrapName}
              onChange={(event) => setBootstrapName(event.target.value)}
              autoComplete="name"
              placeholder="展示给团队成员的名字"
            />
          </label>
        ) : null}
        <label className="cds-auth-field">
          <span>密码</span>
          <span className="cds-auth-input-wrap">
            <input
              className="cds-auth-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
              required
              minLength={needsBootstrap ? 8 : undefined}
              placeholder={needsBootstrap ? '至少 8 位' : '密码'}
            />
            <button
              type="button"
              className="cds-auth-eye"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </button>
          </span>
        </label>
      </div>

      {error ? (
        <div className="cds-auth-error" role="alert">
          {error}
        </div>
      ) : null}

      <Button type="submit" disabled={busy} className="cds-auth-submit">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy
          ? (needsBootstrap ? '正在创建…' : '正在验证…')
          : (needsBootstrap ? '创建并进入控制台' : '登录')}
        {busy ? null : <ArrowRight className="h-4 w-4" />}
      </Button>

      {needsBootstrap ? null : (
        <>
          <div className="cds-auth-divider" aria-hidden>
            <span>或</span>
          </div>
          <Button asChild type="button" variant="outline" className="cds-auth-github">
            <a href={githubLoginHref}>
              <Github className="h-4 w-4" />
              使用 GitHub 登录
            </a>
          </Button>
        </>
      )}

      <p className="cds-auth-hint">同源会话 Cookie · 凭据不落本地存储</p>
    </form>
  );
}

/*
 * AuthVisualPanel — 左侧品牌视觉板(仅 lg+ 显示)。与首页 hero 同一套语言:
 * 六边形动网格打底、品牌大字带流光、要点列表、底部实时部署 feed 流。
 * 网格颜色按主题显式传入(canvas 无法解析 CSS var),theme 变化时 key 重建。
 */
function AuthVisualPanel(): JSX.Element {
  const { theme } = useTheme();
  const grid = theme === 'dark'
    ? { border: 'rgba(255,255,255,0.09)', fill: 'rgba(255,255,255,0.05)' }
    : { border: 'rgba(68,45,22,0.13)', fill: 'rgba(68,45,22,0.05)' };
  const shine = theme === 'dark'
    ? { color: 'rgba(226,226,235,0.58)', shineColor: 'rgba(255,255,255,0.98)' }
    : { color: 'rgba(92,64,38,0.55)', shineColor: 'rgba(45,28,12,0.98)' };

  const [feedIndex, setFeedIndex] = useState(0);
  const [feedOff, setFeedOff] = useState(false);
  useEffect(() => {
    let fadeTimer: number | undefined;
    const timer = window.setInterval(() => {
      setFeedOff(true);
      fadeTimer = window.setTimeout(() => {
        setFeedIndex((i) => (i + 1) % FEED_LINES.length);
        setFeedOff(false);
      }, 360);
    }, 2600);
    return () => {
      clearInterval(timer);
      if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    };
  }, []);

  const live = LIVE_TARGETS[feedIndex] ?? [];
  const liveCls = (key: string): string => `cds-authb-node${live.includes(key) ? ' is-live' : ''}`;

  return (
    <aside className="cds-auth-visual cds-grain" aria-hidden>
      <ShapeGrid
        key={theme}
        className="cds-auth-visual-grid"
        shape="hexagon"
        direction="diagonal"
        speed={0.42}
        squareSize={34}
        hoverTrailAmount={12}
        borderColor={grid.border}
        hoverFillColor={grid.fill}
      />
      <div className="cds-auth-visual-vignette" />
      {/* 中庭「运行时星座」:branch → api/admin → mongo/redis → preview,
          随底部 feed 逐站点亮。透视层 hover 归平,节点异相浮游。 */}
      <div className="cds-auth-scene">
        <div className="cds-auth-scene-inner">
          <svg className="cds-authb-wires" viewBox="0 0 1000 760" preserveAspectRatio="none">
            <path id="cds-authb-p1" className="cds-authb-wire" d="M300 273 H330 V120 H360" />
            <path className="cds-authb-wire-dash" d="M300 273 H330 V120 H360" />
            <path id="cds-authb-p2" className="cds-authb-wire" d="M300 273 H330 V395 H360" />
            <path className="cds-authb-wire-dash" d="M300 273 H330 V395 H360" />
            <path id="cds-authb-p3" className="cds-authb-wire" d="M650 120 H690" />
            <path className="cds-authb-wire-dash" d="M650 120 H690" />
            <path className="cds-authb-wire" d="M650 395 H690" />
            <path className="cds-authb-wire-dash" d="M650 395 H690" />
            <path id="cds-authb-p4" className="cds-authb-wire" d="M505 170 V348" />
            <path className="cds-authb-wire-dash" d="M505 170 V348" />
            <path className="cds-authb-wire" d="M835 170 V348" />
            <path className="cds-authb-wire-dash" d="M835 170 V348" />
            <path id="cds-authb-p5" className="cds-authb-wire" d="M505 445 V615" />
            <path className="cds-authb-wire-dash" d="M505 445 V615" />
            <path className="cds-authb-wire" d="M835 445 V585 H700 V615" />
            <path className="cds-authb-wire-dash" d="M835 445 V585 H700 V615" />
            <circle className="cds-authb-packet" r="2.6">
              <animateMotion dur="1.5s" begin="1.0s" repeatCount="indefinite"><mpath href="#cds-authb-p1" /></animateMotion>
            </circle>
            <circle className="cds-authb-packet" r="2.6">
              <animateMotion dur="1.4s" begin="1.5s" repeatCount="indefinite"><mpath href="#cds-authb-p3" /></animateMotion>
            </circle>
            <circle className="cds-authb-packet" r="2.6">
              <animateMotion dur="1.4s" begin="1.6s" repeatCount="indefinite"><mpath href="#cds-authb-p4" /></animateMotion>
            </circle>
            <circle className="cds-authb-packet" r="2.6">
              <animateMotion dur="1.6s" begin="2.0s" repeatCount="indefinite"><mpath href="#cds-authb-p5" /></animateMotion>
            </circle>
          </svg>

          <div className="cds-authb-float" style={{ left: '0%', top: '30%', width: '30%', animationDelay: '-1.3s' }}>
            <div className={liveCls('branch')} style={{ animationDelay: '.5s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="9" r="2.4" />
                    <path d="M6 8.4v7.2M8.2 7.2 16 8.6M18 11.2c0 4-4 4.4-8.4 4.6" />
                  </svg>
                </span>
                <div>
                  <div className="cds-authb-title">Branch</div>
                  <div className="cds-authb-desc">3 commits · pushed</div>
                </div>
              </div>
              <div className="cds-authb-status"><span className="cds-authb-sdot" />Build · profile detected</div>
            </div>
          </div>

          <div className="cds-authb-float" style={{ left: '36%', top: '10%', width: '29%', animationDelay: '-2.7s' }}>
            <div className={liveCls('api')} style={{ animationDelay: '.9s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
                </span>
                <div>
                  <div className="cds-authb-title">api</div>
                  <div className="cds-authb-desc">.NET 8 service</div>
                </div>
                <span className="cds-authb-port">:5000</span>
              </div>
              <div className="cds-authb-status"><span className="cds-authb-sdot" />Running · healthy</div>
            </div>
          </div>

          <div className="cds-authb-float" style={{ left: '69%', top: '10%', width: '29%', animationDelay: '-4.1s' }}>
            <div className={liveCls('admin')} style={{ animationDelay: '1.1s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>
                </span>
                <div>
                  <div className="cds-authb-title">admin</div>
                  <div className="cds-authb-desc">React · Vite</div>
                </div>
                <span className="cds-authb-port">:5500</span>
              </div>
              <div className="cds-authb-status"><span className="cds-authb-sdot" />Running · healthy</div>
            </div>
          </div>

          <div className="cds-authb-float" style={{ left: '36%', top: '46%', width: '29%', animationDelay: '-5.4s' }}>
            <div className={liveCls('mongo')} style={{ animationDelay: '1.3s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>
                </span>
                <div>
                  <div className="cds-authb-title">mongo</div>
                  <div className="cds-authb-desc">replica · 1</div>
                </div>
              </div>
              <div className="cds-authb-status"><span className="cds-authb-sdot" />Healthy</div>
            </div>
          </div>

          <div className="cds-authb-float" style={{ left: '69%', top: '46%', width: '29%', animationDelay: '-6s' }}>
            <div className={liveCls('redis')} style={{ animationDelay: '1.5s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6c0 1.7 4 3 9 3s9-1.3 9-3-4-3-9-3-9 1.3-9 3z" /><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" /></svg>
                </span>
                <div>
                  <div className="cds-authb-title">redis</div>
                  <div className="cds-authb-desc">cache</div>
                </div>
              </div>
              <div className="cds-authb-status"><span className="cds-authb-sdot" />Healthy</div>
            </div>
          </div>

          <div className="cds-authb-float" style={{ left: '22%', top: '81%', width: '58%', animationDelay: '-3.2s' }}>
            <div className={liveCls('preview')} style={{ animationDelay: '2.1s' }}>
              <div className="cds-authb-row">
                <span className="cds-authb-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" /></svg>
                </span>
                <div>
                  <div className="cds-authb-title">Preview · auto-assigned</div>
                  <div className="cds-authb-desc">auth-flow-prd-agent.miduo.org</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="cds-auth-visual-content">
        <Link to="/" className="cds-auth-visual-brand" viewTransition>
          <CdsMetallicLogo className="h-7 w-7" />
          <span>Cloud Dev Suite</span>
        </Link>
        <div className="cds-auth-visual-hero">
          <span className="cds-auth-visual-eyebrow">
            <span className="cds-auth-pulse" />
            Controlled cloud runtime
          </span>
          <h2 className="cds-auth-visual-title">
            <span>Every branch,</span>
            <ShinyText
              text="a live stack."
              speed={3.4}
              spread={112}
              color={shine.color}
              shineColor={shine.shineColor}
              className="block"
            />
          </h2>
          <p className="cds-auth-visual-sub">
            推送一个分支，得到一整套隔离的在线环境——构建、容器、日志、Webhook 与专属预览域名。
          </p>
          <ul className="cds-auth-visual-points">
            <li>
              <span className="cds-auth-dot" />
              同源会话 · 凭据不出控制面
            </li>
            <li>
              <span className="cds-auth-dot" />
              Push 即部署 · 分钟级预览就绪
            </li>
            <li>
              <span className="cds-auth-dot" />
              一键恢复 · 控制面永不离线
            </li>
          </ul>
        </div>
        <p className="cds-auth-visual-ticker">
          <span className="cds-auth-visual-ticker-k">cds</span>
          <span className="cds-auth-visual-ticker-gt">&gt;</span>
          <span className={feedOff ? 'cds-auth-visual-ticker-feed is-off' : 'cds-auth-visual-ticker-feed'}>
            {FEED_LINES[feedIndex]}
          </span>
        </p>
      </div>
    </aside>
  );
}

/*
 * 会话探测期间的占位:与真实表单同一副轮廓的骨架(产物形状的等待,
 * 不是居中 spinner),探测结束换成表单时零跳动。
 */
function AuthFormSkeleton(): JSX.Element {
  return (
    <div className="cds-auth-card" role="status" aria-label="正在检查会话">
      <div className="cds-auth-mark" aria-hidden>
        <CdsMetallicLogo className="h-10 w-10" />
      </div>
      <div className="cds-loading-skeleton-line h-6 w-44 max-w-full" />
      <div className="mt-2 cds-loading-skeleton-line h-4 w-64 max-w-full" />
      <div className="cds-auth-fields">
        <div className="cds-loading-skeleton-line h-10 w-full" />
        <div className="cds-loading-skeleton-line h-10 w-full" />
      </div>
      <div className="mt-5 cds-loading-skeleton-line h-10 w-full" />
    </div>
  );
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  // 'checking' = 正在探会话态;'anon' = 未登录,展示登录框。已登录则直接跳走,
  // 不会停留在此状态。探测期间用同轮廓骨架占位,避免先闪一下登录框再跳转。
  const [authPhase, setAuthPhase] = useState<'checking' | 'anon'>('checking');

  // 登录成功后要跳的内容页(默认控制台)是 lazy chunk:登录页一挂载就预取,
  // 提交成功 navigate 时不会触发 Suspense 白屏,配合 viewTransition 丝滑进内容页。
  useEffect(() => {
    void import('@/pages/ProjectListPage');
    void import('@/pages/HomePage');
  }, []);

  // 直接访问 /login 时,若会话 cookie 仍有效,跳过登录框直达目标页
  // (默认 /project-list,或 ?redirect= 指定的合法内部路径)。
  useEffect(() => {
    let alive = true;
    fetchSessionAuthed().then((ok) => {
      if (!alive) return;
      if (!ok) {
        setAuthPhase('anon');
        return;
      }
      const target = redirectTarget();
      // 兜底:若目标解析后仍等于当前路径,navigate 是 no-op,骨架会卡死 ——
      // 这种情况直接落到登录框(redirectTarget 已排除 /login,这里只是双保险)。
      if (target.split(/[?#]/)[0] === window.location.pathname) {
        setAuthPhase('anon');
        return;
      }
      if (/\.html(?:$|[?#])/i.test(target)) {
        // legacy server 路径:hard-load 让 Express 的 legacy→React 重定向生效。
        window.location.assign(target);
      } else {
        navigate(target, { replace: true, viewTransition: true });
      }
    });
    return () => {
      alive = false;
    };
  }, [navigate]);

  return (
    <main className="cds-auth-page">
      <AuthVisualPanel />
      <div className="cds-auth-side">
        <div className="cds-auth-backdrop" aria-hidden />
        <header className="cds-auth-header">
          <Link to="/" className="cds-auth-brand" viewTransition>
            <CdsMetallicLogo className="h-6 w-6" />
            <span>Cloud Dev Suite</span>
          </Link>
        </header>
        <section className="cds-auth-body">
          <div className="cds-auth-card-wrap cds-page-enter">
            {authPhase === 'checking' ? <AuthFormSkeleton /> : <AuthForm />}
          </div>
        </section>
        <footer className="cds-auth-footer">
          <span>Cloud Dev Suite</span>
          <span className="cds-auth-footer-dot" aria-hidden />
          <span>每个分支，都是一套在线环境</span>
        </footer>
      </div>
    </main>
  );
}
