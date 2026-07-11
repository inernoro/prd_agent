/**
 * CDS loading-pages SSOT
 *
 * All user-visible waiting / error HTML pages are generated here.
 * exec_cds.sh calls `node dist/cli/render-page.js nginx-waiting` to write
 * /var/www/html/cds-waiting.html instead of maintaining a separate heredoc.
 *
 * When updating styles, change the CSS tokens at the top of each builder.
 *
 * 主题说明（2026-07-09 诚实化）：这些等待/过渡页是**刻意的单主题暗色沉浸设计**
 *（品牌等待间，独立于 dashboard 的 data-theme 体系）。历史版本的 token 块带一个
 * `prefers-color-scheme: light` 分支，但其值与暗色完全相同——伪双主题，只会误导
 * 维护者以为改了 light 块能生效。现已移除该假分支；若未来真要做浅色等待页，
 * 按 cds-theme-tokens 规则给 light 块填**真实浅色值**再恢复 media query。
 *
 * Migration status (see doc/debt.cds.nginx-loading-pages.md):
 *   buildNginxWaitingHtml         - DONE (was exec_cds.sh heredoc)
 *   buildForwarderWaitingPageHtml - DONE 2026-07-09 (moved verbatim from forwarder/waiting-page.ts,
 *                                   old module re-exports for compat; snapshot test locks output)
 *   buildTransitPageHtml          - REMOVED 2026-07-09 (dead code in index.ts — zero call sites,
 *                                   superseded by the React PreviewPreparingPage flow; deleted, not migrated)
 *   buildLegacyWaitingHtml        - pending migration from routes/branches.ts
 *   buildLoadingPreviewBranchGoneHtml - pending migration from routes/branches.ts
 *   buildBranchGoneHtml           - pending migration from index.ts
 *   serveDeployErrorHtml          - pending migration from services/proxy.ts
 */

/** 单主题（暗色）token 块 — 每个页面 <style> 顶部原样引入。见文件头「主题说明」。 */
const DUAL_THEME_TOKENS = `
:root{
  --bg-page:#0d1117;
  --bg-card:#161b22;
  --bg-elevated:#21262d;
  --bg-base:#0d1117;
  --bg-terminal:#010409;
  --border:#30363d;
  --border-subtle:#21262d;
  --text-primary:#f0f6fc;
  --text-secondary:#c9d1d9;
  --text-muted:#8b949e;
  --text-subtle:#6e7681;
  --accent:#58a6ff;
  --accent-bg:rgba(88,166,255,.14);
  --success:#3fb950;
  --success-bg:rgba(63,185,80,.14);
  --danger:#f85149;
  --danger-bg:rgba(248,81,73,.12);
  --shadow-card:0 12px 32px rgba(0,0,0,.45);
}`.trim();

/** Shared animated square-grid canvas background (identical to buildTransitPageHtml). */
const GRID_CANVAS_SCRIPT = `
(function(){
  var canvas=document.getElementById('shapeGridBg');
  if(!canvas)return;
  var ctx=canvas.getContext('2d');
  if(!ctx)return;
  var offset={x:0,y:0};
  var size=42;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    ctx.setTransform(d,0,0,d,0,0);
  }
  function draw(){
    var w=window.innerWidth,h=window.innerHeight;
    ctx.clearRect(0,0,w,h);
    if(!reduced){
      offset.x=(offset.x-.14+size)%size;
      offset.y=(offset.y-.14+size)%size;
    }
    var ox=((offset.x%size)+size)%size;
    var oy=((offset.y%size)+size)%size;
ctx.strokeStyle='rgba(77,101,128,.16)';
    ctx.lineWidth=1;
    for(var x=-size+ox;x<w+size;x+=size){
      for(var y=-size+oy;y<h+size;y+=size){
        ctx.strokeRect(x,y,size,size);
      }
    }
    var gr=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.sqrt(w*w+h*h)/2);
    gr.addColorStop(0,'rgba(0,0,0,0)');
    gr.addColorStop(.75,'rgba(0,0,0,.16)');
    gr.addColorStop(1,'rgba(0,0,0,.58)');
    ctx.fillStyle=gr;
    ctx.fillRect(0,0,w,h);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());`.trim();

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * nginx waiting page — served at /var/www/html/cds-waiting.html.
 * nginx returns this file for 502/504 upstream errors (CDS master down).
 * Written by exec_cds.sh via `node dist/cli/render-page.js nginx-waiting`.
 *
 * Auto-refreshes every 3 s. No external dependencies (must work before CDS starts).
 */
