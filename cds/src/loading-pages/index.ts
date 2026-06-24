/**
 * CDS loading-pages SSOT
 *
 * All user-visible waiting / error HTML pages are generated here.
 * exec_cds.sh calls `node dist/cli/render-page.js nginx-waiting` to write
 * /var/www/html/cds-waiting.html instead of maintaining a separate heredoc.
 *
 * When updating styles, change the CSS tokens at the top of each builder —
 * they all share the same dual-theme token set.
 *
 * Migration status (see doc/debt.cds.nginx-loading-pages.md):
 *   buildNginxWaitingHtml       - DONE (was exec_cds.sh heredoc)
 *   buildForwarderWaitingHtml   - pending migration from forwarder/waiting-page.ts
 *   buildLegacyWaitingHtml      - pending migration from routes/branches.ts
 *   buildLoadingPreviewBranchGoneHtml - pending migration from routes/branches.ts
 *   buildBranchGoneHtml         - pending migration from index.ts
 *   buildTransitPageHtml        - pending migration from index.ts
 *   serveDeployErrorHtml        - pending migration from services/proxy.ts
 */

/** Shared CSS token block — include verbatim at the top of every page's <style>. */
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
}
@media(prefers-color-scheme:light){
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
  }
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
