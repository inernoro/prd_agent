import { useEffect } from 'react';

// 静态 mockup：划词评论头像气泡 5 种变体 + 提交后自动连线动画。
// 仅为评审样式而存在，不接现网逻辑。通过 React 路由暴露，避开 CDS 反代对 .html 的 strip。
const HTML = `
<style>
  .ic-mockup * { box-sizing: border-box; }
  .ic-mockup {
    --bg: #131314; --card: #1e1f20; --text: #e8e8ec; --muted: #8a8a8e;
    --border: rgba(255,255,255,0.08);
    --thread-a: #c084fc; --thread-b: #60a5fa; --thread-c: #34d399;
    padding: 32px;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text);
    font-size: 14px; line-height: 1.6;
    min-height: 100vh;
  }
  .ic-mockup h1 { font-size: 18px; margin: 0 0 8px; }
  .ic-mockup h2 { font-size: 12px; margin: 28px 0 10px; color: var(--muted); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
  .ic-mockup .intro { color: var(--muted); margin-bottom: 20px; max-width: 720px; font-size: 13px; }
  .ic-mockup .doc { background: rgba(40,42,46,0.5); border: 1px solid var(--border); border-radius: 10px; padding: 18px 22px; margin-bottom: 12px; position: relative; }
  .ic-mockup .doc p { margin: 0 0 10px; }
  .ic-mockup .doc p:last-child { margin-bottom: 0; }
  .ic-mockup .hl { background: rgba(192,132,252,0.18); border-bottom: 2px solid rgba(192,132,252,0.85); border-radius: 2px; padding: 0 1px; position: relative; }
  .ic-mockup .hl-b { background: rgba(96,165,250,0.18); border-bottom-color: rgba(96,165,250,0.85); }
  .ic-mockup .hl-c { background: rgba(52,211,153,0.18); border-bottom-color: rgba(52,211,153,0.85); }

  .ic-mockup .bubble-base { display: inline-flex; align-items: center; gap: 2px; height: 17px; padding: 0 5px; margin-left: 2px; border-radius: 9px; background: var(--thread-a); color: #1a1205; font-size: 10px; font-weight: 700; line-height: 17px; box-shadow: 0 2px 6px rgba(0,0,0,0.28); vertical-align: middle; cursor: pointer; }
  .ic-mockup .bubble-base svg { width: 10px; height: 10px; }

  .ic-mockup .av-a { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: linear-gradient(135deg, #f472b6, #c084fc); color: #fff; font-size: 9px; font-weight: 700; margin-left: 3px; border: 2px solid var(--thread-a); box-shadow: 0 2px 6px rgba(0,0,0,0.4); vertical-align: middle; cursor: pointer; transition: transform 0.15s; }
  .ic-mockup .av-a:hover { transform: scale(1.15); }
  .ic-mockup .av-a.b { background: linear-gradient(135deg, #60a5fa, #818cf8); border-color: var(--thread-b); }
  .ic-mockup .av-a.c { background: linear-gradient(135deg, #34d399, #14b8a6); border-color: var(--thread-c); }

  .ic-mockup .av-b { position: relative; display: inline-block; vertical-align: middle; margin-left: 3px; cursor: pointer; }
  .ic-mockup .av-b .img { width: 20px; height: 20px; border-radius: 50%; background: linear-gradient(135deg, #f472b6, #c084fc); color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid var(--thread-a); box-shadow: 0 2px 6px rgba(0,0,0,0.4); }
  .ic-mockup .av-b .badge { position: absolute; top: -4px; right: -6px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: var(--thread-a); color: #1a1205; font-size: 9px; font-weight: 800; line-height: 13px; text-align: center; border: 1.5px solid var(--bg); }

  .ic-mockup .av-c { display: inline-flex; align-items: center; margin-left: 3px; vertical-align: middle; cursor: pointer; }
  .ic-mockup .av-c .img { width: 18px; height: 18px; border-radius: 50%; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid var(--bg); box-shadow: 0 2px 6px rgba(0,0,0,0.4); margin-left: -6px; color: #fff; }
  .ic-mockup .av-c .img:first-child { margin-left: 0; }
  .ic-mockup .av-c .img.r { box-shadow: 0 0 0 2px var(--thread-a), 0 2px 6px rgba(0,0,0,0.4); border-color: var(--bg); }
  .ic-mockup .av-c .more { width: 18px; height: 18px; border-radius: 50%; font-size: 8px; font-weight: 800; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.12); color: var(--text); border: 2px solid var(--bg); margin-left: -6px; }

  .ic-mockup .av-d { position: relative; display: inline-block; width: 22px; height: 22px; margin-left: 3px; vertical-align: middle; cursor: pointer; }
  .ic-mockup .av-d svg { position: absolute; inset: 0; }
  .ic-mockup .av-d .img { position: absolute; inset: 3px; border-radius: 50%; background: linear-gradient(135deg, #f472b6, #c084fc); color: #fff; font-size: 8px; font-weight: 700; display: flex; align-items: center; justify-content: center; }

  .ic-mockup .av-e { position: relative; display: inline-flex; align-items: center; margin-left: 3px; vertical-align: middle; cursor: pointer; height: 20px; }
  .ic-mockup .av-e .img { width: 20px; height: 20px; border-radius: 50%; background: linear-gradient(135deg, #f472b6, #c084fc); color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid var(--thread-a); box-shadow: 0 2px 6px rgba(0,0,0,0.4); position: relative; z-index: 2; }
  .ic-mockup .av-e .tail { width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 5px solid var(--thread-a); margin-left: -1px; align-self: center; }

  .ic-mockup .layout { display: grid; grid-template-columns: 1fr 280px; gap: 24px; position: relative; }
  .ic-mockup .margin-col { display: flex; flex-direction: column; gap: 10px; }
  .ic-mockup .margin-card { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--thread-a); border-radius: 10px; padding: 10px 12px; position: relative; transition: all 0.25s ease; }
  .ic-mockup .margin-card.b { border-left-color: var(--thread-b); }
  .ic-mockup .margin-card.c { border-left-color: var(--thread-c); }
  .ic-mockup .margin-card.active { box-shadow: 0 0 0 2px rgba(52,211,153,0.4), 0 8px 24px rgba(0,0,0,0.3); transform: translateX(-4px); }
  .ic-mockup .margin-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .ic-mockup .margin-head .ava { width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #f472b6, #c084fc); color: #fff; font-size: 8px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .ic-mockup .margin-head .name { font-size: 11px; font-weight: 600; }
  .ic-mockup .margin-head .time { font-size: 10px; color: var(--muted); margin-left: auto; }
  .ic-mockup .margin-body { font-size: 12px; color: var(--text); line-height: 1.5; }
  .ic-mockup .margin-quote { font-size: 10px; color: var(--muted); border-left: 2px solid rgba(255,255,255,0.15); padding-left: 6px; margin-bottom: 6px; font-style: italic; }

  .ic-mockup .connector { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1; }
  .ic-mockup .connector path { fill: none; stroke-width: 1.5; stroke-linecap: round; opacity: 0.7; }
  .ic-mockup .connector path.animate { stroke-dasharray: 400; stroke-dashoffset: 400; animation: ic-draw 0.7s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
  @keyframes ic-draw { to { stroke-dashoffset: 0; } }
  .ic-mockup .connector circle { opacity: 0; animation: ic-dot 0.35s ease-out forwards; animation-delay: 0.6s; }
  @keyframes ic-dot { from { opacity: 0; transform: scale(0); } to { opacity: 1; transform: scale(1); } }

  .ic-mockup .toast { position: fixed; bottom: 24px; right: 24px; background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; padding: 10px 16px; border-radius: 10px; font-size: 13px; box-shadow: 0 12px 32px rgba(168,85,247,0.4); transform: translateY(80px); opacity: 0; transition: all 0.3s; z-index: 100; }
  .ic-mockup .toast.show { transform: translateY(0); opacity: 1; }

  .ic-mockup button.run { background: linear-gradient(135deg, #a855f7, #7c3aed); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(168,85,247,0.3); }
  .ic-mockup button.run:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(168,85,247,0.4); }

  .ic-mockup hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  .ic-mockup .row-label { display: inline-block; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px; font-size: 10px; color: var(--muted); margin-right: 8px; }
</style>

<div class="ic-mockup">
  <h1>划词评论气泡 — 头像变体 &amp; 提交后自动连线</h1>
  <p class="intro">下方 5 种气泡变体（A–E），每种都把当前 MessageSquare 图标换成评论者头像 + 线程色描边、尺寸与现气泡接近。底部「模拟提交」按钮演示提交后自动连线动画，替代当前必须点气泡才出连线的体验。</p>

  <h2><span class="row-label">基线</span>当前样式（MessageSquare 图标气泡）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯「AI 大事」<span class="hl">从一条瘪列表长成了双栏信息流<span class="bubble-base"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>3</span></span>；网页托管长出了评论能力。</p>
  </div>

  <h2><span class="row-label">A</span>圆头像 + 线程色 2px 描边（最简，同尺寸）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-a">小</span></span>；任务树升到 v2 还配了<span class="hl hl-b">「全员卡点墙」<span class="av-a b">王</span></span>；项目管理新增<span class="hl hl-c">观察者角色<span class="av-a c">L</span></span>。</p>
  </div>

  <h2><span class="row-label">B</span>头像 + 数字徽章（多人评论显计数）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-b"><span class="img">小</span><span class="badge">3</span></span></span>；网页托管长出了<span class="hl">评论能力<span class="av-b"><span class="img">王</span></span></span>。</p>
  </div>

  <h2><span class="row-label">C</span>头像堆叠（最多 3 个，超出显 +N）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-c"><span class="img r" style="background:linear-gradient(135deg,#f472b6,#c084fc)">小</span><span class="img" style="background:linear-gradient(135deg,#60a5fa,#818cf8)">王</span><span class="img" style="background:linear-gradient(135deg,#34d399,#14b8a6)">L</span><span class="more">+2</span></span></span>。</p>
  </div>

  <h2><span class="row-label">D</span>圆环描边头像（线程色更柔和）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-d"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="none" stroke="rgba(192,132,252,0.85)" stroke-width="2"/></svg><span class="img">小</span></span></span>；任务树升到 v2 还配了<span class="hl hl-b">「全员卡点墙」<span class="av-d"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="10" fill="none" stroke="rgba(96,165,250,0.85)" stroke-width="2"/></svg><span class="img" style="background:linear-gradient(135deg,#60a5fa,#818cf8)">王</span></span></span>。</p>
  </div>

  <h2><span class="row-label">E</span>头像 + 三角尾巴（最像评论气泡）</h2>
  <div class="doc">
    <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-e"><span class="img">小</span><span class="tail"></span></span></span>；网页托管长出了<span class="hl">评论能力<span class="av-e"><span class="img" style="background:linear-gradient(135deg,#60a5fa,#818cf8);border-color:var(--thread-b)">王</span><span class="tail" style="border-left-color:var(--thread-b)"></span></span></span>。</p>
  </div>

  <hr>

  <h1>提交后自动连线 demo</h1>
  <p class="intro">按下「模拟提交」→ 撒花 toast → 正文新高亮淡入 → 右侧卡片淡入 → 0.7s 自动从气泡画曲线到右侧卡 → 卡片高亮 1.5s。取代当前必须用户点气泡才出连线的体验。</p>

  <button class="run" onclick="window.__icMockupRun()">▶ 模拟提交一条新批注</button>

  <div style="margin-top: 24px;">
    <div class="layout" id="ic-layout">
      <div>
        <div class="doc" style="margin: 0;">
          <p>今天主干很热闹：AI 资讯<span class="hl">「AI 大事」从一条瘪列表长成了双栏信息流<span class="av-a">小</span></span>；任务树升到 v2 还配了<span class="hl hl-b">「全员卡点墙」<span class="av-a b">王</span></span>；本篇含<span class="hl hl-c" id="ic-hl-new" style="opacity:0;transition:opacity 0.3s">真人路径走查截图与视察评审 + 浦江演进方向<span class="av-a c" id="ic-av-new" style="opacity:0">浦</span></span>。</p>
          <p style="font-size:12px;color:var(--muted);margin-top:12px;">主干落地 72 次提交 (feat 15 · fix 46 · perf 1 · docs 3) · 7 个 PR · 贡献者 3 人。</p>
        </div>
      </div>
      <div class="margin-col" id="ic-margin-col">
        <div class="margin-card">
          <div class="margin-head"><div class="ava">小</div><div class="name">小米</div><div class="time">10 分钟前</div></div>
          <div class="margin-quote">"…双栏信息流"</div>
          <div class="margin-body">这个改版很顺手，但分类筛选是不是应该默认折叠？</div>
        </div>
        <div class="margin-card b">
          <div class="margin-head"><div class="ava" style="background:linear-gradient(135deg,#60a5fa,#818cf8)">王</div><div class="name">王同学</div><div class="time">8 分钟前</div></div>
          <div class="margin-quote">"「全员卡点墙」"</div>
          <div class="margin-body">这名字太狠了，能不能改成「团队进度墙」？</div>
        </div>
        <div class="margin-card c" id="ic-card-new" style="opacity:0;transform:translateY(-8px);transition:all 0.4s">
          <div class="margin-head"><div class="ava" style="background:linear-gradient(135deg,#34d399,#14b8a6)">浦</div><div class="name">浦江同学</div><div class="time">刚刚</div></div>
          <div class="margin-quote">"真人路径走查截图…"</div>
          <div class="margin-body">视察评审这一段要不要单独抽个 H2？</div>
        </div>
      </div>
      <svg class="connector" id="ic-connector" preserveAspectRatio="none"></svg>
    </div>
  </div>

  <div class="toast" id="ic-toast">批注已发布</div>
</div>
`;