export function buildNginxWaitingHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CDS 自升级中</title>
<style>
${DUAL_THEME_TOKENS}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#070a0f;color:var(--text-secondary);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;color-scheme:dark}
.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none;opacity:.7}
.shape-grid-vignette{position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(7,10,15,.22),rgba(7,10,15,.88)),radial-gradient(900px 620px at 24% 18%,rgba(88,166,255,.14),transparent 60%),radial-gradient(circle at center,transparent 0%,rgba(0,0,0,.35) 58%,rgba(0,0,0,.84) 100%)}
.card{position:relative;z-index:1;max-width:760px;width:100%;overflow:hidden;padding:34px 36px;background:rgba(22,27,34,.92);border:1px solid rgba(139,148,158,.28);border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.45),0 0 0 1px rgba(88,166,255,.04)}
.card::before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,#22c55e,#58a6ff,#a78bfa)}
.header{display:flex;align-items:flex-start;gap:16px;margin-bottom:10px}
.spinner{width:32px;height:32px;border:3px solid rgba(139,148,158,.28);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;margin-top:2px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:28px;font-weight:750;color:var(--text-primary);letter-spacing:.1px;line-height:1.2}
.subtitle{font-size:15px;color:var(--text-muted);margin:6px 0 24px;padding-left:48px;line-height:1.7}
.status-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:22px}
.chip{display:inline-flex;min-height:42px;align-items:center;gap:8px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#9ecbff;background:rgba(88,166,255,.12);padding:8px 12px;border-radius:10px;border:1px solid rgba(88,166,255,.24)}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-bg);flex-shrink:0;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px var(--accent-bg)}50%{box-shadow:0 0 0 6px var(--accent-bg)}}
.hint{font-size:13px;color:var(--text-muted);line-height:1.7;border-top:1px solid rgba(139,148,158,.18);padding-top:18px}
.hint code{font-family:ui-monospace,monospace;background:rgba(139,148,158,.13);color:var(--text-secondary);padding:2px 7px;border-radius:5px;font-size:12px}
.refresh-bar{margin-top:22px;height:3px;border-radius:99px;background:rgba(139,148,158,.18);overflow:hidden}
.refresh-bar-fill{height:100%;width:0%;background:linear-gradient(90deg,#22c55e,#58a6ff);border-radius:99px;animation:refill 3s linear forwards}
@keyframes refill{to{width:100%}}
@media(max-width:640px){.card{padding:28px 22px}.status-row{grid-template-columns:1fr}.subtitle{padding-left:0}h1{font-size:24px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}.refresh-bar-fill{width:100%}}
</style>
</head><body>
<canvas class="shape-grid-bg" id="shapeGridBg" aria-hidden="true"></canvas>
<div class="shape-grid-vignette" aria-hidden="true"></div>
<div class="card">
  <div class="header">
    <div class="spinner"></div>
    <h1>CDS 自升级中</h1>
  </div>
  <div class="subtitle">控制面正在重启，分支预览几秒后自动恢复</div>
  <div class="status-row">
    <span class="chip">自动升级进行中</span>
    <span class="chip">3s 后刷新</span>
    <span class="chip">控制面重启中</span>
  </div>
  <div class="hint">如持续停留，请在 <code>PR Checks</code> 面板查看 CDS Deploy 状态。</div>
  <div class="refresh-bar"><div class="refresh-bar-fill"></div></div>
</div>
<script>
${GRID_CANVAS_SCRIPT}
setTimeout(function(){location.reload()},3000);
</script>
</body></html>`;
}

/**
 * Forwarder 等待页 — CDS self-update 窗口内 forwarder 对所有预览流量返回的页面
 *（最常被看到的等待页）。2026-07-09 从 src/forwarder/waiting-page.ts 原样迁入
 * （字节级等价，见 tests/loading-pages.test.ts 快照锁），旧模块转为 re-export。
 * 本页为刻意的单主题暗色沉浸设计（品牌等待间），不走 DUAL_THEME_TOKENS。
 */
export function buildForwarderWaitingPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>分支环境正在构建</title>
<style>
*{box-sizing:border-box}html,body{min-height:100%}
body{margin:0;min-height:100vh;overflow:hidden;background:#08070d;color:#f7f5ff;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.grid{position:fixed;inset:-8%;opacity:.72;background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);background-size:34px 34px;transform:rotate(-2deg);animation:grid 18s linear infinite}
.shade{position:fixed;inset:0;background:radial-gradient(880px 640px at 66% 42%,rgba(255,255,255,.12),transparent 55%),linear-gradient(90deg,rgba(8,7,13,.94),rgba(8,7,13,.58) 52%,rgba(8,7,13,.9))}
.shell{position:relative;z-index:1;min-height:100vh;display:grid;align-items:center;padding:clamp(34px,7vw,92px)}
.content{max-width:760px;text-shadow:0 20px 80px rgba(0,0,0,.72)}
.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;color:rgba(245,242,255,.66);font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.28em;text-transform:uppercase}
.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 18px rgba(255,255,255,.82);animation:pulse 1.7s ease-in-out infinite}
h1{margin:0 0 22px;font-size:clamp(44px,6vw,86px);line-height:.96;letter-spacing:0;color:rgba(247,245,255,.86);background:linear-gradient(120deg,rgba(247,245,255,.74),#fff,rgba(247,245,255,.72));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shine 3.8s linear infinite}
.desc{max-width:640px;margin:0 0 26px;color:rgba(245,242,255,.62);font-size:clamp(15px,1.45vw,20px);line-height:1.75}
.status{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
.chip{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.04);backdrop-filter:blur(12px);padding:10px 15px;color:#e5e7eb;font:600 13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
.chip:before{content:"";width:7px;height:7px;border-radius:50%;background:#dbe4ee;box-shadow:0 0 16px rgba(219,228,238,.72);animation:pulse 1.7s ease-in-out infinite}
.tip{max-width:660px;border-top:1px solid rgba(245,242,255,.14);padding-top:18px;color:rgba(245,242,255,.54);font-size:13px;line-height:1.7}
.tip strong{color:rgba(245,242,255,.86)}
@keyframes grid{to{transform:rotate(-2deg) translate3d(-34px,-34px,0)}}
@keyframes pulse{0%,100%{transform:scale(.78);opacity:.62}50%{transform:scale(1.22);opacity:1}}
@keyframes shine{0%{background-position:120% 0}100%{background-position:-120% 0}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important}}
</style></head>
<body>
<div class="grid" aria-hidden="true"></div><div class="shade" aria-hidden="true"></div>
<main class="shell"><section class="content">
  <div class="eyebrow">CDS Waiting Room</div>
  <h1>分支环境正在构建</h1>
  <p class="desc">CDS 正在同步分支、启动容器并等待服务健康检查通过。服务稳定后会自动进入真实页面。</p>
  <div class="status"><span class="chip">后台同步 · 自动重试</span><span class="chip">页面每 3 秒刷新</span></div>
  <p class="tip" id="tip"><strong>CDS 小提示：</strong><span></span></p>
</section></main>
<script>
(function(){
  var tips=[
    '预览页只展示用户可理解的状态，forwarder 和 upstream 细节会收敛到统一等待页。',
    '构建完成不等于服务就绪，CDS 会等待端口和健康检查稳定后再切入真实页面。',
    '如果分支不可恢复，CDS 会进入启动失败页，并保留最后日志摘要用于诊断。',
    '容器日志由 CDS 在生命周期关键点归档，避免容器消失后看不到原因。'
  ];
  var target=document.querySelector('#tip span');
  var i=0;
  function tick(){ if(target) target.textContent=tips[i++%tips.length]; }
  tick();
  setInterval(tick,4200);
  setTimeout(function(){ location.reload(); },3000);
}());
</script>
</body></html>`;
}
