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
import { ArrowRight, Github, Loader2 } from 'lucide-react';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="cds-auth-card" aria-busy={busy}>
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
          <input
            className="cds-auth-input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
            required
            minLength={needsBootstrap ? 8 : undefined}
            placeholder={needsBootstrap ? '至少 8 位' : '密码'}
          />
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

  return (
    <aside className="cds-auth-visual" aria-hidden>
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
