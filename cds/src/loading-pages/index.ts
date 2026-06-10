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
 * Migration status (see doc/debt.cds-nginx-loading-pages.md):
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
    --bg-page:#f4efe9;
    --bg-card:#ffffff;
    --bg-elevated:#f1eae4;
    --bg-base:#efe7df;
    --bg-terminal:#efe7df;
    --border:#d8cfc6;
    --border-subtle:#e6ddd3;
    --text-primary:#2a1f19;
    --text-secondary:#3f3128;
    --text-muted:#7a6a5e;
    --text-subtle:#9c8e82;
    --accent:#1f6feb;
    --accent-bg:rgba(31,111,235,.10);
    --success:#1a7f37;
    --success-bg:rgba(26,127,55,.10);
    --danger:#cf222e;
    --danger-bg:rgba(207,34,46,.08);
    --shadow-card:0 8px 24px rgba(43,33,28,.10);
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
    ctx.strokeStyle='rgba(232,237,242,.085)';
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
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg-page);color:var(--text-secondary);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none;opacity:.44}
.shape-grid-vignette{position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 620px at 24% 18%,rgba(255,255,255,.08),transparent 60%),radial-gradient(circle at center,transparent 0%,rgba(0,0,0,.2) 56%,rgba(0,0,0,.78) 100%)}
.card{position:relative;z-index:1;max-width:480px;width:100%;padding:28px 30px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-card)}
.header{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.spinner{width:22px;height:22px;border:2.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:18px;font-weight:600;color:var(--text-primary);letter-spacing:.2px}
.subtitle{font-size:12px;color:var(--text-muted);margin-bottom:18px;padding-left:34px;line-height:1.55}
.status-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.chip{display:inline-flex;align-items:center;gap:6px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;color:var(--accent);background:var(--accent-bg);padding:4px 10px;border-radius:99px;border:1px solid rgba(88,166,255,.22)}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-bg);flex-shrink:0;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 3px var(--accent-bg)}50%{box-shadow:0 0 0 6px var(--accent-bg)}}
.hint{font-size:12px;color:var(--text-subtle);line-height:1.6}
.hint code{font-family:ui-monospace,monospace;background:var(--bg-elevated);color:var(--text-secondary);padding:1px 6px;border-radius:4px;font-size:11px}
.refresh-bar{margin-top:18px;height:2px;border-radius:1px;background:var(--border-subtle);overflow:hidden}
.refresh-bar-fill{height:100%;width:0%;background:var(--accent);border-radius:1px;animation:refill 3s linear forwards}
@keyframes refill{to{width:100%}}
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
