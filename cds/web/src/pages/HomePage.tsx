/*
 * HomePage — CDS 落地页(2026-07-02 由"单屏 demo"升级为多分区滚动叙事)。
 *
 * 结构对标 Railway 落地页骨架:
 *   sticky nav → hero(文案 + 实况 board) → 分隔字条 → Workflow 三步
 *   → 产品事实带 → Features bento → Observability 实况终端
 *   → Final CTA → 页脚
 *
 * 纪律:内容全部来自 CDS 已文档化的真实能力(不编造用户数/star 数);
 * 品牌橙只用于"活着的东西"(状态点/数据流/光束);所有滚动显现与打字动效
 * 在 prefers-reduced-motion 下降级为静态。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { ShinyText } from '@/components/effects/ShinyText';
import { CdsGem } from '@/components/brand/CdsGem';
import { fetchSessionAuthed } from '@/lib/api';
import './HomePage.css';

const FEED_LINES = [
  'pull origin feature/auth-flow · 3 commits',
  'detect stack · .NET 8 + React + mongo + redis',
  'build api :5000 · admin :5500 ......  ok',
  'container.observed · health checks passing',
  'preview live · auth-flow-prd-agent.miduo.org',
];

/* Observability 段的实况部署终端脚本(节选自真实构建输出的形态)。 */
const OBS_LINES: Array<{ ts: string; text: string; kind?: 'ok' | 'url' }> = [
  { ts: '12:04:01', text: 'git pull origin feature/auth-flow · 3 commits' },
  { ts: '12:04:03', text: 'detect stack · .NET 8 + React + mongo + redis' },
  { ts: '12:04:04', text: 'build profile · api :5000 · admin :5500' },
  { ts: '12:04:29', text: 'docker build api ............ done (25.1s)', kind: 'ok' },
  { ts: '12:04:47', text: 'docker build admin .......... done (17.4s)', kind: 'ok' },
  { ts: '12:04:52', text: 'network up · mongo replica · redis cache' },
  { ts: '12:05:08', text: 'containers started · 4/4 running' },
  { ts: '12:05:20', text: 'health checks ............... passing', kind: 'ok' },
  { ts: '12:05:21', text: 'check-run → GitHub PR · CDS Deploy: success', kind: 'ok' },
  { ts: '12:05:22', text: 'auth-flow-prd-agent.miduo.org', kind: 'url' },
];

/* Bento A 格的迷你构建日志。 */
const BUILD_LINES = [
  '$ cds build feature/auth-flow',
  'detect stack · .NET 8 + React',
  'restore · compile · publish ... ok',
  'vite build · 2.31s · 412 modules',
  'image api:auth-flow · 214 MB',
  'health probe :5000/health · 200',
];

const BranchIcon = (props: { className?: string }) => (
  <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="9" r="2.4" />
    <path d="M6 8.4v7.2M8.2 7.2 16 8.6M18 11.2c0 4-4 4.4-8.4 4.6" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

/* 单例 IntersectionObserver:所有 .cdsh-reveal 进入视口加 .is-in 后即释放。 */
function useRevealOnScroll(): void {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('.cdsh-reveal'));
    if (els.length === 0) return undefined;
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.16, rootMargin: '0px 0px -40px 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/*
 * 进入视口后逐行"打出"日志:每 stepMs 一行,播完 hold 若干拍后清空重播。
 * reduced-motion:直接静态全量渲染,不循环。
 */
function useTypedLines(total: number, stepMs: number, holdTicks: number): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTick(total);
      return undefined;
    }
    let timer: number | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        io.disconnect();
        timer = window.setInterval(() => setTick((t) => t + 1), stepMs);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [total, stepMs]);
  const cycle = total + holdTicks;
  const shown = tick <= total ? tick : Math.min(tick % cycle, total);
  return [ref, shown];
}

