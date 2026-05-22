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
