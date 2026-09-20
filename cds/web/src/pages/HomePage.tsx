/*
 * HomePage — CDS 落地页(2026-07-02 由"单屏 demo"升级为多分区滚动叙事)。
 *
 * 结构（2026-09-16 第二屏起改为滚动叙事）:
 *   sticky nav → hero(文案 + 实况 board)
 *   → Branchline 叙事区:一条分支线贯穿、镜头沿线推进,五章 Push / Build / Preview / Observe / Ship
 *     各发生一件事(脉冲、容器弹出、域名转绿、集群抬升、收束),文案 sticky 在视口里随进度淡入淡出
 *   → 页脚
 * 参照 Corn Revolution 的连续场景语法:没有"屏",只有镜头在一个东西上的停留。
 *
 * 纪律:内容全部来自 CDS 已文档化的真实能力(不编造用户数/star 数);
 * 品牌橙只用于"活着的东西"(状态点/数据流/光束);所有滚动显现与打字动效
 * 在 prefers-reduced-motion 下降级为静态。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ShapeGrid from '@/components/effects/ShapeGrid';
// 叙事场景（three + postprocessing，约 690 kB）不进首页主链路：滚到叙事区才下载；场景自己再等进入视口才建 WebGL
const BranchlineScene = lazy(() => import('@/components/effects/BranchlineScene'));
import { CdsGem } from '@/components/brand/CdsGem';
import { fetchSessionAuthed } from '@/lib/api';
import './HomePage.css';

const FEED_LINES = [
  'pull origin feature/auth-flow · 3 commits',
  'detect stack · .NET 8 + React + mongo + redis',
  'build api :5000 · admin :5500 ......  ok',
  'container.observed · health checks passing',
  'preview live · auth-flow.example.test',
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

/* 卡片鼠标跟随高光:相对坐标写入 --mx/--my(直接改 style,不走 setState)。 */
function trackPointer(event: React.PointerEvent<HTMLElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

/*
 * 叙事区五章。顺序就是真实流程(push → build → preview → observe → ship),
 * 所以进度轨上的编号是信息不是装饰。id 沿用顶栏锚点(workflow / features / observability)。
 */
const STORY: Array<{
  id: string; rail: string; eyebrow: string; side: 'left' | 'right' | 'center';
  title: JSX.Element; sub: string; extra?: JSX.Element;
}> = [
  {
    id: 'workflow', rail: '01 Push', eyebrow: '01 · Push', side: 'left',
    title: <>一次 push，<br />控制面就<em>醒了</em>。</>,
    sub: 'GitHub webhook 即刻唤醒 CDS。不用登录面板，不用点部署——那道亮光就是你的提交在往前跑。',
    extra: (
      <div className="cdsh-ch-term cdsh-mono">
        <span className="is-cmd">git push origin feature/auth-flow</span>
        <span className="is-ok"><CheckIcon />webhook received · 38 ms</span>
      </div>
    ),
  },
  {
    id: 'features', rail: '02 Build', eyebrow: '02 · Build', side: 'left',
    title: <>容器在分支旁边<br /><em>长出来</em>。</>,
    sub: '自动识别技术栈、构建镜像，一套隔离的运行时围着这次提交成形：api、admin、mongo、redis，各归各位。',
    extra: (
      <div className="cdsh-ch-term cdsh-mono">
        <span>detect stack · .NET 8 + React</span>
        <span>build api :5000 · admin :5500 … ok</span>
        <span className="is-ok"><CheckIcon />health checks passing</span>
      </div>
    ),
  },
  {
    id: 'preview', rail: '03 Preview', eyebrow: '03 · Preview', side: 'left',
    title: <>分钟级，一个只属于<br />这条分支的<em>域名</em>。</>,
    sub: '健康检查转绿的那一刻，预览地址就能打开；构建状态同时写回 PR，评论区拿到直达链。',
    extra: (
      <div className="cdsh-ch-chips">
        <span className="cdsh-ch-chip cdsh-mono"><i /><b>auth-flow.example.test</b>ready</span>
        <span className="cdsh-ch-chip cdsh-mono">CDS Deploy · <b>passed</b></span>
      </div>
    ),
  },
  {
    id: 'observability', rail: '04 Observe', eyebrow: '04 · Observe', side: 'right',
    title: <>退后一步，<br />整个集群都在<em>眼前</em>。</>,
    sub: '每条分支一套独立运行时，互不污染。构建日志、容器健康、Agent 的每次调用回执——全部实时可读，不用翻服务器。',
    extra: (
      <div className="cdsh-ch-chips">
        <span className="cdsh-ch-chip cdsh-mono"><b>1</b>分支<b>1</b>域名</span>
        <span className="cdsh-ch-chip cdsh-mono"><b>8</b>种技术栈自动识别</span>
        <span className="cdsh-ch-chip cdsh-mono"><i />health checks live</span>
      </div>
    ),
  },
  {
    id: 'ship', rail: '05 Ship', eyebrow: '05 · Ship', side: 'center',
    title: <>Every branch,<br />ready to <em>ship</em>.</>,
    sub: '打开控制台，把下一个分支变成一套在线环境。',
  },
];

function BranchlineStory({ onEnter }: { onEnter: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  // 访客第一次滚动才挂载场景：lazy 只拆包，挂载即下载；停在 hero 不动的访客连那 690 kB 都不该下。
  // 不用 IntersectionObserver 看叙事区自己——它被 -22vh 负外边距顶进首屏，桌面首帧就已经「相交」，门等于没关
  // （Codex 2026-09-20 第四轮）。带锚点 / 刷新恢复滚动位置进来的（scrollY 已 > 0）立即挂载。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (window.scrollY > 0) { setArmed(true); return undefined; }
    const arm = () => setArmed(true);
    window.addEventListener('scroll', arm, { once: true, passive: true });
    return () => window.removeEventListener('scroll', arm);
  }, []);
  return (
    <div className="cdsh-story" ref={rootRef}>
      <div className="cdsh-story-stage">
        <Suspense fallback={null}>{armed ? <BranchlineScene rootRef={rootRef} /> : null}</Suspense>
        <div className="cdsh-story-vignette" aria-hidden />
        <nav className="cdsh-rail" aria-label="章节">
          {STORY.map((c, i) => (
            <a key={c.id} href={`#${c.id}`} data-cdsh-rail={i}><i /><span>{c.rail}</span></a>
          ))}
        </nav>
      </div>
      <div className="cdsh-chapters">
        {STORY.map((c) => (
          <section key={c.id} id={c.id} className="cdsh-ch" data-side={c.side}>
            <div className="cdsh-ch-pin">
              <div className="cdsh-ch-copy" data-cdsh-chapter>
                <span className="cdsh-ch-eyebrow cdsh-mono">{c.eyebrow}</span>
                <h2 className="cdsh-ch-title">{c.title}</h2>
                <p className="cdsh-ch-sub">{c.sub}</p>
                {c.extra}
                {c.id === 'ship' ? (
                  <div className="cdsh-cta cdsh-ch-cta">
                    <button className="cdsh-btn cdsh-btn-primary cdsh-btn-lg" type="button" onClick={onEnter}>
                      Enter Console
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    </button>
                    <button className="cdsh-btn cdsh-btn-ghost cdsh-btn-lg" type="button" onClick={onEnter}>System Access</button>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/*
 * BranchGenesis — hero 的叙事开场:一根 main 主干拉出、三个 commit 落点,
 * 一条橙色分支 fork 出去,电流沿「main → fork」注入下方的环境板 ——
 * 这就是「分支,即环境」的字面演出。reduced-motion 下静态呈现、电流隐藏。
 */
function BranchGenesis(): JSX.Element {
  return (
    <div className="cdsh-genesis" aria-hidden>
      <svg viewBox="0 0 560 120" preserveAspectRatio="none">
        <path className="cdsh-gen-main" d="M8 30 H552" />
        <path className="cdsh-gen-fork" d="M226 30 C300 30 306 98 380 98 L548 98" />
        <circle className="cdsh-gen-commit" style={{ animationDelay: '1.15s' }} cx="86" cy="30" r="4.5" />
        <circle className="cdsh-gen-commit" style={{ animationDelay: '1.3s' }} cx="156" cy="30" r="4.5" />
        <circle className="cdsh-gen-commit" style={{ animationDelay: '1.45s' }} cx="226" cy="30" r="4.5" />
        <circle className="cdsh-gen-dock" cx="548" cy="98" r="5" />
        <path id="cdsh-gen-beam-path" d="M8 30 H226 C300 30 306 98 380 98 L548 98" fill="none" stroke="none" />
        <circle className="cdsh-gen-beam" r="3.2">
          <animateMotion dur="3.2s" begin="2.3s" repeatCount="indefinite">
            <mpath href="#cdsh-gen-beam-path" />
          </animateMotion>
        </circle>
      </svg>
      <span className="cdsh-gen-main-label cdsh-mono">main</span>
      <span className="cdsh-gen-label cdsh-mono">feature/your-branch</span>
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
      {/* 开机帷幕:中线一束橙光划过,画布从中线向上下裂开 —— 进场即「通电」。 */}
      <div className="cdsh-boot" aria-hidden>
        <span className="cdsh-boot-beam" />
        <span className="cdsh-boot-top" />
        <span className="cdsh-boot-bottom" />
      </div>
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
                <CdsGem mode="brand" detail="simple" className="h-[1.875rem] w-[1.875rem]" />
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
            <span className="cdsh-eyebrow cdsh-rise" style={{ animationDelay: '.4s' }}>
              <span className="cdsh-dot" />CDS · Branch-native runtime
            </span>
            <h1 className="cdsh-h1 cdsh-h1-cn">
              <span className="cdsh-line"><span>分支，即环境。</span></span>
            </h1>
            <div className="cdsh-h1-sub cdsh-line" aria-hidden>
              <span className="cdsh-sheen">Every branch, a live stack.</span>
            </div>
            <p className="cdsh-sub cdsh-rise" style={{ animationDelay: '.9s' }}>
              推一个分支，两分钟后它活了——构建、容器、日志、独立预览域名，全程无人值守。
              CDS 把每一个 Git 分支都变成一套隔离、可观测的在线环境。
            </p>
            <div className="cdsh-cta cdsh-rise" style={{ animationDelay: '1.0s' }}>
              <button className="cdsh-btn cdsh-btn-primary cdsh-btn-lg" type="button" onClick={openAccessMode}>
                Enter Console
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
              <button className="cdsh-btn cdsh-btn-ghost cdsh-btn-lg" type="button" onClick={openAccessMode}>System Access</button>
            </div>
            <div className="cdsh-meta-row cdsh-rise" style={{ animationDelay: '1.1s' }}>
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

          {/* STAGE — 分支诞生(git 图) + 环境板:主干拉出 → fork 分叉 → 电流沿分支注入环境。 */}
          <div className="cdsh-stage">
            <BranchGenesis />
          <div className="cdsh-board cdsh-rise" style={{ animationDelay: '1.9s' }} onPointerMove={trackPointer}>
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
                <path id="cdsh-p1" className="cdsh-wire" style={{ animationDelay: '2.3s' }} d="M320 246 H348 V144 H360" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '2.3s' }} d="M320 246 H348 V144 H360" />
                <path id="cdsh-p2" className="cdsh-wire" style={{ animationDelay: '2.5s' }} d="M320 246 H348 V361 H360" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '2.5s' }} d="M320 246 H348 V361 H360" />
                <path id="cdsh-p3" className="cdsh-wire" style={{ animationDelay: '2.7s' }} d="M640 144 H680" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '2.7s' }} d="M640 144 H680" />
                <path id="cdsh-p4" className="cdsh-wire" style={{ animationDelay: '2.9s' }} d="M640 361 H680" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '2.9s' }} d="M640 361 H680" />
                <path id="cdsh-p5" className="cdsh-wire" style={{ animationDelay: '2.9s' }} d="M500 212 V294" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '2.9s' }} d="M500 212 V294" />
                <path id="cdsh-p6" className="cdsh-wire" style={{ animationDelay: '3.1s' }} d="M820 212 V294" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '3.1s' }} d="M820 212 V294" />
                <path id="cdsh-p7" className="cdsh-wire" style={{ animationDelay: '3.3s' }} d="M500 429 V499" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '3.3s' }} d="M500 429 V499" />
                <path id="cdsh-p8" className="cdsh-wire" style={{ animationDelay: '3.3s' }} d="M820 429 V470 H700 V499" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '3.3s' }} d="M820 429 V470 H700 V499" />

                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.5s" begin="2.6s" repeatCount="indefinite"><mpath href="#cdsh-p1" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.4s" begin="3.1s" repeatCount="indefinite"><mpath href="#cdsh-p3" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.4s" begin="3.2s" repeatCount="indefinite"><mpath href="#cdsh-p5" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="3.6s" repeatCount="indefinite"><mpath href="#cdsh-p7" /></animateMotion></circle>
              </svg>

              <div className="cdsh-node cdsh-node-glow" style={{ left: '2%', top: '28%', width: '30%', animationDelay: '2.1s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><BranchIcon /></span>
                  <div><div className="cdsh-title">Branch</div><div className="cdsh-desc cdsh-mono">3 commits · pushed</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Build · profile detected</div>
              </div>

              <div className="cdsh-node" style={{ left: '36%', top: '12%', width: '28%', animationDelay: '2.5s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>
                  <div><div className="cdsh-title">api</div><div className="cdsh-desc">.NET 8 service</div></div>
                  <span className="cdsh-port cdsh-mono">:5000</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '68%', top: '12%', width: '28%', animationDelay: '2.7s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg></span>
                  <div><div className="cdsh-title">admin</div><div className="cdsh-desc">React · Vite</div></div>
                  <span className="cdsh-port cdsh-mono">:5500</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '36%', top: '46%', width: '28%', animationDelay: '2.9s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg></span>
                  <div><div className="cdsh-title">mongo</div><div className="cdsh-desc cdsh-mono">replica · 1</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '68%', top: '46%', width: '28%', animationDelay: '3.1s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6c0 1.7 4 3 9 3s9-1.3 9-3-4-3-9-3-9 1.3-9 3z" /><path d="M3 6v6c0 1.7 4 3 9 3s9-1.3 9-3V6M3 12v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" /></svg></span>
                  <div><div className="cdsh-title">redis</div><div className="cdsh-desc cdsh-mono">cache</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Healthy</div>
              </div>

              <div className="cdsh-preview" style={{ animationDelay: '3.6s' }}>
                <span className="cdsh-pv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" /></svg></span>
                <div>
                  <div className="cdsh-lbl">Preview · auto-assigned</div>
                  <div className="cdsh-url cdsh-mono">auth-flow.example.test</div>
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
          </div>
        </section>

      </div>

      <BranchlineStory onEnter={openAccessMode} />

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
