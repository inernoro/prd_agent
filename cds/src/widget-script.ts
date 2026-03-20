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
    #cds-widget{position:fixed;left:12px;bottom:12px;z-index:99999;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;color:#e2e8f0;user-select:none;font-size:12px}
    #cds-widget *{box-sizing:border-box}
    #cds-widget .cds-badge{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;background:rgba(35,134,54,0.85);backdrop-filter:blur(8px);border:1px solid rgba(63,185,80,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.25);cursor:grab;line-height:1}
    #cds-widget .cds-badge:active{cursor:grabbing}
    #cds-widget .cds-branch{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #cds-widget .cds-tag{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.15);margin-left:2px}
    #cds-widget .cds-sha{font-size:9px;padding:1px 5px;border-radius:4px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-family:ui-monospace,SFMono-Regular,monospace;letter-spacing:0.3px}
    #cds-widget button{display:flex;align-items:center;justify-content:center;padding:2px;border-radius:4px;border:none;background:transparent;color:inherit;cursor:pointer;opacity:0.6}
    #cds-widget button:hover{opacity:1}
    #cds-widget .cds-panel{margin-bottom:4px;padding:10px 12px;border-radius:8px;background:rgba(22,27,34,0.95);backdrop-filter:blur(12px);border:1px solid rgba(63,185,80,0.3);box-shadow:0 4px 16px rgba(0,0,0,0.4);min-width:220px}
    #cds-widget .cds-deploy-btn{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;font-size:11px;cursor:pointer;width:100%;opacity:1}
    #cds-widget .cds-deploy-btn:hover{border-color:#58a6ff}
    #cds-widget .cds-deploy-btn:disabled{cursor:wait;opacity:0.5}
    #cds-widget .cds-deploy-btn.full{background:#161b22}
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

  // ── State ──
  var expanded=false;
  var deploying=false;
  var deployProfileId=null;
  var profiles=[];
  var branchStatus='';
  var commitSha='';
  var steps=[];
  var resultMsg='';
  var resultOk=true;

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
        h+='<div style="font-size:11px;color:#8b949e;margin-bottom:6px">状态: <span style="color:'+(branchStatus==='running'?'#3fb950':'#f0883e')+'">'+branchStatus+'</span></div>';
        h+='<div style="display:flex;flex-direction:column;gap:4px">';
        for(var i=0;i<profiles.length;i++){
          var p=profiles[i];
          var isThis=deploying&&deployProfileId===p.id;
          h+='<button class="cds-deploy-btn" data-profile="'+p.id+'"'+(deploying?' disabled':'')+' style="opacity:'+(deploying&&!isThis?'0.5':'1')+'">';
          h+=(isThis?'<span class="cds-spinner"></span>':ICON_REFRESH);
          h+=' 更新 '+p.name+'</button>';
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
    h+='<span class="cds-tag">CDS</span>';
    h+='<button data-action="toggle" title="'+(expanded?'收起':'展开更新面板')+'">'+(expanded?ICON_DOWN:ICON_UP)+'</button>';
    h+='<button data-action="dismiss">'+ICON_X+'</button>';
    h+='</div>';

    root.innerHTML=h;
    root.style.left=pos.x+'px';
    root.style.bottom=pos.y+'px';

    // Attach drag to badge bar
    var badge=root.querySelector('.cds-badge');
    if(badge)badge.addEventListener('mousedown',onMouseDown);
  }

  // ── Event delegation ──
  root.addEventListener('click',function(e){
    var btn=e.target.closest('button');
    if(!btn)return;
    var action=btn.getAttribute('data-action');
    if(action==='dismiss'){root.remove();return;}
    if(action==='toggle'){
      expanded=!expanded;
      if(expanded)fetchBranchInfo();
      render();
      return;
    }
    var profileId=btn.getAttribute('data-profile');
    if(profileId&&!deploying){
      doDeploy(profileId==='__all__'?undefined:profileId);
    }
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
      profiles=(res[1]&&res[1].profiles)||[];
      render();
    }).catch(function(){
      branchStatus='';
      profiles=[];
      render();
    });
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

  // ── Initial render ──
  render();
})();
</script>`;
}