/* 卡片鼠标跟随高光:相对坐标写入 --mx/--my(直接改 style,不走 setState)。 */
function trackPointer(event: React.PointerEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

function DeployTerminal(): JSX.Element {
  const [ref, shown] = useTypedLines(OBS_LINES.length, 420, 14);
  const done = shown === OBS_LINES.length;
  return (
    <div ref={ref} className={`cdsh-term${done ? ' is-done' : ''}`}>
      <div className="cdsh-term-head">
        <span className="cdsh-term-dots" aria-hidden><i /><i /><i /></span>
        <span className="cdsh-mono">cds · deploy feature/auth-flow</span>
        <span className="cdsh-live" style={{ marginLeft: 'auto' }}><span className="cdsh-pulse" />live</span>
      </div>
      <div className="cdsh-term-body cdsh-mono" role="log">
        {OBS_LINES.slice(0, shown).map((line, idx) => (
          <div key={idx} className={`cdsh-term-line${line.kind ? ` is-${line.kind}` : ''}`}>
            <span className="cdsh-term-ts">{line.ts}</span>
            {line.kind === 'url' ? (
              <span className="cdsh-term-url">
                <span className="cdsh-pulse" />
                {line.text}
              </span>
            ) : (
              <span>{line.text}</span>
            )}
          </div>
        ))}
        {!done ? <span className="cdsh-caret" aria-hidden /> : null}
      </div>
    </div>
  );
}

function BuildLogCell(): JSX.Element {
  const [ref, shown] = useTypedLines(BUILD_LINES.length, 700, 6);
  return (
    <div ref={ref} className="cdsh-bento-log cdsh-mono">
      {BUILD_LINES.slice(0, shown).map((line, idx) => (
        <div key={idx} className={`cdsh-term-line${idx === 0 ? ' is-cmd' : ''}`}>{line}</div>
      ))}
      {shown < BUILD_LINES.length ? <span className="cdsh-caret" aria-hidden /> : null}
    </div>
  );
}

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const [feedIndex, setFeedIndex] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  // 后台探测一次「当前会话 cookie 是否仍有效」。承诺在按钮点击前未必返回,
  // 所以 enterConsole() 会 await 这个共享 promise 再决定:已登录直接进控制台,
  // 未登录跳全站唯一登录面 /login。probeRef 缓存唯一的探测 promise。
  const authedRef = useRef<boolean | null>(null);
  const probeRef = useRef<Promise<boolean> | null>(null);

  useRevealOnScroll();

  function ensureProbe(): Promise<boolean> {
    if (!probeRef.current) {
      probeRef.current = fetchSessionAuthed().then((ok) => {
        authedRef.current = ok;
        return ok;
      });
    }
    return probeRef.current;
  }

  useEffect(() => {
    const preload = () => {
      void import('@/pages/LoginPage');
      void import('@/pages/ProjectListPage');
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (typeof ric === 'function') ric(preload);
    else window.setTimeout(preload, 200);
    void ensureProbe();
    // ensureProbe 用 ref 缓存,本 effect 仅运行一次,无需依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // nav 滚动吸附态(rAF 节流)。
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrolled(window.scrollY > 8);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  async function enterConsole() {
    if (authedRef.current === true) {
      navigate('/project-list', { viewTransition: true });
      return;
    }
    if (authedRef.current === false) {
      navigate('/login?redirect=/project-list', { viewTransition: true });
      return;
    }
    const ok = await ensureProbe();
    if (ok) navigate('/project-list', { viewTransition: true });
    else navigate('/login?redirect=/project-list', { viewTransition: true });
  }

  function openAccessMode() {
    void enterConsole();
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFeedIndex((i) => (i + 1) % FEED_LINES.length);
    }, 2600);
    return () => clearInterval(timer);
  }, []);

  const goAnchor = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <main className="cdsh-root">
      <div className="cdsh-bg">
        <ShapeGrid
          className="cdsh-shapegrid"
          shape="hexagon"
          direction="diagonal"
          speed={0.49}
          squareSize={34}
          hoverTrailAmount={15}
          borderColor="rgba(255,255,255,0.09)"
          hoverFillColor="rgba(255,255,255,0.05)"
        />
        <div className="cdsh-vignette" />
      </div>

      {/* NAV — sticky,滚动后加玻璃吸附态 */}
      <div className={`cdsh-navbar${scrolled ? ' is-scrolled' : ''}`}>
        <div className="cdsh-wrap">
          <nav className="cdsh-nav cdsh-rise" style={{ animationDelay: '0s' }}>
            <Link className="cdsh-brand" to="/">
              <span className="cdsh-logo">
                <CdsGem mode="brand" detail="simple" className="h-[26px] w-[26px]" />
              </span>
              <b>Cloud Dev Suite</b>
            </Link>
            <div className="cdsh-navlinks">
              <a href="#workflow" onClick={goAnchor('workflow')}>Workflow</a>
              <a href="#features" onClick={goAnchor('features')}>Features</a>
              <a href="#observability" onClick={goAnchor('observability')}>Observability</a>
              <Link to="/project-list" viewTransition>Console</Link>
            </div>
            <div className="cdsh-navcta">
              <button className="cdsh-btn cdsh-btn-ghost" type="button" onClick={openAccessMode}>Log in</button>
              <button className="cdsh-btn cdsh-btn-primary" type="button" onClick={openAccessMode}>
                Enter Console
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
          </nav>
        </div>
      </div>

      <div className="cdsh-wrap">
        {/* HERO */}
        <section className="cdsh-hero">
          <div>
            <span className="cdsh-eyebrow cdsh-rise" style={{ animationDelay: '.05s' }}>
              <span className="cdsh-dot" />Controlled cloud runtime
            </span>
            <h1 className="cdsh-h1">
              <span className="cdsh-line"><span>Every branch,</span></span>
              <span className="cdsh-line"><span className="cdsh-sheen">a live stack.</span></span>
            </h1>
            <p className="cdsh-sub cdsh-rise" style={{ animationDelay: '.35s' }}>
              CDS turns a Git branch into an isolated, observable runtime — build, containers, logs,
              webhooks and a preview URL — without ever breaking the control plane.
            </p>
            <div className="cdsh-cta cdsh-rise" style={{ animationDelay: '.45s' }}>
              <button className="cdsh-btn cdsh-btn-primary cdsh-btn-lg" type="button" onClick={openAccessMode}>
                Enter Console
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
              <button className="cdsh-btn cdsh-btn-ghost cdsh-btn-lg" type="button" onClick={openAccessMode}>System Access</button>
            </div>
            <div className="cdsh-meta-row cdsh-rise" style={{ animationDelay: '.55s' }}>
              <span className="cdsh-meta">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" /></svg>
                Same-origin sessions
              </span>
              <span className="cdsh-meta">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12h4l3 8 4-16 3 8h2" /></svg>
                Push to deploy, recover on demand
              </span>
            </div>
          </div>

          {/* BOARD — 鼠标跟随边框高光(--mx/--my 由 trackPointer 写入) */}
          <div className="cdsh-board cdsh-rise" style={{ animationDelay: '.3s' }} onPointerMove={trackPointer}>
            <div className="cdsh-board-head">
              <div className="cdsh-left">
                <BranchIcon />
                <span className="cdsh-branch cdsh-mono">feature/auth-flow</span>
                <span className="cdsh-tag cdsh-mono">prd-agent</span>
              </div>
              <span className="cdsh-live"><span className="cdsh-pulse" />live</span>
            </div>

            <div className="cdsh-canvas">
              <svg className="cdsh-wires" viewBox="0 0 1000 640" preserveAspectRatio="none">
                <path id="cdsh-p1" className="cdsh-wire" style={{ animationDelay: '.7s' }} d="M320 246 H348 V144 H360" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '.7s' }} d="M320 246 H348 V144 H360" />
                <path id="cdsh-p2" className="cdsh-wire" style={{ animationDelay: '.9s' }} d="M320 246 H348 V361 H360" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '.9s' }} d="M320 246 H348 V361 H360" />
                <path id="cdsh-p3" className="cdsh-wire" style={{ animationDelay: '1.1s' }} d="M640 144 H680" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.1s' }} d="M640 144 H680" />
                <path id="cdsh-p4" className="cdsh-wire" style={{ animationDelay: '1.3s' }} d="M640 361 H680" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.3s' }} d="M640 361 H680" />
                <path id="cdsh-p5" className="cdsh-wire" style={{ animationDelay: '1.3s' }} d="M500 212 V294" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.3s' }} d="M500 212 V294" />
                <path id="cdsh-p6" className="cdsh-wire" style={{ animationDelay: '1.5s' }} d="M820 212 V294" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.5s' }} d="M820 212 V294" />
                <path id="cdsh-p7" className="cdsh-wire" style={{ animationDelay: '1.7s' }} d="M500 429 V499" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.7s' }} d="M500 429 V499" />
                <path id="cdsh-p8" className="cdsh-wire" style={{ animationDelay: '1.7s' }} d="M820 429 V470 H700 V499" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.7s' }} d="M820 429 V470 H700 V499" />

                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.5s" begin="1.0s" repeatCount="indefinite"><mpath href="#cdsh-p1" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.4s" begin="1.5s" repeatCount="indefinite"><mpath href="#cdsh-p3" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.4s" begin="1.6s" repeatCount="indefinite"><mpath href="#cdsh-p5" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="2.0s" repeatCount="indefinite"><mpath href="#cdsh-p7" /></animateMotion></circle>
              </svg>

              <div className="cdsh-node cdsh-node-glow" style={{ left: '2%', top: '28%', width: '30%', animationDelay: '.5s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><BranchIcon /></span>
                  <div><div className="cdsh-title">Branch</div><div className="cdsh-desc cdsh-mono">3 commits · pushed</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Build · profile detected</div>
              </div>

              <div className="cdsh-node" style={{ left: '36%', top: '12%', width: '28%', animationDelay: '.9s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>
                  <div><div className="cdsh-title">api</div><div className="cdsh-desc">.NET 8 service</div></div>
                  <span className="cdsh-port cdsh-mono">:5000</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '68%', top: '12%', width: '28%', animationDelay: '1.1s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg></span>
                  <div><div className="cdsh-title">admin</div><div className="cdsh-desc">React · Vite</div></div>
                  <span className="cdsh-port cdsh-mono">:5500</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '36%', top: '46%', width: '28%', animationDelay: '1.3s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg></span>
                  <div><div className="cdsh-title">mongo</div><div className="cdsh-desc cdsh-mono">replica · 1</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '68%', top: '46%', width: '28%', animationDelay: '1.5s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6c0 1.7 4 3 9 3s9-1.3 9-3-4-3-9-3-9 1.3-9 3z" /><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" /></svg></span>
                  <div><div className="cdsh-title">redis</div><div className="cdsh-desc cdsh-mono">cache</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Healthy</div>
              </div>

              <div className="cdsh-preview" style={{ animationDelay: '2.1s' }}>
                <span className="cdsh-pv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" /></svg></span>
                <div>
                  <div className="cdsh-lbl">Preview · auto-assigned</div>
                  <div className="cdsh-url cdsh-mono">auth-flow-prd-agent.miduo.org</div>
                </div>
                <span className="cdsh-live" style={{ marginLeft: 'auto' }}><span className="cdsh-pulse" /></span>
              </div>
            </div>

            <p className="cdsh-ticker cdsh-mono">
              <span className="cdsh-k">cds</span>&nbsp;&gt;&nbsp;
              <span className="cdsh-feed" key={feedIndex}>{FEED_LINES[feedIndex]}</span>
              <span className="cdsh-caret" aria-hidden />
            </p>
          </div>
        </section>

        {/* 分隔字条 — hero 蜂窝渐隐区与叙事区的视觉焊缝 */}
        <section className="cdsh-strip cdsh-rise" style={{ animationDelay: '.7s' }}>
          <p>One control plane for the whole stack</p>
        </section>

        {/* WORKFLOW — Push. Build. Preview. */}
        <section id="workflow" className="cdsh-section cdsh-reveal">
          <div className="cdsh-sec-head">
            <span className="cdsh-sec-eyebrow">Workflow</span>
            <h2 className="cdsh-sec-title">Push. Build. Preview.</h2>
            <p className="cdsh-sec-sub">从 git push 到可访问的在线环境，全程无人值守。</p>
          </div>
          <div className="cdsh-flow">
            <div className="cdsh-flow-card cdsh-reveal" style={{ transitionDelay: '0ms' }}>
              <span className="cdsh-flow-badge cdsh-mono">01</span>
              <h3>Push</h3>
              <p>推一个分支，GitHub webhook 即刻唤醒 CDS，无需任何手动操作。</p>
              <div className="cdsh-flow-visual cdsh-mono">
                <div className="cdsh-term-line is-cmd">$ git push origin feature/auth-flow</div>
                <span className="cdsh-flow-chip">
                  <CheckIcon />
                  webhook received
                </span>
              </div>
            </div>
            <div className="cdsh-flow-card cdsh-reveal" style={{ transitionDelay: '70ms' }}>
              <span className="cdsh-flow-badge cdsh-mono">02</span>
              <h3>Build</h3>
              <p>自动识别技术栈，构建镜像并启动隔离的分支运行时。</p>
              <div className="cdsh-flow-visual cdsh-mono">
                <div className="cdsh-term-line">detect stack · .NET 8 + React</div>
                <div className="cdsh-term-line">build api :5000 · admin :5500 ... ok</div>
                <div className="cdsh-term-line is-ok">health checks passing</div>
              </div>
            </div>
            <div className="cdsh-flow-card cdsh-reveal" style={{ transitionDelay: '140ms' }}>
              <span className="cdsh-flow-badge cdsh-mono">03</span>
              <h3>Preview</h3>
              <p>专属预览域名分钟级就绪，打开即验收，评论区自动回帖。</p>
              <div className="cdsh-flow-visual">
                <span className="cdsh-flow-url cdsh-mono">
                  <span className="cdsh-pulse" />
                  auth-flow-prd-agent.miduo.org
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 产品事实带 — 全部来自已文档化的真实能力 */}
        <div className="cdsh-facts cdsh-reveal">
          <div className="cdsh-fact" style={{ transitionDelay: '0ms' }}>
            <div className="cdsh-fact-num cdsh-mono"><em>1</em> 条命令</div>
            <div className="cdsh-fact-sub">启动整套控制面 · ./exec_cds.sh start</div>
          </div>
          <div className="cdsh-fact" style={{ transitionDelay: '70ms' }}>
            <div className="cdsh-fact-num cdsh-mono"><em>8</em> 种技术栈</div>
            <div className="cdsh-fact-sub">自动识别 · .NET / Node / Go / Rust …</div>
          </div>
          <div className="cdsh-fact" style={{ transitionDelay: '140ms' }}>
            <div className="cdsh-fact-num cdsh-mono"><em>2-5</em> 分钟</div>
            <div className="cdsh-fact-sub">push 到预览就绪 · webhook 自动部署</div>
          </div>
          <div className="cdsh-fact" style={{ transitionDelay: '210ms' }}>
            <div className="cdsh-fact-num cdsh-mono"><em>1</em> 分支 <em>1</em> 域名</div>
            <div className="cdsh-fact-sub">独立预览地址 · 互不干扰</div>
          </div>
        </div>

        {/* FEATURES — bento 网格,素材全部是真实能力 */}
        <section id="features" className="cdsh-section cdsh-reveal">
          <div className="cdsh-sec-head">
            <span className="cdsh-sec-eyebrow">Features</span>
            <h2 className="cdsh-sec-title">The whole runtime, in one plane.</h2>
            <p className="cdsh-sec-sub">构建、隔离、观测、恢复——分支预览需要的一切，都在一块控制面里。</p>
          </div>
          <div className="cdsh-bento">
            <div className="cdsh-bento-card cdsh-bento-a cdsh-reveal" style={{ transitionDelay: '0ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-head cdsh-mono">build · feature/auth-flow</div>
              <BuildLogCell />
              <h3>实时构建日志</h3>
              <p>每一步构建输出实时回传，失败当场可见，不用翻服务器。</p>
            </div>
            <div className="cdsh-bento-card cdsh-reveal" style={{ transitionDelay: '70ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-nodes">
                <span className="cdsh-bento-node cdsh-mono">api<i /></span>
                <span className="cdsh-bento-node cdsh-mono">mongo<i /></span>
                <span className="cdsh-bento-node cdsh-mono">redis<i /></span>
              </div>
              <h3>隔离分支运行时</h3>
              <p>每个分支一套独立网络与容器组，互不污染。</p>
            </div>
            <div className="cdsh-bento-card cdsh-reveal" style={{ transitionDelay: '140ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-url cdsh-mono">
                <em>{'{tail}'}</em>-<span>{'{prefix}'}</span>-<span className="dim">{'{project}'}</span>.miduo.org
              </div>
              <h3>Per-branch 预览域名</h3>
              <p>分支名即地址，重要的信息永远排在最前。</p>
            </div>
            <div className="cdsh-bento-card cdsh-reveal" style={{ transitionDelay: '210ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-checks">
                <span><CheckIcon />CDS Build · passed</span>
                <span><CheckIcon />CDS Deploy · passed</span>
                <span><CheckIcon />Preview · ready</span>
              </div>
              <h3>PR Checks 回传</h3>
              <p>构建状态实时写回 GitHub PR，评论区拿到预览直达链。</p>
            </div>
            <div className="cdsh-bento-card cdsh-reveal" style={{ transitionDelay: '280ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-mono cdsh-mono">
                <div className="cdsh-term-line is-cmd">POST /api/factory-reset</div>
                <div className="cdsh-term-line is-ok">runtime restored · 12s</div>
              </div>
              <h3>一键恢复</h3>
              <p>控制面出问题？复活接口把系统拉回可用态。</p>
            </div>
            <div className="cdsh-bento-card cdsh-reveal" style={{ transitionDelay: '350ms' }} onPointerMove={trackPointer}>
              <div className="cdsh-bento-agent">
                <span><i />列出远程分支<b className="cdsh-mono">2s</b></span>
                <span><i />部署分支<b className="cdsh-mono">14s</b></span>
                <span><i />获取容器日志<b className="cdsh-mono">31s</b></span>
              </div>
              <h3>Agent 请求观测台</h3>
              <p>AI 对系统的每一次调用都有可读的中文回执，实时可查。</p>
            </div>
          </div>
        </section>

        {/* OBSERVABILITY — sticky 叙事 + 实况部署终端 */}
        <section id="observability" className="cdsh-section cdsh-reveal">
          <div className="cdsh-obs">
            <div className="cdsh-obs-copy">
              <span className="cdsh-sec-eyebrow">Observability</span>
              <h2 className="cdsh-sec-title">From push to reachable,<br />every step observable.</h2>
              <p className="cdsh-sec-sub">部署不是黑盒。构建、容器、健康检查——每一步都在你眼前发生。</p>
              <ul className="cdsh-obs-points">
                <li><span className="cdsh-obs-check"><CheckIcon /></span>构建日志实时回传，逐行可读</li>
                <li><span className="cdsh-obs-check"><CheckIcon /></span>容器健康持续探测，异常即刻可见</li>
                <li><span className="cdsh-obs-check"><CheckIcon /></span>Agent 的每次 API 调用都有中文回执</li>
              </ul>
            </div>
            <DeployTerminal />
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="cdsh-final cdsh-reveal">
          <h2 className="cdsh-final-title">
            <ShinyText
              text="Every branch, ready to ship."
              speed={3}
              spread={110}
              color="#9a9aa4"
              shineColor="#fff7ee"
            />
          </h2>
          <p className="cdsh-final-sub">打开控制台，把下一个分支变成一套在线环境。</p>
          <div className="cdsh-cta" style={{ justifyContent: 'center' }}>
            <button className="cdsh-btn cdsh-btn-primary cdsh-btn-lg" type="button" onClick={openAccessMode}>
              Enter Console
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
            <button className="cdsh-btn cdsh-btn-ghost cdsh-btn-lg" type="button" onClick={openAccessMode}>System Access</button>
          </div>
        </section>
      </div>

      {/* FOOTER — 官网级页脚,全部真实内部链接 */}
      <footer className="cdsh-footer">
        <div className="cdsh-wrap">
          <div className="cdsh-footer-grid">
            <div className="cdsh-footer-brand">
              <div className="cdsh-brand">
                <CdsGem mode="brand" detail="simple" className="h-7 w-7" />
                <b>Cloud Dev Suite</b>
              </div>
              <p>Branch-native control plane for the whole stack.</p>
            </div>
            <div className="cdsh-footer-col">
              <h4>Product</h4>
              <Link to="/project-list" viewTransition>Console</Link>
              <Link to="/cds-settings" viewTransition>CDS Settings</Link>
              <Link to="/release-center" viewTransition>Release Center</Link>
              <Link to="/reports" viewTransition>Reports</Link>
            </div>
            <div className="cdsh-footer-col">
              <h4>Page</h4>
              <a href="#workflow" onClick={goAnchor('workflow')}>Workflow</a>
              <a href="#features" onClick={goAnchor('features')}>Features</a>
              <a href="#observability" onClick={goAnchor('observability')}>Observability</a>
            </div>
            <div className="cdsh-footer-col">
              <h4>System</h4>
              <Link to="/task-schedule" viewTransition>Task Schedule</Link>
              <Link to="/login" viewTransition>Log in</Link>
            </div>
          </div>
          <div className="cdsh-footer-base">
            <span className="cdsh-mono">Cloud Dev Suite — internal deploy control plane</span>
            <span>每个分支，都是一套在线环境</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
