/**
 * CDS Auto-Update Widget — injected into proxied HTML responses.
 *
 * Returns the widget script as a self-contained IIFE string.
 * The proxy injects `<script data-cds-widget>...</script>` before </body>.
 *
 * Parameters embedded at injection time:
 * - __CDS_BRANCH_ID__: the slugified branch ID
 * - __CDS_BRANCH_NAME__: the original branch name
 */
export function buildWidgetScript(branchId: string, branchName: string): string {
  // Escape for safe embedding in <script> tag
  const safeId = branchId.replace(/['"<>&]/g, '');
  const safeName = branchName.replace(/['"<>&]/g, '');

  return `
<script data-cds-widget>
(function(){
  if(document.querySelector('[data-cds-widget-root]'))return;

  var BRANCH_ID='${safeId}';
  var BRANCH_NAME='${safeName}';
  var API='/_cds/api';

  // ── Styles ──
  var css=document.createElement('style');
  css.textContent=\`
    @keyframes cds-spin{to{transform:rotate(360deg)}}
    @keyframes cds-ai-border-glow{0%,100%{box-shadow:inset 0 0 12px 4px rgba(96,165,250,0.5),inset 0 0 36px 2px rgba(167,139,250,0.15)}50%{box-shadow:inset 0 0 20px 6px rgba(96,165,250,0.7),inset 0 0 50px 4px rgba(167,139,250,0.25)}}
    @keyframes cds-highlight-pulse{0%,100%{box-shadow:0 0 0 3px rgba(96,165,250,0.6),0 0 12px 4px rgba(96,165,250,0.3)}50%{box-shadow:0 0 0 5px rgba(96,165,250,0.8),0 0 20px 8px rgba(96,165,250,0.4)}}
    @keyframes cds-step-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
    .cds-ai-active{position:fixed;inset:0;z-index:99998;pointer-events:none;border:none;background:none;animation:cds-ai-border-glow 2.5s ease-in-out infinite}
    .cds-ai-badge{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;background:rgba(22,27,34,0.9);backdrop-filter:blur(8px);border:1px solid rgba(96,165,250,0.4);box-shadow:0 2px 12px rgba(96,165,250,0.3);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:11px;color:#e2e8f0;white-space:nowrap;pointer-events:none}
    .cds-ai-badge-dot{width:6px;height:6px;border-radius:50%;background:#60a5fa;box-shadow:0 0 6px #60a5fa;animation:cds-blink 1.5s ease-in-out infinite}
    #cds-widget{position:fixed;left:12px;bottom:12px;z-index:99999;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;color:#e2e8f0;user-select:none;font-size:12px}
    #cds-widget *{box-sizing:border-box}
    #cds-widget .cds-badge{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:rgba(35,134,54,0.85);backdrop-filter:blur(8px);border:1px solid rgba(63,185,80,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.25);cursor:grab;line-height:1}
    #cds-widget .cds-badge:active{cursor:grabbing}
    #cds-widget .cds-branch{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #cds-widget .cds-tag{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.15);margin-left:2px}
    #cds-widget .cds-sha{font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-family:ui-monospace,SFMono-Regular,monospace;letter-spacing:0.3px}
    #cds-widget .cds-status-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
    #cds-widget .cds-status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
    #cds-widget .cds-status-dot.cds-status-blink{animation:cds-blink 1.5s ease-in-out infinite;box-shadow:0 0 6px currentColor}
    @keyframes cds-blink{0%,100%{opacity:1}50%{opacity:0.3}}
    #cds-widget .cds-commit-sha{font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.5);font-family:ui-monospace,SFMono-Regular,monospace;margin-left:auto;flex-shrink:0}
    #cds-widget .cds-commit-msg{font-size:10px;color:#8b949e;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
    #cds-widget button{display:flex;align-items:center;justify-content:center;padding:2px;border-radius:4px;border:none;background:transparent;color:inherit;cursor:pointer;opacity:0.6}
    #cds-widget button:hover{opacity:1}
    #cds-widget .cds-panel{margin-bottom:4px;padding:10px 12px;border-radius:8px;background:rgba(22,27,34,0.95);backdrop-filter:blur(12px);border:1px solid rgba(63,185,80,0.3);box-shadow:0 4px 16px rgba(0,0,0,0.4);min-width:260px;width:max-content;max-width:min(480px,calc(100vw - 40px));overflow:hidden}
    #cds-widget .cds-deploy-btn{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-size:11px;cursor:pointer;flex:1;min-width:0;opacity:1;white-space:nowrap}
    #cds-widget .cds-deploy-btn:hover{border-color:#58a6ff}
    #cds-widget .cds-deploy-btn:disabled{cursor:wait;opacity:0.5}
    #cds-widget .cds-deploy-btn.full{background:#161b22;width:100%}
    #cds-widget .cds-deploy-row{display:flex;gap:3px;align-items:stretch}
    #cds-widget .cds-log-btn{display:flex;align-items:center;justify-content:center;width:28px;flex-shrink:0;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#8b949e;cursor:pointer;font-size:10px;padding:0}
    #cds-widget .cds-log-btn:hover{border-color:#58a6ff;color:#c9d1d9}
    #cds-widget .cds-log-panel{margin-top:6px;padding:6px 8px;border-radius:6px;background:#0d1117;border:1px solid #30363d;max-height:200px;overflow-y:auto;font-size:10px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#8b949e;font-family:ui-monospace,SFMono-Regular,monospace}
    #cds-widget .cds-log-header{display:flex;align-items:center;justify-content:space-between;margin-top:6px;margin-bottom:2px;font-size:10px;color:#8b949e}
    #cds-log-modal-overlay{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
    #cds-log-modal{width:min(720px,calc(100vw - 48px));max-height:calc(100vh - 80px);border-radius:12px;background:#161b22;border:1px solid #30363d;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;color:#e2e8f0;font-size:12px}
    #cds-log-modal .cds-log-modal-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #30363d;flex-shrink:0}
    #cds-log-modal .cds-log-modal-title{font-size:13px;font-weight:600;color:#e2e8f0}
    #cds-log-modal .cds-log-modal-actions{display:flex;align-items:center;gap:6px}
    #cds-log-modal .cds-log-modal-btn{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}
    #cds-log-modal .cds-log-modal-btn:hover{border-color:#58a6ff;color:#58a6ff}
    #cds-log-modal .cds-log-modal-btn.copied{border-color:#3fb950;color:#3fb950}
    #cds-log-modal .cds-log-modal-body{flex:1;overflow-y:auto;padding:10px 14px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:#8b949e;user-select:text;-webkit-user-select:text}
    #cds-widget .cds-mode-row{display:flex;align-items:center;gap:4px;margin-bottom:6px}
    #cds-widget .cds-mode-label{font-size:10px;color:#8b949e;flex-shrink:0}
    #cds-widget .cds-mode-select{font-size:10px;padding:2px 4px;border-radius:4px;border:1px solid #30363d;background:#161b22;color:#c9d1d9;cursor:pointer;flex:1;min-width:0}
    #cds-widget .cds-mode-select:hover{border-color:#58a6ff}
    #cds-widget .cds-mode-select:focus{outline:none;border-color:#58a6ff}
    #cds-widget .cds-spinner{display:inline-block;width:11px;height:11px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:cds-spin .8s linear infinite;flex-shrink:0}
    #cds-widget .cds-step{display:flex;align-items:center;gap:4px;font-size:10px;color:#8b949e}
    #cds-widget .cds-step.done{color:#3fb950}
    #cds-widget .cds-step.error{color:#f85149}
    #cds-widget .cds-icon{flex-shrink:0;width:13px;height:13px}
    #cds-bridge-ops{position:fixed;z-index:99999;min-width:280px;max-width:380px;padding:0;border-radius:10px;background:rgba(22,27,34,0.95);backdrop-filter:blur(12px);border:1px solid rgba(96,165,250,0.3);box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12px;color:#e2e8f0;overflow:hidden;transition:opacity 0.3s,transform 0.3s}
    #cds-bridge-ops .ops-header{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(96,165,250,0.15);background:rgba(96,165,250,0.08)}
    #cds-bridge-ops .ops-header-dot{width:7px;height:7px;border-radius:50%;background:#60a5fa;box-shadow:0 0 8px #60a5fa;animation:cds-blink 1.5s ease-in-out infinite;flex-shrink:0}
    #cds-bridge-ops .ops-header-text{font-size:11px;font-weight:600;color:#93c5fd}
    #cds-bridge-ops .ops-body{padding:8px 12px;max-height:240px;overflow-y:auto}
    #cds-bridge-ops .ops-step{display:flex;align-items:flex-start;gap:8px;padding:5px 0;animation:cds-step-in 0.3s ease-out}
    #cds-bridge-ops .ops-step+.ops-step{border-top:1px solid rgba(255,255,255,0.04)}
    #cds-bridge-ops .ops-step-icon{width:16px;height:16px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;margin-top:1px}
    #cds-bridge-ops .ops-step-icon.pending{border:1.5px solid #484f58;color:#484f58}
    #cds-bridge-ops .ops-step-icon.running{border:1.5px solid #60a5fa;color:#60a5fa;animation:cds-blink 1s ease-in-out infinite}
    #cds-bridge-ops .ops-step-icon.done{background:#238636;border:none;color:#fff}
    #cds-bridge-ops .ops-step-icon.error{background:#da3633;border:none;color:#fff}
    #cds-bridge-ops .ops-step-text{font-size:11px;color:#c9d1d9;line-height:1.4}
    #cds-bridge-ops .ops-step-text.running{color:#93c5fd}
    #cds-bridge-ops .ops-step-text.done{color:#8b949e}
    #cds-bridge-ops .ops-step-text.error{color:#f85149}
    #cds-bridge-ops .ops-step-detail{font-size:10px;color:#6e7681;margin-top:1px}
    .cds-el-highlight{outline:3px solid rgba(96,165,250,0.7)!important;outline-offset:2px!important;animation:cds-highlight-pulse 1s ease-in-out infinite!important;position:relative;z-index:99990!important;border-radius:4px!important}
    .cds-el-highlight-fade{animation:cds-highlight-fade 3s ease-out forwards!important;outline:3px solid rgba(96,165,250,0.7)!important;outline-offset:2px!important;position:relative;z-index:99990!important;border-radius:4px!important}
    @keyframes cds-cursor-glow{0%,100%{filter:drop-shadow(0 0 6px rgba(96,165,250,0.8)) drop-shadow(0 0 12px rgba(56,189,248,0.4))}50%{filter:drop-shadow(0 0 10px rgba(96,165,250,1)) drop-shadow(0 0 20px rgba(56,189,248,0.6))}}
    @keyframes cds-ring-rotate{to{transform:rotate(360deg)}}
    @keyframes cds-highlight-fade{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
    #cds-ai-cursor{position:fixed;z-index:100001;pointer-events:none;transition:left 0.4s cubic-bezier(.4,0,.2,1),top 0.4s cubic-bezier(.4,0,.2,1),opacity 0.25s;opacity:0;animation:cds-cursor-glow 2s ease-in-out infinite}
    #cds-ai-cursor.visible{opacity:1}
    #cds-ai-cursor .cursor-ring{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid transparent;border-top-color:#60a5fa;border-right-color:#38bdf8;animation:cds-ring-rotate 1.5s linear infinite;opacity:0.7}
    #cds-ai-cursor .cursor-ring2{position:absolute;left:-10px;top:-10px;width:20px;height:20px;border-radius:50%;background:radial-gradient(circle,rgba(96,165,250,0.3) 0%,transparent 70%)}
  \`;
  document.head.appendChild(css);

  // ── SVG icons ──
  var ICON_BRANCH='<svg class="cds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
  var ICON_REFRESH='<svg class="cds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  var ICON_X='<svg class="cds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_UP='<svg class="cds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><polyline points="18 15 12 9 6 15"/></svg>';
  var ICON_DOWN='<svg class="cds-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><polyline points="6 9 12 15 18 9"/></svg>';
  var ICON_LOG='<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.5 0a.25.25 0 01.25-.25h10.5a.25.25 0 01.25.25v7.5a.25.25 0 01-.25.25h-4.5a.75.75 0 00-.75.75v2.19l-2.72-2.72a.75.75 0 00-.53-.22H2.75a.25.25 0 01-.25-.25v-7.5z"/></svg>';
  var ICON_COPY='<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>';
  var ICON_EXPAND='<svg viewBox="0 0 16 16" fill="currentColor" style="width:12px;height:12px"><path d="M3.25 1A2.25 2.25 0 001 3.25v2a.75.75 0 001.5 0v-2a.75.75 0 01.75-.75h2a.75.75 0 000-1.5h-2zm9.5 0a.75.75 0 000 1.5h2a.75.75 0 01.75.75v2a.75.75 0 001.5 0v-2A2.25 2.25 0 0014.75 1h-2zM2.5 10.75a.75.75 0 00-1.5 0v2A2.25 2.25 0 003.25 15h2a.75.75 0 000-1.5h-2a.75.75 0 01-.75-.75v-2zm13 0a.75.75 0 00-1.5 0v2a.75.75 0 01-.75.75h-2a.75.75 0 000 1.5h2A2.25 2.25 0 0015.5 12.75v-2z"/></svg>';

  // ── State ──
  var expanded=false;
  var deploying=false;
  var deployProfileId=null;
  var profiles=[];
  var branchStatus='';
  var commitSha='';
  var commitMsg='';
  var branchTags=[];
  var steps=[];
  var resultMsg='';
  var resultOk=true;
  var logProfileId=null;
  var logContent='';
  var logLoading=false;
  var logModalOpen=false;
  var logModalProfileName='';
  var logModalContent='';
  var titlePrefix='';
  var titleObserver=null;

  // ── AI occupation state ──
  var aiOccupant=null;
  var aiLastSeen=0;
  var AI_TTL=30000;
  var aiOverlay=null;
  var aiBadgeEl=null;

  function updateAiOverlay(){
    var isActive=aiOccupant&&(Date.now()-aiLastSeen<AI_TTL);
    if(isActive){
      if(!aiOverlay){
        aiOverlay=document.createElement('div');
        aiOverlay.className='cds-ai-active';
        document.body.appendChild(aiOverlay);
      }
      if(!aiBadgeEl){
        aiBadgeEl=document.createElement('div');
        aiBadgeEl.className='cds-ai-badge';
        document.body.appendChild(aiBadgeEl);
      }
      aiBadgeEl.innerHTML='<span class="cds-ai-badge-dot"></span> AI 操控中'+(aiOccupant!=='AI'?' · '+aiOccupant:'');
    }else{
      if(aiOverlay){aiOverlay.remove();aiOverlay=null;}
      if(aiBadgeEl){aiBadgeEl.remove();aiBadgeEl=null;}
      aiOccupant=null;
    }
  }

  // Connect to activity stream for AI occupation detection
  function initAiStream(){
    var es;
    try{es=new EventSource(API+'/activity-stream');}catch(e){return;}
    es.onmessage=function(msg){
      try{
        var evt=JSON.parse(msg.data);
        if(evt.source==='ai'&&evt.branchId===BRANCH_ID){
          aiOccupant=evt.agent||'AI';
          aiLastSeen=Date.now();
          updateAiOverlay();
        }
      }catch(e){}
    };
    es.onerror=function(){
      es.close();
      setTimeout(initAiStream,5000);
    };
  }

  // Periodic TTL check for AI occupation expiry
  setInterval(function(){
    if(aiOccupant&&Date.now()-aiLastSeen>=AI_TTL){
      updateAiOverlay();
    }
  },5000);

  // ── Widget root ──
  var root=document.createElement('div');
  root.id='cds-widget';
  root.setAttribute('data-cds-widget-root','');
  document.body.appendChild(root);

  // ── Drag support ──
  var pos={x:12,y:12};
  var dragState=null;

  function onMouseDown(e){
    if(e.target.closest('button'))return;
    dragState={mx:e.clientX,my:e.clientY,px:pos.x,py:pos.y};
    e.preventDefault();
  }
  document.addEventListener('mousemove',function(e){
    if(!dragState)return;
    pos.x=Math.max(0,Math.min(window.innerWidth-180,dragState.px+(e.clientX-dragState.mx)));
    pos.y=Math.max(0,Math.min(window.innerHeight-50,dragState.py-(e.clientY-dragState.my)));
    root.style.left=pos.x+'px';
    root.style.bottom=pos.y+'px';
  });
  document.addEventListener('mouseup',function(){dragState=null;});

  // ── Render ──
  function render(){
    var h='';

    // Panel
    if(expanded){
      h+='<div class="cds-panel">';
      if(!profiles.length && !branchStatus){
        h+='<div style="color:#8b949e;font-size:11px;padding:4px 0"><span class="cds-spinner"></span> 加载中...</div>';
      }else if(!branchStatus){
        h+='<div style="color:#8b949e;font-size:11px;padding:4px 0">分支 "'+BRANCH_ID+'" 未在 CDS 中注册</div>';
      }else{
        var statusColor=branchStatus==='running'?'#3fb950':branchStatus==='error'||branchStatus==='stopped'?'#f85149':'#f0883e';
        var statusBlink=branchStatus==='running'?' cds-status-blink':'';
        h+='<div class="cds-status-row">';
        h+='<span style="font-size:11px;color:#8b949e">状态: </span>';
        h+='<span class="cds-status-dot'+statusBlink+'" style="background:'+statusColor+'"></span>';
        h+='<span style="font-size:11px;color:'+statusColor+';font-style:italic;font-weight:600">'+branchStatus+'</span>';
        if(commitSha)h+='<span class="cds-commit-sha">'+commitSha+'</span>';
        h+='</div>';
        if(commitMsg)h+='<div class="cds-commit-msg" title="'+commitMsg.replace(/"/g,'&quot;')+'">'+commitMsg+'</div>';
        // Deploy mode selectors
        for(var mi=0;mi<profiles.length;mi++){
          var mp=profiles[mi];
          if(mp.deployModes&&Object.keys(mp.deployModes).length>0){
            var modes=mp.deployModes;
            var activeMode=mp.activeDeployMode||'';
            h+='<div class="cds-mode-row">';
            h+='<span class="cds-mode-label">'+mp.name+':</span>';
            h+='<select class="cds-mode-select" data-mode-profile="'+mp.id+'">';
            var modeKeys=Object.keys(modes);
            for(var mk=0;mk<modeKeys.length;mk++){
              var mKey=modeKeys[mk];
              var mLabel=modes[mKey].label||mKey;
              var sel=activeMode===mKey?' selected':'';
              h+='<option value="'+mKey+'"'+sel+'>'+mLabel+'</option>';
            }
            h+='</select></div>';
          }
        }
        h+='<div style="display:flex;flex-direction:column;gap:4px">';
        for(var i=0;i<profiles.length;i++){
          var p=profiles[i];
          var modeTag='';
          if(p.activeDeployMode&&p.deployModes&&p.deployModes[p.activeDeployMode]){
            modeTag=' ('+p.deployModes[p.activeDeployMode].label+')';
          }
          var isThis=deploying&&deployProfileId===p.id;
          h+='<div class="cds-deploy-row">';
          h+='<button class="cds-deploy-btn" data-profile="'+p.id+'"'+(deploying?' disabled':'')+' style="opacity:'+(deploying&&!isThis?'0.5':'1')+'">';
          h+=(isThis?'<span class="cds-spinner"></span>':ICON_REFRESH);
          h+=' 更新 '+p.name+modeTag+'</button>';
          h+='<button class="cds-log-btn" data-log-profile="'+p.id+'" title="查看 '+p.name+' 日志">'+ICON_LOG+'</button>';
          h+='</div>';
        }
        if(profiles.length>1){
          var isAll=deploying&&deployProfileId===null;
          h+='<button class="cds-deploy-btn full" data-profile="__all__"'+(deploying?' disabled':'')+' style="opacity:'+(deploying&&deployProfileId!==null?'0.5':'1')+'">';
          h+=(isAll?'<span class="cds-spinner"></span>':ICON_REFRESH);
          h+=' 全量更新</button>';
        }
        h+='</div>';

        // Steps
        if(steps.length){
          h+='<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">';
          for(var j=0;j<steps.length;j++){
            var s=steps[j];
            var sc=s.status==='done'?'done':s.status==='error'?'error':'';
            h+='<div class="cds-step '+sc+'">';
            if(s.status==='running')h+='<span class="cds-spinner" style="width:9px;height:9px;border-width:1.5px"></span>';
            else if(s.status==='done')h+='<span>✓</span>';
            else if(s.status==='error')h+='<span>✗</span>';
            h+='<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+s.title+'</span></div>';
          }
          h+='</div>';
        }

        // Log panel (inline preview + open modal button)
        if(logProfileId){
          var _logPName=logProfileId;
          for(var lpi=0;lpi<profiles.length;lpi++){if(profiles[lpi].id===logProfileId)_logPName=profiles[lpi].name;}
          h+='<div class="cds-log-header"><span>'+_logPName+' 日志</span><div style="display:flex;gap:4px"><button data-action="open-log-modal" title="弹窗查看" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:12px;padding:2px 4px">'+ICON_EXPAND+'</button><button data-action="close-log" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:12px;padding:2px 4px">'+ICON_X+'</button></div></div>';
          h+='<div class="cds-log-panel">'+(logLoading?'<span class="cds-spinner"></span> 加载中...':logContent||'(空)')+'</div>';
        }

        // Result
        if(resultMsg){
          h+='<div style="margin-top:6px;font-size:10px;color:'+(resultOk?'#3fb950':'#f85149')+'">'+resultMsg+'</div>';
        }
      }
      h+='</div>';
    }

    // Badge
    h+='<div class="cds-badge" onmousedown="return false">';
    h+=ICON_BRANCH;
    h+='<span class="cds-branch">'+BRANCH_NAME+'</span>';
    if(commitSha)h+='<span class="cds-sha" title="'+commitSha+'">'+commitSha+'</span>';
    if(branchTags.length){for(var ti=0;ti<branchTags.length;ti++){h+='<span class="cds-tag">'+branchTags[ti]+'</span>';}}
    else{h+='<span class="cds-tag">CDS</span>';}
    h+='<button data-action="toggle" title="'+(expanded?'收起':'展开更新面板')+'">'+(expanded?ICON_DOWN:ICON_UP)+'</button>';
    h+='<button data-action="dismiss">'+ICON_X+'</button>';
    h+='</div>';

    root.innerHTML=h;
    root.style.left=pos.x+'px';
    root.style.bottom=pos.y+'px';

    // Attach drag to badge bar
    var badge=root.querySelector('.cds-badge');
    if(badge)badge.addEventListener('mousedown',onMouseDown);

    // Render log modal
    renderLogModal();
  }

  function renderLogModal(){
    var existing=document.getElementById('cds-log-modal-overlay');
    if(!logModalOpen){
      if(existing)existing.remove();
      return;
    }
    var overlay=existing||document.createElement('div');
    overlay.id='cds-log-modal-overlay';
    var mh='<div id="cds-log-modal">';
    mh+='<div class="cds-log-modal-header">';
    mh+='<span class="cds-log-modal-title">'+logModalProfileName+' 日志</span>';
    mh+='<div class="cds-log-modal-actions">';
    mh+='<button class="cds-log-modal-btn" data-action="copy-log">'+ICON_COPY+' 复制全部</button>';
    mh+='<button class="cds-log-modal-btn" data-action="close-log-modal">'+ICON_X+'</button>';
    mh+='</div></div>';
    mh+='<div class="cds-log-modal-body">'+(logModalContent||'(空)')+'</div>';
    mh+='</div>';
    overlay.innerHTML=mh;
    if(!existing){
      overlay.addEventListener('click',function(e){
        if(e.target===overlay){logModalOpen=false;renderLogModal();}
        var btn=e.target.closest('button');
        if(!btn)return;
        var act=btn.getAttribute('data-action');
        if(act==='close-log-modal'){logModalOpen=false;renderLogModal();}
        if(act==='copy-log'){
          var text=logModalContent||'';
          if(navigator.clipboard&&navigator.clipboard.writeText){
            navigator.clipboard.writeText(text).then(function(){
              btn.classList.add('copied');
              btn.innerHTML=ICON_COPY+' 已复制';
              setTimeout(function(){btn.classList.remove('copied');btn.innerHTML=ICON_COPY+' 复制全部';},1500);
            });
          }else{
            var ta=document.createElement('textarea');
            ta.value=text;ta.style.cssText='position:fixed;left:-9999px';
            document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
            btn.classList.add('copied');
            btn.innerHTML=ICON_COPY+' 已复制';
            setTimeout(function(){btn.classList.remove('copied');btn.innerHTML=ICON_COPY+' 复制全部';},1500);
          }
        }
      });
      // ESC to close
      overlay.addEventListener('keydown',function(e){if(e.key==='Escape'){logModalOpen=false;renderLogModal();}});
      document.body.appendChild(overlay);
    }
    // Scroll to bottom
    var body=overlay.querySelector('.cds-log-modal-body');
    if(body)body.scrollTop=body.scrollHeight;
  }

  // ── Event delegation ──
  root.addEventListener('click',function(e){
    var btn=e.target.closest('button');
    if(!btn)return;
    var action=btn.getAttribute('data-action');
    if(action==='dismiss'){root.remove();return;}
    if(action==='close-log'){logProfileId=null;logContent='';render();return;}
    if(action==='open-log-modal'){
      var _pName=logProfileId||'';
      for(var _i=0;_i<profiles.length;_i++){if(profiles[_i].id===logProfileId)_pName=profiles[_i].name;}
      logModalProfileName=_pName;
      logModalContent=logContent;
      logModalOpen=true;
      renderLogModal();
      return;
    }
    if(action==='toggle'){
      expanded=!expanded;
      if(expanded)fetchBranchInfo();
      render();
      return;
    }
    var logPid=btn.getAttribute('data-log-profile');
    if(logPid){fetchContainerLog(logPid);return;}
    var profileId=btn.getAttribute('data-profile');
    if(profileId&&!deploying){
      doDeploy(profileId==='__all__'?undefined:profileId);
    }
  });

  // Deploy mode change handler
  root.addEventListener('change',function(e){
    var sel=e.target;
    if(!sel||!sel.getAttribute)return;
    var profileId=sel.getAttribute('data-mode-profile');
    if(!profileId)return;
    var mode=sel.value;
    fetch(API+'/build-profiles/'+profileId+'/deploy-mode',{
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mode:mode})
    }).then(function(r){
      if(r.ok){
        // Update local state
        for(var i=0;i<profiles.length;i++){
          if(profiles[i].id===profileId){
            profiles[i].activeDeployMode=mode;
            break;
          }
        }
        render();
      }
    }).catch(function(){});
  });

  // ── CDS API calls ──
  function fetchBranchInfo(){
    Promise.all([
      fetch(API+'/branches').then(function(r){return r.ok?r.json():{};}),
      fetch(API+'/build-profiles').then(function(r){return r.ok?r.json():{};})
    ]).then(function(res){
      var branchList=(res[0]&&res[0].branches)||[];
      var found=null;
      for(var i=0;i<branchList.length;i++){
        if(branchList[i].id===BRANCH_ID){found=branchList[i];break;}
      }
      branchStatus=found?found.status:'';
      commitSha=found&&found.commitSha?found.commitSha:'';
      commitMsg=found&&found.subject?found.subject:'';
      branchTags=(found&&found.tags)||[];
      profiles=(res[1]&&res[1].profiles)||[];

      // Update page title with tags or branch short name for easy tab identification
      var tabTitleEnabled=res[0]&&res[0].tabTitleEnabled!==false;
      if(tabTitleEnabled){
        if(branchTags.length){
          titlePrefix=branchTags.join(' · ');
        }else{
          titlePrefix=BRANCH_NAME.indexOf('/')>=0?BRANCH_NAME.substring(BRANCH_NAME.indexOf('/')+1):BRANCH_NAME;
        }
        applyTitlePrefix();
        watchTitle();
      }else{
        titlePrefix='';
        unwatchTitle();
      }

      render();
    }).catch(function(){
      branchStatus='';
      profiles=[];
      render();
    });
  }

  function fetchContainerLog(pid){
    if(logProfileId===pid){logProfileId=null;logContent='';render();return;}
    logProfileId=pid;logContent='';logLoading=true;render();
    fetch(API+'/branches/'+BRANCH_ID+'/container-logs',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({profileId:pid})
    }).then(function(r){return r.json();}).then(function(d){
      logContent=d.logs||d.error||'(空)';
      // Keep last 80 lines for inline panel
      var lines=logContent.split('\\n');
      if(lines.length>80)logContent=lines.slice(-80).join('\\n');
      logLoading=false;
      // Sync to modal if open
      if(logModalOpen){logModalContent=logContent;renderLogModal();}
      render();
      // Scroll log panel to bottom
      var lp=root.querySelector('.cds-log-panel');
      if(lp)lp.scrollTop=lp.scrollHeight;
    }).catch(function(e){logContent='Error: '+e.message;logLoading=false;render();});
  }

  function doDeploy(profileId){
    deploying=true;
    deployProfileId=profileId||null;
    steps=[];
    resultMsg='';
    render();

    var url=profileId
      ?API+'/branches/'+BRANCH_ID+'/deploy/'+profileId
      :API+'/branches/'+BRANCH_ID+'/deploy';

    fetch(url,{method:'POST'}).then(function(res){
      if(!res.ok||!res.body){
        deploying=false;
        resultMsg='HTTP '+res.status;
        resultOk=false;
        render();
        return;
      }
      var reader=res.body.getReader();
      var decoder=new TextDecoder();
      var buffer='';

      function read(){
        reader.read().then(function(result){
          if(result.done){
            if(deploying){deploying=false;render();}
            return;
          }
          buffer+=decoder.decode(result.value,{stream:true});
          var lines=buffer.split('\\n');
          buffer=lines.pop()||'';
          var evt='';
          for(var i=0;i<lines.length;i++){
            var line=lines[i];
            if(line.indexOf('event: ')===0)evt=line.slice(7).trim();
            else if(line.indexOf('data: ')===0){
              try{
                var d=JSON.parse(line.slice(6));
                if(evt==='step'){
                  var found=false;
                  for(var j=0;j<steps.length;j++){
                    if(steps[j].step===d.step){steps[j]=d;found=true;break;}
                  }
                  if(!found)steps.push(d);
                  render();
                }else if(evt==='complete'){
                  deploying=false;
                  resultMsg=d.message||'完成';
                  resultOk=true;
                  render();
                  setTimeout(function(){resultMsg='';render();},3000);
                }else if(evt==='error'){
                  deploying=false;
                  resultMsg=d.message||'错误';
                  resultOk=false;
                  render();
                }
              }catch(ex){}
            }
          }
          read();
        }).catch(function(err){
          deploying=false;
          resultMsg=err.message||'流读取错误';
          resultOk=false;
          render();
        });
      }
      read();
    }).catch(function(err){
      deploying=false;
      resultMsg=err.message;
      resultOk=false;
      render();
    });
  }

  // ── Title guard: MutationObserver keeps title prefix even when SPA overwrites it ──
  function applyTitlePrefix(){
    if(!titlePrefix)return;
    var raw=document.title.replace(/\\[.*?\\]\\s*/,'');
    var want='['+titlePrefix+'] '+raw;
    if(document.title!==want)document.title=want;
  }
  function watchTitle(){
    if(titleObserver)return;
    var el=document.querySelector('title');
    if(!el)return;
    titleObserver=new MutationObserver(function(){applyTitlePrefix();});
    titleObserver.observe(el,{childList:true,characterData:true,subtree:true});
  }
  function unwatchTitle(){
    if(titleObserver){titleObserver.disconnect();titleObserver=null;}
  }

  // ══════════════════════════════════════════════════════════════
  // ── Page Agent Bridge Client (HTTP Polling) ──
  // Provides DOM extraction, action execution, and HTTP polling
  // communication so external agents can read and operate the page.
  // Uses /_cds/api/ HTTP channel (proven reliable) instead of WebSocket.
  // ══════════════════════════════════════════════════════════════

  var bridgeConsoleErrors=[];
  var bridgeNetworkErrors=[];
  var bridgeInteractiveElements=[];
  var bridgeNavRequest=null;
  var bridgeNavPollTimer=null;
  var bridgeConnected=false;

  // ── AI Operation Panel state ──
  var opsSteps=[];        // [{id, action, description, status:'pending'|'running'|'done'|'error', detail:''}]
  var opsVisible=false;
  var opsAutoHideTimer=null;
  var highlightedEl=null;

  function addOpsStep(id,action,description){
    opsSteps.push({id:id,action:action,description:description||actionLabel(action),status:'running',detail:''});
    // Keep last 8 steps
    if(opsSteps.length>8)opsSteps.shift();
    opsVisible=true;
    clearOpsAutoHide();
    renderOpsPanel();
  }

  function updateOpsStep(id,status,detail){
    for(var i=opsSteps.length-1;i>=0;i--){
      if(opsSteps[i].id===id){
        opsSteps[i].status=status;
        if(detail)opsSteps[i].detail=detail;
        break;
      }
    }
    renderOpsPanel();
    if(status==='done'||status==='error'){
      scheduleOpsAutoHide();
    }
  }

  function actionLabel(action){
    var labels={click:'点击元素',type:'输入文本',scroll:'滚动页面',navigate:'页面导航','spa-navigate':'SPA 页面跳转',evaluate:'执行脚本',snapshot:'读取页面'};
    return labels[action]||action;
  }

  function scheduleOpsAutoHide(){
    clearOpsAutoHide();
    opsAutoHideTimer=setTimeout(function(){/* 15s auto-hide */
      // Only hide if all steps are done/error
      var allDone=true;
      for(var i=0;i<opsSteps.length;i++){
        if(opsSteps[i].status==='running'||opsSteps[i].status==='pending'){allDone=false;break;}
      }
      if(allDone){opsVisible=false;renderOpsPanel();}
    },15000);
  }

  function clearOpsAutoHide(){
    if(opsAutoHideTimer){clearTimeout(opsAutoHideTimer);opsAutoHideTimer=null;}
  }

  function renderOpsPanel(){
    var panel=document.getElementById('cds-bridge-ops');
    if(!opsVisible||opsSteps.length===0){
      if(panel)panel.remove();
      return;
    }
    if(!panel){
      panel=document.createElement('div');
      panel.id='cds-bridge-ops';
      panel.setAttribute('data-page-agent-ignore','');
      document.body.appendChild(panel);
    }
    panel.style.left=pos.x+'px';
    panel.style.bottom=(pos.y+42)+'px';

    var h='<div class="ops-header">';
    h+='<span class="ops-header-dot"></span>';
    h+='<span class="ops-header-text">AI 正在操作</span>';
    h+='</div>';
    h+='<div class="ops-body">';
    for(var i=0;i<opsSteps.length;i++){
      var s=opsSteps[i];
      var iconCls='ops-step-icon '+s.status;
      var textCls='ops-step-text '+s.status;
      var icon='';
      if(s.status==='pending')icon='○';
      else if(s.status==='running')icon='◎';
      else if(s.status==='done')icon='✓';
      else if(s.status==='error')icon='✗';
      h+='<div class="ops-step">';
      h+='<span class="'+iconCls+'">'+icon+'</span>';
      h+='<div><div class="'+textCls+'">'+s.description+'</div>';
      if(s.detail)h+='<div class="ops-step-detail">'+s.detail+'</div>';
      h+='</div></div>';
    }
    h+='</div>';
    panel.innerHTML=h;
    // Scroll to bottom
    var body=panel.querySelector('.ops-body');
    if(body)body.scrollTop=body.scrollHeight;
  }

  // ── Element highlight ──
  function highlightElement(el){
    removeHighlight();
    if(!el)return;
    highlightedEl=el;
    el.classList.add('cds-el-highlight');
    el.scrollIntoView({block:'center',behavior:'smooth'});
  }

  function removeHighlight(){
    if(highlightedEl){
      highlightedEl.classList.remove('cds-el-highlight');
      highlightedEl=null;
    }
  }

  // ── AI Cursor (SVG pointer + trajectory animation) ──
  var aiCursorEl=null;
  var aiCursorPos={x:-40,y:-40};

  function ensureCursor(){
    if(aiCursorEl)return aiCursorEl;
    var el=document.createElement('div');
    el.id='cds-ai-cursor';
    el.setAttribute('data-page-agent-ignore','');
    el.innerHTML='<svg width="18" height="22" viewBox="0 0 18 22" fill="none" style="position:relative;z-index:2"><defs><linearGradient id="cds-cg" x1="0" y1="0" x2="18" y2="22"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient></defs><path d="M1.5 1v17.5l4.5-4.5 3 7 2.5-1-3-7h6.5L1.5 1z" fill="url(#cds-cg)" stroke="#1e3a5f" stroke-width="0.8" stroke-linejoin="round"/><path d="M4 14.5l1 2" stroke="#fff" stroke-width="0.5" opacity="0.5"/></svg><div class="cursor-ring"></div><div class="cursor-ring2"></div>';
    el.style.left=aiCursorPos.x+'px';
    el.style.top=aiCursorPos.y+'px';
    document.body.appendChild(el);
    aiCursorEl=el;
    return el;
  }

  function moveCursorTo(x,y,callback){
    var cursor=ensureCursor();
    cursor.classList.add('visible');
    // Start from current position
    cursor.style.left=aiCursorPos.x+'px';
    cursor.style.top=aiCursorPos.y+'px';
    // Trigger reflow for transition
    cursor.offsetHeight;
    // Animate to target
    aiCursorPos.x=x;
    aiCursorPos.y=y;
    cursor.style.left=x+'px';
    cursor.style.top=y+'px';
    // Wait for transition to complete (400ms) + dwell (300ms)
    setTimeout(function(){
      if(callback)callback();
    },700);
  }

  function hideCursor(){
    if(aiCursorEl){
      aiCursorEl.classList.remove('visible');
    }
  }

  // ── Animated action execution (cursor → highlight → execute) ──
  // Cursor and highlight STAY visible after execution — they persist until the
  // next command arrives, so the user can always see where AI last operated.
  function executeWithAnimation(el,action,params,callback){
    if(!el){
      // No element to animate (snapshot, scroll, navigate, evaluate)
      if(action!=='snapshot'){removeHighlight();}
      var result=executeAction(action,params);
      if(callback)callback(result);
      return;
    }
    // Clear previous highlight
    removeHighlight();
    // Step 1: Move cursor to element center
    var rect=el.getBoundingClientRect();
    var cx=rect.left+rect.width/2;
    var cy=rect.top+rect.height/2;
    moveCursorTo(cx,cy,function(){
      // Step 2: Highlight element (pulsing ring)
      highlightElement(el);
      // Step 3: Execute after brief highlight display
      setTimeout(function(){
        var result=executeAction(action,params);
        // Step 4: After click, switch highlight to fade-out (3s)
        // Cursor STAYS at position — user sees where AI clicked
        if(highlightedEl){
          highlightedEl.classList.remove('cds-el-highlight');
          highlightedEl.classList.add('cds-el-highlight-fade');
          var fadeEl=highlightedEl;
          setTimeout(function(){
            fadeEl.classList.remove('cds-el-highlight-fade');
          },3000);
          highlightedEl=null;
        }
        if(callback)callback(result);
      },200);
    });
  }

  // ── Console / Network interceptors ──
  var origConsoleError=console.error;
  console.error=function(){
    var msg=Array.prototype.slice.call(arguments).join(' ');
    bridgeConsoleErrors.push(msg.slice(0,500));
    if(bridgeConsoleErrors.length>20)bridgeConsoleErrors.shift();
    origConsoleError.apply(console,arguments);
  };

  var origFetch=window.fetch;
  window.fetch=function(){
    return origFetch.apply(this,arguments).then(function(res){
      if(!res.ok){
        bridgeNetworkErrors.push(res.status+' '+res.url.slice(0,200));
        if(bridgeNetworkErrors.length>10)bridgeNetworkErrors.shift();
      }
      return res;
    });
  };

  // ── DOM Tree Extractor ──
  // Produces a simplified text representation of the page DOM
  // with indexed interactive elements for agent consumption.

  var INTERACTIVE_TAGS={'A':1,'BUTTON':1,'INPUT':1,'TEXTAREA':1,'SELECT':1,'DETAILS':1,'SUMMARY':1};
  var INTERACTIVE_ROLES={'button':1,'link':1,'tab':1,'menuitem':1,'checkbox':1,'radio':1,'switch':1,'slider':1,'textbox':1,'combobox':1,'listbox':1,'option':1};
  var STATE_CLASSES=['active','disabled','selected','checked','open','closed','expanded','collapsed','current','error','loading','hidden'];
  var SKIP_TAGS={'SCRIPT':1,'STYLE':1,'NOSCRIPT':1,'SVG':1,'PATH':1,'META':1,'LINK':1,'BR':1,'HR':1};
  var KEEP_ATTRS=['href','type','placeholder','value','name','role','aria-label','aria-expanded','data-state','title','for','target','checked','disabled','readonly','contenteditable'];
  var MAX_DEPTH=15;
  var MAX_NODES=500;

  function isVisible(el){
    if(!el.offsetParent&&el.tagName!=='BODY'&&el.tagName!=='HTML'){
      var s=window.getComputedStyle(el);
      if(s.display==='none'||s.visibility==='hidden')return false;
      if(s.position!=='fixed'&&s.position!=='sticky')return false;
    }
    var r=el.getBoundingClientRect();
    return r.width>0||r.height>0;
  }

  function isInteractive(el){
    if(INTERACTIVE_TAGS[el.tagName])return true;
    var role=el.getAttribute('role');
    if(role&&INTERACTIVE_ROLES[role])return true;
    if(el.getAttribute('onclick')||el.getAttribute('tabindex'))return true;
    if(el.contentEditable==='true')return true;
    return false;
  }

  function getStateClasses(el){
    var result=[];
    var cls=el.className;
    if(typeof cls==='string'){
      for(var i=0;i<STATE_CLASSES.length;i++){
        if(cls.indexOf(STATE_CLASSES[i])>=0)result.push(STATE_CLASSES[i]);
      }
    }
    return result;
  }

  function extractDomTree(){
    bridgeInteractiveElements=[];
    var nodeCount={v:0};
    var lines=[];
    walkNode(document.body,0,lines,nodeCount);
    return lines.join('\\n');
  }

  function walkNode(node,depth,lines,nodeCount){
    if(nodeCount.v>=MAX_NODES||depth>MAX_DEPTH)return;
    if(node.nodeType===3){
      var txt=node.textContent.trim();
      if(txt){
        var indent='';for(var d=0;d<depth;d++)indent+='  ';
        lines.push(indent+txt.slice(0,200));
        nodeCount.v++;
      }
      return;
    }
    if(node.nodeType!==1)return;
    var el=node;
    if(SKIP_TAGS[el.tagName])return;
    if(el.getAttribute('data-cds-widget-root')!==null)return;
    if(el.getAttribute('data-page-agent-ignore')!==null)return;
    if(!isVisible(el))return;

    var indent='';for(var d=0;d<depth;d++)indent+='  ';
    var tag=el.tagName.toLowerCase();
    var interactive=isInteractive(el);
    var prefix='';

    if(interactive){
      var idx=bridgeInteractiveElements.length;
      bridgeInteractiveElements.push(el);
      prefix='['+idx+']';
    }

    // Build attribute string
    var attrs='';
    for(var a=0;a<KEEP_ATTRS.length;a++){
      var val=el.getAttribute(KEEP_ATTRS[a]);
      if(val!==null&&val!==''){
        // Truncate long values
        if(val.length>100)val=val.slice(0,100)+'…';
        attrs+=' '+KEEP_ATTRS[a]+'="'+val.replace(/"/g,'&quot;')+'"';
      }
    }

    // Add state classes
    var sc=getStateClasses(el);
    if(sc.length)attrs+=' class="'+sc.join(' ')+'"';

    // Check for input value
    if((el.tagName==='INPUT'||el.tagName==='TEXTAREA')&&el.value){
      attrs+=' value="'+el.value.slice(0,100).replace(/"/g,'&quot;')+'"';
    }

    // Get direct text content (not from children)
    var directText='';
    for(var c=el.childNodes,ci=0;ci<c.length;ci++){
      if(c[ci].nodeType===3){
        var t=c[ci].textContent.trim();
        if(t)directText+=(directText?' ':'')+t;
      }
    }
    if(directText.length>200)directText=directText.slice(0,200)+'…';

    // If leaf element with only text content
    var hasChildElements=false;
    for(var ch=el.children,chi=0;chi<ch.length;chi++){
      if(!SKIP_TAGS[ch[chi].tagName]&&isVisible(ch[chi])){hasChildElements=true;break;}
    }

    if(!hasChildElements&&directText){
      lines.push(indent+prefix+'<'+tag+attrs+'> '+directText+' />');
      nodeCount.v++;
    }else if(hasChildElements){
      lines.push(indent+prefix+'<'+tag+attrs+'>');
      nodeCount.v++;
      for(var k=0;k<el.children.length;k++){
        walkNode(el.children[k],depth+1,lines,nodeCount);
      }
      lines.push(indent+'/>');
    }else if(interactive||tag==='img'){
      lines.push(indent+prefix+'<'+tag+attrs+' />');
      nodeCount.v++;
    }
    // else: skip non-interactive empty elements
  }

  // ── Page State Collector ──
  function collectPageState(){
    return {
      url:location.href,
      title:document.title,
      domTree:extractDomTree(),
      viewport:{width:window.innerWidth,height:window.innerHeight},
      scrollPosition:{x:window.scrollX,y:window.scrollY},
      consoleErrors:bridgeConsoleErrors.slice(),
      networkErrors:bridgeNetworkErrors.slice(),
      timestamp:Date.now()
    };
  }

  // ── Action Executor ──
  function executeAction(action,params){
    try{
      if(action==='snapshot'){
        return {success:true};
      }
      if(action==='click'){
        var clickEl=bridgeInteractiveElements[params.index];
        if(!clickEl)return {success:false,error:'element index '+params.index+' not found'};
        // Highlight target element
        highlightElement(clickEl);
        // Scroll into view
        clickEl.scrollIntoView({block:'center',behavior:'instant'});
        // Full click simulation
        var rect=clickEl.getBoundingClientRect();
        var cx=rect.left+rect.width/2;
        var cy=rect.top+rect.height/2;
        var evtOpts={bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0};
        clickEl.dispatchEvent(new PointerEvent('pointerdown',evtOpts));
        clickEl.dispatchEvent(new MouseEvent('mousedown',evtOpts));
        if(clickEl.focus)clickEl.focus();
        clickEl.dispatchEvent(new PointerEvent('pointerup',evtOpts));
        clickEl.dispatchEvent(new MouseEvent('mouseup',evtOpts));
        clickEl.dispatchEvent(new MouseEvent('click',evtOpts));
        return {success:true};
      }
      if(action==='type'){
        var typeEl=bridgeInteractiveElements[params.index];
        if(!typeEl)return {success:false,error:'element index '+params.index+' not found'};
        highlightElement(typeEl);
        typeEl.focus();
        if(params.clear){
          // Use native setter for React compatibility
          var nativeSet=Object.getOwnPropertyDescriptor(
            typeEl.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value'
          );
          if(nativeSet&&nativeSet.set){
            nativeSet.set.call(typeEl,'');
          }else{
            typeEl.value='';
          }
          typeEl.dispatchEvent(new Event('input',{bubbles:true}));
        }
        // Type each character via InputEvent for framework compatibility
        var text=params.text||'';
        for(var ti=0;ti<text.length;ti++){
          typeEl.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text[ti]}));
          // For React: use native setter
          var ns2=Object.getOwnPropertyDescriptor(
            typeEl.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value'
          );
          if(ns2&&ns2.set){
            ns2.set.call(typeEl,typeEl.value+text[ti]);
          }else{
            typeEl.value+=text[ti];
          }
          typeEl.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text[ti]}));
        }
        typeEl.dispatchEvent(new Event('change',{bubbles:true}));
        return {success:true};
      }
      if(action==='scroll'){
        var px=params.pixels||300;
        var dir=params.direction==='up'?-1:1;
        window.scrollBy(0,dir*px);
        return {success:true};
      }
      if(action==='navigate'){
        var navUrl=params.url;
        // Same-origin check
        if(navUrl.indexOf('http')===0){
          try{
            var nu=new URL(navUrl);
            if(nu.origin!==location.origin)return {success:false,error:'cross-origin navigation not allowed'};
          }catch(e){return {success:false,error:'invalid url'};}
        }
        window.location.href=navUrl;
        return {success:true};
      }
      if(action==='spa-navigate'){
        // SPA navigation without page reload — preserves sessionStorage token.
        // Uses CustomEvent dispatched to window, caught by React's NavigationBridge
        // component which calls useNavigate() internally.
        var spaUrl=params.url;
        if(!spaUrl)return {success:false,error:'url is required'};
        window.dispatchEvent(new CustomEvent('bridge:navigate',{detail:{path:spaUrl}}));
        return {success:true,data:'bridge:navigate dispatched'};
      }
      if(action==='evaluate'){
        var result;
        try{result=eval(params.script);}catch(e){return {success:false,error:e.message};}
        var resultStr;
        try{resultStr=JSON.stringify(result);}catch(e2){resultStr=String(result);}
        if(resultStr&&resultStr.length>10240)resultStr=resultStr.slice(0,10240)+'…(truncated)';
        return {success:true,data:resultStr};
      }
      return {success:false,error:'unknown action: '+action};
    }catch(e){
      return {success:false,error:e.message||String(e)};
    }
  }

  // ── On-Demand Bridge Connection ──
  // Widget does NOT poll by default. It periodically checks a lightweight
  // activation endpoint. Only when an Agent starts a session does the
  // full heartbeat loop begin. This avoids "Bridge 已连接" noise when
  // no Agent is operating.

  var bridgeActive=false;   // true = Agent started a session, poll heartbeat
  var bridgeCheckTimer=null; // lightweight activation check
  var bridgeActiveTimer=null; // full heartbeat poll

  // Lightweight check: is there an active session for this branch? (no body, no state)
  function bridgeCheckActivation(){
    fetch(API+'/bridge/check/'+BRANCH_ID)
      .then(function(r){
        if(!r.ok){console.warn('[CDS Bridge] Check returned '+r.status);return null;}
        return r.json();
      })
      .then(function(d){
        if(!d)return;
        if(d.active&&!bridgeActive){
          bridgeActive=true;
          bridgeConnected=true;
          console.log('[CDS Bridge] Activated by Agent');
          renderBridgeIndicator();
          // Start fast polling (500ms interval for quick command delivery)
          bridgePoll();
          bridgeActiveTimer=setInterval(bridgePoll,500);
        }
      })
      .catch(function(e){console.error('[CDS Bridge] Check error:',e);});
  }

  // Fast polling heartbeat (500ms interval via setInterval).
  function bridgePoll(){
    if(!bridgeActive)return;
    var state=collectPageState();
    fetch(API+'/bridge/heartbeat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({branchId:BRANCH_ID,state:state})
    })
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      if(!d)return;
      var cmd=d.command;
      if(cmd&&cmd.id&&cmd.action){
        var desc=cmd.description||actionLabel(cmd.action);
        console.log('[CDS Bridge] Executing: '+cmd.action+' — '+desc);
        addOpsStep(cmd.id,cmd.action,desc);
        var targetEl=null;
        if((cmd.action==='click'||cmd.action==='type')&&cmd.params&&cmd.params.index!==undefined){
          targetEl=bridgeInteractiveElements[cmd.params.index]||null;
        }
        // Check for end-session signal
        if(cmd.params&&cmd.params.__end_session){
          updateOpsStep(cmd.id,'done',cmd.params.summary||'');
          addOpsStep('end','snapshot','✅ AI 操作完成');
          updateOpsStep('end','done','');
          // Fully clean up cursor and highlight
          if(aiCursorEl){aiCursorEl.remove();aiCursorEl=null;}
          removeHighlight();
          // Stop active polling
          bridgeActive=false;
          bridgeConnected=false;
          if(bridgeActiveTimer){clearInterval(bridgeActiveTimer);bridgeActiveTimer=null;}
          renderBridgeIndicator();
          // Hide panel after 5s
          setTimeout(function(){opsVisible=false;renderOpsPanel();},5000);
          var endState=collectPageState();
          fetch(API+'/bridge/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({branchId:BRANCH_ID,id:cmd.id,success:true,state:endState})}).catch(function(){});
          return;
        }
        // For navigate: send result BEFORE executing (page reload will destroy Widget)
        if(cmd.action==='navigate'){
          var preState=collectPageState();
          updateOpsStep(cmd.id,'done','');
          fetch(API+'/bridge/result',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({branchId:BRANCH_ID,id:cmd.id,success:true,state:preState})
          }).then(function(){
            executeAction('navigate',cmd.params||{});
          }).catch(function(){
            executeAction('navigate',cmd.params||{});
          });
          return;
        }
        // For all other actions: animate cursor → highlight → execute
        executeWithAnimation(targetEl,cmd.action,cmd.params||{},function(result){
          if(!result.success){
            updateOpsStep(cmd.id,'error',result.error||'');
          }
          var delay=(cmd.action==='spa-navigate')?1500:300;
          setTimeout(function(){
            if(result.success)updateOpsStep(cmd.id,'done','');
            var newState=collectPageState();
            fetch(API+'/bridge/result',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({branchId:BRANCH_ID,id:cmd.id,success:result.success,error:result.error||undefined,data:result.data||undefined,state:newState})
            }).catch(function(){});
          },delay);
        });
      }
    })
    .catch(function(){
      if(bridgeConnected){
        bridgeConnected=false;
        renderBridgeIndicator();
      }
    });
  }

  // Start lightweight activation check every 10s (very low overhead, no body)
  try{
    bridgeCheckTimer=setInterval(bridgeCheckActivation,10000);
    // First check after 2s (give page time to settle)
    setTimeout(bridgeCheckActivation,2000);
    // Also try immediately (in case 2s is too early and an error suppresses it)
    setTimeout(function(){
      try{bridgeCheckActivation();}catch(e){console.error('[CDS Bridge] Activation check error:',e);}
    },5000);
    console.log('[CDS Bridge] Initialization complete, check interval started');
  }catch(e){
    console.error('[CDS Bridge] Failed to initialize:',e);
  }

  // ── Page change detection ──
  // When URL changes (SPA navigation), trigger an immediate poll to update server
  var bridgeLastUrl=location.href;
  function checkUrlChange(){
    if(location.href!==bridgeLastUrl){
      bridgeLastUrl=location.href;
      // Re-extract DOM for new page and send heartbeat immediately
      if(bridgeActive){
        setTimeout(bridgePoll,500);
      }
    }
  }
  setInterval(checkUrlChange,1000);
  window.addEventListener('popstate',function(){
    setTimeout(checkUrlChange,300);
  });

  // ── Bridge status indicator ──
  // Small dot on the CDS badge showing bridge connection status
  function renderBridgeIndicator(){
    var existing=document.getElementById('cds-bridge-indicator');
    if(existing)existing.remove();
    if(!bridgeConnected)return;
    var dot=document.createElement('span');
    dot.id='cds-bridge-indicator';
    dot.title='Page Agent Bridge 已连接';
    dot.style.cssText='width:6px;height:6px;border-radius:50%;background:#60a5fa;box-shadow:0 0 6px #60a5fa;flex-shrink:0;animation:cds-blink 2s ease-in-out infinite';
    var badge=root.querySelector('.cds-badge');
    if(badge)badge.insertBefore(dot,badge.firstChild);
  }

  // ── Navigate Request Polling ──
  // Widget polls CDS for pending navigation requests from agents
  function pollNavigateRequests(){
    fetch(API+'/bridge/navigate-requests/'+BRANCH_ID)
      .then(function(r){return r.ok?r.json():{};})
      .then(function(d){
        var reqs=(d&&d.requests)||[];
        if(reqs.length>0&&!bridgeNavRequest){
          bridgeNavRequest=reqs[0];
          renderNavRequest();
        }
      })
      .catch(function(){});
  }
  bridgeNavPollTimer=setInterval(pollNavigateRequests,10000);

  function renderNavRequest(){
    var existing=document.getElementById('cds-nav-request');
    if(existing)existing.remove();
    if(!bridgeNavRequest)return;

    var panel=document.createElement('div');
    panel.id='cds-nav-request';
    panel.setAttribute('data-page-agent-ignore','');
    panel.style.cssText='position:fixed;left:'+pos.x+'px;bottom:'+(pos.y+42)+'px;z-index:99999;min-width:260px;max-width:380px;padding:12px 14px;border-radius:10px;background:rgba(22,27,34,0.95);backdrop-filter:blur(12px);border:1px solid rgba(96,165,250,0.4);box-shadow:0 4px 20px rgba(96,165,250,0.25);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;font-size:12px;color:#e2e8f0;animation:cds-ai-border-glow 2.5s ease-in-out infinite';

    var h='<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">';
    h+='<span style="width:8px;height:8px;border-radius:50%;background:#60a5fa;box-shadow:0 0 8px #60a5fa;animation:cds-blink 1.5s ease-in-out infinite"></span>';
    h+='<span style="font-weight:600;color:#60a5fa">AI 请求打开页面</span>';
    h+='</div>';
    h+='<div style="background:rgba(96,165,250,0.1);padding:6px 8px;border-radius:6px;margin-bottom:6px;font-family:ui-monospace,monospace;font-size:11px;color:#93c5fd;word-break:break-all">'+bridgeNavRequest.url+'</div>';
    if(bridgeNavRequest.reason){
      h+='<div style="font-size:11px;color:#8b949e;margin-bottom:8px">'+bridgeNavRequest.reason+'</div>';
    }
    h+='<div style="display:flex;gap:6px">';
    h+='<button id="cds-nav-open" style="flex:1;padding:5px 10px;border-radius:6px;border:1px solid rgba(96,165,250,0.4);background:rgba(96,165,250,0.15);color:#93c5fd;font-size:11px;cursor:pointer;font-family:inherit">打开页面</button>';
    h+='<button id="cds-nav-dismiss" style="padding:5px 10px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#8b949e;font-size:11px;cursor:pointer;font-family:inherit">忽略</button>';
    h+='</div>';

    panel.innerHTML=h;
    document.body.appendChild(panel);

    document.getElementById('cds-nav-open').onclick=function(){
      var url=bridgeNavRequest.url;
      var reqId=bridgeNavRequest.id;
      bridgeNavRequest=null;
      panel.remove();
      // Dismiss on server
      fetch(API+'/bridge/navigate-requests/'+reqId+'/dismiss',{method:'POST'}).catch(function(){});
      // Navigate
      window.location.href=url;
    };

    document.getElementById('cds-nav-dismiss').onclick=function(){
      var reqId=bridgeNavRequest.id;
      bridgeNavRequest=null;
      panel.remove();
      fetch(API+'/bridge/navigate-requests/'+reqId+'/dismiss',{method:'POST'}).catch(function(){});
    };

    // Auto-dismiss after 30s
    setTimeout(function(){
      if(bridgeNavRequest&&bridgeNavRequest.id===panel.getAttribute('data-req-id')){
        bridgeNavRequest=null;
        panel.remove();
      }
    },30000);
  }

  // ── Initial: render badge + fetch branch info to update tab title immediately ──
  render();
  fetchBranchInfo();
  initAiStream();
})();
</script>`;
}
