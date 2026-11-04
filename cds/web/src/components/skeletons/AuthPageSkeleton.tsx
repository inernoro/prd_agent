import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import ShapeGrid from '@/components/effects/ShapeGrid';
import { ShinyText } from '@/components/effects/ShinyText';
import { CdsGem } from '@/components/brand/CdsGem';
import { useTheme } from '@/lib/theme';

/* 与首页 board ticker 同一套"活的控制面"语言,登录时就能看到系统在呼吸。 */
const FEED_LINES = [
  'pull origin feature/auth-flow · 3 commits',
  'detect stack · .NET 8 + React + mongo + redis',
  'build api :5000 · admin :5500 ......  ok',
  'container.observed · health checks passing',
  'preview live · auth-flow.example.test',
];

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

/*
 * MobileLine — 「一条线」的手机形态:竖排三站时间轴 + 下落电流。
 * 桌面横贯光路(TheLine)在 <lg 隐藏后,手机曾只剩一行灰字,整页显得空;
 * 竖线把同一个视觉思想带进窄屏:结构、节奏、动效都还在,只是转了 90 度。
 */
const MOBILE_STATIONS = [
  { word: 'push', time: '0:00', desc: '推送你的分支' },
  { word: 'build', time: '0:40', desc: '构建镜像 · 启动容器' },
  { word: 'live', time: '2:00', desc: '预览域名就绪' },
];

function MobileLine(): JSX.Element {
  return (
    <div className="cds-auth-line-m" aria-hidden>
      <span className="cds-auth-line-m-beam" />
      {MOBILE_STATIONS.map((s) => (
        <div key={s.word} className="cds-auth-line-m-station">
          <i />
          <b>{s.word}</b>
          <em>{s.time}</em>
          <span>{s.desc}</span>
        </div>
      ))}
    </div>
  );
}

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
export function AuthFormSkeleton(): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setSlow(true), 6_000); return () => window.clearTimeout(timer); }, []);
  return <div className="cds-auth-card" data-auth-form-skeleton role="status" aria-busy="true" aria-label="正在检查会话">
    <div className="cds-auth-mark" aria-hidden><CdsGem className="h-10 w-10" /></div>
    <div className="cds-auth-title relative" aria-hidden>&nbsp;<span className="cds-loading-skeleton-line absolute inset-y-0 left-0 my-auto h-5 w-44 max-w-full" /></div>
    <div className="cds-auth-sub relative" aria-hidden>&nbsp;<span className="cds-loading-skeleton-line absolute inset-y-0 left-0 my-auto h-3 w-64 max-w-full" /></div>
    <div className="cds-auth-fields" aria-hidden>
      {[0, 1].map(i => <div className="cds-auth-field" key={i}>
        <span className="relative">&nbsp;<span className="cds-loading-skeleton-line absolute inset-y-0 left-0 my-auto h-2.5 w-16" /></span>
        <div className="cds-auth-input cds-loading-skeleton-line" />
      </div>)}
    </div>
    <div className="mt-5 cds-loading-skeleton-line h-10 w-full" aria-hidden />
    <p className="cds-auth-hint relative" aria-live="polite">&nbsp;{slow ? <span className="absolute inset-0">仍在读取…</span> : <span className="cds-loading-skeleton-line absolute inset-y-0 left-1/2 my-auto h-2.5 w-40 max-w-full -translate-x-1/2" aria-hidden />}</p>
  </div>;
}

export function AuthPageFrame({ children }: { children: ReactNode }): JSX.Element {
  const { theme, setTheme } = useTheme();
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
        {/* 未登录页也能切主题:白天形态是刻意设计过的,不该藏到登录后才被发现。 */}
        <button
          type="button"
          className="cds-auth-theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
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
          <div className="cds-auth-proof" aria-hidden>
            <span>构建隔离容器</span>
            <span>独立预览域名</span>
            <span>PR 状态回写</span>
          </div>
          <MobileLine />
        </div>
        <div className="cds-auth-card-wrap">
          {children}
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

export function AuthPageSkeleton(): JSX.Element {
  return <AuthPageFrame><AuthFormSkeleton /></AuthPageFrame>;
}
