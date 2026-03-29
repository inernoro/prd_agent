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

  // ── Initial: render badge + fetch branch info to update tab title immediately ──
  render();
  fetchBranchInfo();
  initAiStream();
})();
</script>`;
}
