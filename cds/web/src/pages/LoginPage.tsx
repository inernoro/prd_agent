/*
 * LoginPage — CDS 控制台的唯一认证入口。
 *
 * 设计哲学「一条线」(2026-07-04 v4,替换 v3 的拼贴式构图):
 *   CDS 的本质 = 你 push 一个分支,两分钟后它活了。
 *   于是整页只有一个视觉思想 —— 一条从 push 出发的部署光路,横贯页面,
 *   途经 push(0:00) → build(0:40) → live(2:00) 三个时间站点,终点没入
 *   登录卡:你的环境已经活了,登录领取。
 *   纪律:一块画布(无分屏无接缝)、一个光源、橙色只存在于这条线上(电流);
 *   不在线上的元素不许存在(星座/要点列表/双 vignette 已全部删除)。
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
import { CdsGem } from '@/components/brand/CdsGem';
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
        {/* 登录卡是品牌标的主舞台:一次性逐面组装入场,之后切面轮流闪辉 */}
        <CdsGem mode="brand" entrance className="h-10 w-10" />
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
 * TheLine — 页面唯一的视觉装置:一条横贯画布的部署光路。
 * 三个站点是用户故事的时间轴(0:00 push / 0:40 build / 2:00 live),
 * 一束橙色电流每 6.5s 走完一生,最后没入登录卡(线从卡下方穿过,
 * 视觉上"进门")。桌面(lg+)专属;reduced-motion 下电流静止为常亮段。
 */
const LINE_STATIONS = [
  { left: '7%', word: 'push', time: '0:00' },
  { left: '26%', word: 'build', time: '0:40' },
  { left: '45%', word: 'live', time: '2:00' },
];

function TheLine(): JSX.Element {
  return (
    <div className="cds-auth-line" aria-hidden>
      <span className="cds-auth-line-base" />
      <span className="cds-auth-line-beam" />
      {LINE_STATIONS.map((s, idx) => (
        <span key={s.word} className="cds-auth-station" style={{ left: s.left, animationDelay: `${idx * 0.9 + 0.35}s` }}>
          <i className="cds-auth-station-dot" />
          <b>{s.word}</b>
          <em>{s.time}</em>
        </span>
      ))}
    </div>
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
        <CdsGem className="h-10 w-10" />
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
  const { theme } = useTheme();
  // 'checking' = 正在探会话态;'anon' = 未登录,展示登录框。已登录则直接跳走,
  // 不会停留在此状态。探测期间用同轮廓骨架占位,避免先闪一下登录框再跳转。
  const [authPhase, setAuthPhase] = useState<'checking' | 'anon'>('checking');
  // 底部 ticker:线上正在发生的事(与首页 board 同一套语言)。
  const [feedIndex, setFeedIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setFeedIndex((i) => (i + 1) % FEED_LINES.length), 2600);
    return () => clearInterval(timer);
  }, []);

  // 暗场纹理:蜂窝压到阈下(0.032/0.055)——2026-07-04 用户反馈整体"像 2010",
  // 大面积几何壁纸是主要年代信号之一;保留质感但退出注意力。
  const grid = theme === 'dark'
    ? { border: 'rgba(255,255,255,0.032)', fill: 'rgba(255,255,255,0.02)' }
    : { border: 'rgba(68,45,22,0.055)', fill: 'rgba(68,45,22,0.03)' };

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
    <main className="cds-auth-page cds-grain">
      {/* 一块画布:暗场蜂窝(极弱) + 单一光源,没有分屏没有接缝。 */}
      <div className="cds-auth-bg" aria-hidden>
        <ShapeGrid
          key={theme}
          className="cds-auth-bg-grid"
          shape="hexagon"
          direction="diagonal"
          speed={0.3}
          squareSize={34}
          hoverTrailAmount={0}
          borderColor={grid.border}
          hoverFillColor={grid.fill}
        />
        <div className="cds-auth-backdrop" />
      </div>

      <header className="cds-auth-header">
        <Link to="/" className="cds-auth-brand" viewTransition>
          <CdsGem detail="simple" className="h-6 w-6" />
          <span>Cloud Dev Suite</span>
        </Link>
      </header>

      {/* 舞台:左侧用户故事,右侧终点站(登录卡),一条线横贯两者。 */}
      <section className="cds-auth-stage">
        <TheLine />
        <div className="cds-auth-copy">
          <p className="cds-auth-cmd">$ git push origin your-branch</p>
          <h1 className="cds-auth-display">
            <span>Push a branch.</span>
            <ShinyText
              text="Watch it come alive."
              speed={3.4}
              spread={112}
              color={theme === 'dark' ? 'rgba(226,226,235,0.58)' : 'rgba(92,64,38,0.55)'}
              shineColor={theme === 'dark' ? 'rgba(255,247,238,0.98)' : 'rgba(45,28,12,0.98)'}
              className="block"
            />
          </h1>
          <p className="cds-auth-story">
            构建、容器、日志、预览域名——大约两分钟，你推送的分支就是一套活的在线环境。登录，领取它。
          </p>
          <p className="cds-auth-timeline-compact" aria-hidden>
            push <span>·</span> build <span>·</span> live — ~2 min
          </p>
        </div>
        <div className="cds-auth-card-wrap cds-page-enter">
          {authPhase === 'checking' ? <AuthFormSkeleton /> : <AuthForm />}
        </div>
      </section>

      <footer className="cds-auth-footer">
        <p className="cds-auth-ticker" aria-hidden>
          <span className="cds-auth-ticker-k">cds</span>
          <span className="cds-auth-ticker-gt">&gt;</span>
          <span className="cds-auth-ticker-feed" key={feedIndex}>{FEED_LINES[feedIndex]}</span>
          <span className="cds-auth-ticker-caret" />
        </p>
        <span className="cds-auth-footer-tag">每个分支，都是一套在线环境</span>
      </footer>
    </main>
  );
}
