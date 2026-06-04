import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './HomePage.css';

const FEED_LINES = [
  'pull origin feature/auth-flow · 3 commits',
  'detect stack · .NET 8 + React + mongo + redis',
  'build api :5000 · admin :5500 ......  ok',
  'container.observed · health checks passing',
  'preview live · auth-flow-prd-agent.miduo.org',
];

const BranchIcon = (props: { className?: string }) => (
  <svg className={props.className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="9" r="2.4" />
    <path d="M6 8.4v7.2M8.2 7.2 16 8.6M18 11.2c0 4-4 4.4-8.4 4.6" />
  </svg>
);

export function HomePage(): JSX.Element {
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
    <main className="cdsh-root">
      <div className="cdsh-bg">
        <div className="cdsh-aurora" />
        <div className="cdsh-hex" />
        <div className="cdsh-stars" />
        <div className="cdsh-glow" />
        <div className="cdsh-glow-2" />
        <div className="cdsh-vignette" />
      </div>

      <div className="cdsh-wrap">
        {/* NAV */}
        <nav className="cdsh-nav cdsh-rise" style={{ animationDelay: '0s' }}>
          <Link className="cdsh-brand" to="/">
            <span className="cdsh-logo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="2.4" /><path d="M12 2a10 10 0 0 0 0 20M2 12a10 10 0 0 0 20 0" />
              </svg>
            </span>
            <b>Cloud Dev Suite</b>
          </Link>
          <div className="cdsh-navlinks">
            <Link to="/project-list">Console</Link>
            <Link to="/project-list">Branches</Link>
            <Link to="/cds-settings">Settings</Link>
            <Link to="/login">Access</Link>
          </div>
          <div className="cdsh-navcta">
            <Link className="cdsh-btn cdsh-btn-ghost" to="/login">Log in</Link>
            <Link className="cdsh-btn cdsh-btn-primary" to="/login?redirect=%2Fproject-list">
              Enter Console
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          </div>
        </nav>

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
              <Link className="cdsh-btn cdsh-btn-primary cdsh-btn-lg" to="/login?redirect=%2Fproject-list">
                Enter Console
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </Link>
              <Link className="cdsh-btn cdsh-btn-ghost cdsh-btn-lg" to="/login">System Access</Link>
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

          {/* BOARD */}
          <div className="cdsh-board cdsh-rise" style={{ animationDelay: '.3s' }}>
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
                <path id="cdsh-p1" className="cdsh-wire" style={{ animationDelay: '.7s' }} d="M300 110 C 352 110, 352 150, 392 150" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '.7s' }} d="M300 110 C 352 110, 352 150, 392 150" />
                <path id="cdsh-p2" className="cdsh-wire" style={{ animationDelay: '1.1s' }} d="M648 150 C 702 150, 690 122, 720 122" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.1s' }} d="M648 150 C 702 150, 690 122, 720 122" />
                <path id="cdsh-p3" className="cdsh-wire" style={{ animationDelay: '1.1s' }} d="M510 196 C 510 250, 510 250, 510 300" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.1s' }} d="M510 196 C 510 250, 510 250, 510 300" />
                <path id="cdsh-p4" className="cdsh-wire" style={{ animationDelay: '1.5s' }} d="M838 168 C 838 240, 838 240, 838 300" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.5s' }} d="M838 168 C 838 240, 838 240, 838 300" />
                <path id="cdsh-p5" className="cdsh-wire" style={{ animationDelay: '1.9s' }} d="M510 392 C 510 470, 430 470, 430 512" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.9s' }} d="M510 392 C 510 470, 430 470, 430 512" />
                <path id="cdsh-p6" className="cdsh-wire" style={{ animationDelay: '1.9s' }} d="M838 392 C 838 470, 600 470, 600 512" />
                <path className="cdsh-wire-dash" style={{ animationDelay: '1.9s' }} d="M838 392 C 838 470, 600 470, 600 512" />

                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="0.9s" repeatCount="indefinite"><mpath href="#cdsh-p1" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="1.4s" repeatCount="indefinite"><mpath href="#cdsh-p2" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="1.5s" repeatCount="indefinite"><mpath href="#cdsh-p3" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.6s" begin="1.9s" repeatCount="indefinite"><mpath href="#cdsh-p4" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.7s" begin="2.2s" repeatCount="indefinite"><mpath href="#cdsh-p5" /></animateMotion></circle>
                <circle className="cdsh-packet" r="2.6"><animateMotion dur="1.7s" begin="2.3s" repeatCount="indefinite"><mpath href="#cdsh-p6" /></animateMotion></circle>
              </svg>

              <div className="cdsh-node cdsh-node-glow" style={{ left: '2.6%', top: '8%', width: '29%', animationDelay: '.5s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><BranchIcon /></span>
                  <div><div className="cdsh-title">Branch</div><div className="cdsh-desc cdsh-mono">3 commits · pushed</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Build · profile detected</div>
              </div>

              <div className="cdsh-node" style={{ left: '39.2%', top: '17%', width: '25.6%', animationDelay: '.9s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>
                  <div><div className="cdsh-title">api</div><div className="cdsh-desc">.NET 8 service</div></div>
                  <span className="cdsh-port cdsh-mono">:5000</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '72%', top: '11%', width: '25.6%', animationDelay: '1.1s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg></span>
                  <div><div className="cdsh-title">admin</div><div className="cdsh-desc">React · Vite</div></div>
                  <span className="cdsh-port cdsh-mono">:5500</span>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Running · healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '39.2%', top: '47%', width: '25.6%', animationDelay: '1.3s' }}>
                <div className="cdsh-row">
                  <span className="cdsh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg></span>
                  <div><div className="cdsh-title">mongo</div><div className="cdsh-desc cdsh-mono">replica · 1</div></div>
                </div>
                <div className="cdsh-status"><span className="cdsh-sdot" />Healthy</div>
              </div>

              <div className="cdsh-node" style={{ left: '72%', top: '47%', width: '25.6%', animationDelay: '1.5s' }}>
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
              <span className={`cdsh-feed${feedOff ? ' cdsh-off' : ''}`}>{FEED_LINES[feedIndex]}</span>
            </p>
          </div>
        </section>

        {/* STRIP */}
        <section className="cdsh-strip cdsh-rise" style={{ animationDelay: '.7s' }}>
          <p>One control plane for the whole stack</p>
          <div className="cdsh-chips">
            <span className="cdsh-chip"><b>Isolated</b> branch runtime</span>
            <span className="cdsh-chip"><b>Push</b> to deploy</span>
            <span className="cdsh-chip"><b>Live</b> logs &amp; metrics</span>
            <span className="cdsh-chip"><b>GitHub</b> webhooks</span>
            <span className="cdsh-chip"><b>One-click</b> recover</span>
            <span className="cdsh-chip"><b>Per-branch</b> preview URL</span>
          </div>
        </section>
      </div>
    </main>
  );
}
