/**
 * CDS Preview Version Badge — 注入每个被代理的预览页 HTML。
 *
 * 目的：用户同时开多个分支预览（或同一应用的多个版本）时，让每个页面"自报家门"，
 * 解决「混搭很多版本后分不清哪个标签是哪个」：
 *  - 左上角一个小药丸："<分支尾巴> · <sha7> · <极速/源码>"，点击折叠成一个圆点
 *  - 浏览器标签页标题前缀 "[<分支尾巴>] <原标题>"，多标签一眼区分
 *
 * 与 Bridge widget（默认关闭）完全独立 —— 这是纯身份标记，始终注入。
 * 关闭开关：环境变量 CDS_PREVIEW_BADGE=off。
 *
 * 本文件是纯函数（无 IO），便于单测；真正注入在 proxy.ts 的 HTML 注入点。
 */
export interface PreviewVersionBadgeInput {
  branchName: string;
  /** 完整 commit sha（githubCommitSha），内部截前 7 位 */
  sha?: string | null;
  /** 容器实际钉的 deployedMode（express / static / dev / release / prebuilt ...）*/
  mode?: string | null;
}

/** 去掉可能破坏 <script> / 属性上下文的字符。*/
function sanitize(value: string | null | undefined): string {
  return String(value || '').replace(/[<>'"&\\]/g, '');
}

/** deployedMode 原始值 → 中文模式标签（禁 emoji，见 CLAUDE.md §0）。空值返回空串。*/
export function modeLabelOf(rawMode: string | null | undefined): string {
  const m = sanitize(rawMode).toLowerCase();
  if (!m) return '';
  // express / prebuilt / release 都属「拉 CI 镜像 / 发布版」一类，统一标「极速」；其余源码热加载标「源码」。
  return /express|prebuilt|release/.test(m) ? '极速' : '源码';
}

/** 分支名取「尾巴」（最后一个 '/' 之后），并截断到 maxLen，用于标题前缀与药丸主文案。*/
export function shortBranchOf(branchName: string, maxLen = 18): string {
  const name = sanitize(branchName);
  const tail = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return tail.slice(0, maxLen);
}

/**
 * 生成可直接插到 </body> 前的 `<script>` 字符串。
 * 始终返回非空（除非显式 CDS_PREVIEW_BADGE=off，由调用方判断后才不注入）。
 */
export function buildPreviewVersionBadgeScript(input: PreviewVersionBadgeInput): string {
  const branchName = sanitize(input.branchName).slice(0, 80);
  const sha7 = sanitize(input.sha).slice(0, 7);
  const modeLabel = modeLabelOf(input.mode);
  const shortBranch = shortBranchOf(branchName);

  // 用 JSON.stringify 安全嵌入（已 sanitize 过引号/尖括号，双保险）。
  const BR = JSON.stringify(branchName);
  const SHA = JSON.stringify(sha7);
  const MODE = JSON.stringify(modeLabel);
  const SHORT = JSON.stringify(shortBranch);

  return `
<script data-cds-version-badge>
(function(){
  try{
    if(window.__cdsVersionBadge)return; window.__cdsVersionBadge=1;
    var BR=${BR}, SHA=${SHA}, MODE=${MODE}, SHORT=${SHORT};
    var PREFIX='['+SHORT+'] ';
    // ── 标签页标题前缀：幂等 + 抵抗 SPA 路由改 title ──
    function applyTitle(){
      try{
        var t=document.title||'';
        if(t.indexOf(PREFIX)===0)return;
        t=t.replace(/^\\[[^\\]]{1,24}\\]\\s/,''); // 去掉旧前缀再加，避免叠加
        document.title=PREFIX+t;
      }catch(e){}
    }
    applyTitle();
    try{
      var titleEl=document.querySelector('title');
      if(titleEl){ new MutationObserver(applyTitle).observe(titleEl,{childList:true}); }
    }catch(e){}
    setInterval(applyTitle,1500);
    // ── 左上角药丸 ──
    function mount(){
      if(document.querySelector('[data-cds-version-badge-root]'))return;
      if(!document.body)return;
      var pill=document.createElement('div');
      pill.setAttribute('data-cds-version-badge-root','');
      pill.style.cssText='position:fixed;top:8px;left:8px;z-index:2147483600;display:flex;align-items:center;gap:6px;max-width:46vw;padding:3px 8px;border-radius:999px;background:rgba(17,20,28,0.82);color:#e6edf3;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid rgba(255,255,255,0.16);box-shadow:0 2px 10px rgba(0,0,0,0.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      pill.title='CDS 预览版本\\n分支: '+BR+(SHA?('\\nbuild: '+SHA):'')+(MODE?('\\n模式: '+MODE):'')+'\\n点击折叠/展开';
      var dot=document.createElement('span');
      dot.style.cssText='flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:'+(MODE==='极速'?'#22d3ee':'#a78bfa');
      pill.appendChild(dot);
      var txt=document.createElement('span');
      txt.style.cssText='overflow:hidden;text-overflow:ellipsis';
      txt.textContent=SHORT+(SHA?(' · '+SHA):'')+(MODE?(' · '+MODE):'');
      pill.appendChild(txt);
      var collapsed=false;
      pill.addEventListener('click',function(){
        collapsed=!collapsed;
        txt.style.display=collapsed?'none':'';
        pill.style.padding=collapsed?'4px':'3px 8px';
      });
      document.body.appendChild(pill);
    }
    if(document.body)mount(); else document.addEventListener('DOMContentLoaded',mount);
  }catch(e){}
})();
</script>`;
}