const SCRIPT = `
window.__icMockupRun = function() {
  function getRelPos(el, container) {
    const a = el.getBoundingClientRect();
    const b = container.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  }
  document.getElementById('ic-hl-new').style.opacity = 0;
  document.getElementById('ic-av-new').style.opacity = 0;
  document.getElementById('ic-card-new').style.opacity = 0;
  document.getElementById('ic-card-new').style.transform = 'translateY(-8px)';
  document.getElementById('ic-card-new').classList.remove('active');
  var old = document.getElementById('ic-connector-fixed');
  if (old) old.remove();
  var icConnector = document.getElementById('ic-connector');
  if (icConnector) icConnector.innerHTML = '';
  document.getElementById('ic-toast').classList.remove('show');

  setTimeout(function(){ document.getElementById('ic-toast').classList.add('show'); }, 100);
  setTimeout(function(){ document.getElementById('ic-toast').classList.remove('show'); }, 2200);

  setTimeout(function(){
    document.getElementById('ic-hl-new').style.opacity = 1;
    document.getElementById('ic-av-new').style.opacity = 1;
  }, 300);

  setTimeout(function(){
    var card = document.getElementById('ic-card-new');
    card.style.opacity = 1;
    card.style.transform = 'translateY(0)';
  }, 500);

  setTimeout(function(){
    var av = document.getElementById('ic-av-new');
    var card = document.getElementById('ic-card-new');
    if (!av || !card) return;
    // 用视口坐标，把 SVG 挂在 body 顶层，避开 .doc 背景对中段连线的遮挡
    var aRect = av.getBoundingClientRect();
    var bRect = card.getBoundingClientRect();
    var x1 = aRect.right;
    var y1 = aRect.top + aRect.height / 2;
    var x2 = bRect.left;
    var y2 = bRect.top + 16;
    var dx = Math.max(40, (x2 - x1) * 0.5);
    var path = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    // 移除上一次的 SVG（若有）
    var old = document.getElementById('ic-connector-fixed');
    if (old) old.remove();
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('id', 'ic-connector-fixed');
    svg.setAttribute('width', String(window.innerWidth));
    svg.setAttribute('height', String(window.innerHeight));
    svg.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);
    svg.style.position = 'fixed';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '9999';
    svg.style.overflow = 'visible';
    var pEl = document.createElementNS(ns, 'path');
    pEl.setAttribute('d', path);
    pEl.setAttribute('fill', 'none');
    pEl.setAttribute('stroke', '#34d399');
    pEl.setAttribute('stroke-width', '1.8');
    pEl.setAttribute('stroke-linecap', 'round');
    pEl.setAttribute('opacity', '0.85');
    pEl.setAttribute('class', 'animate');
    svg.appendChild(pEl);
    var c1 = document.createElementNS(ns, 'circle');
    c1.setAttribute('cx', String(x1)); c1.setAttribute('cy', String(y1));
    c1.setAttribute('r', '3'); c1.setAttribute('fill', '#34d399');
    svg.appendChild(c1);
    var c2 = document.createElementNS(ns, 'circle');
    c2.setAttribute('cx', String(x2)); c2.setAttribute('cy', String(y2));
    c2.setAttribute('r', '3'); c2.setAttribute('fill', '#34d399');
    svg.appendChild(c2);
    document.body.appendChild(svg);
    card.classList.add('active');
  }, 700);

  setTimeout(function(){ document.getElementById('ic-card-new').classList.remove('active'); }, 2600);
};
`;

export default function InlineCommentBubbleMockupPage() {
  useEffect(() => {
    const s = document.createElement('script');
    s.id = 'ic-mockup-script';
    s.innerHTML = SCRIPT;
    document.body.appendChild(s);
    return () => {
      const el = document.getElementById('ic-mockup-script');
      if (el) el.remove();
      delete (window as unknown as { __icMockupRun?: () => void }).__icMockupRun;
    };
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: HTML }} />;
}
