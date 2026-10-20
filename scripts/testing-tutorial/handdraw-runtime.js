/* One calibrated hand, one active stroke. All poses are pure functions of scene time. */
window.Handdraw = {
  build(root, duration, compositionId, options = {}) {
    if (!Number.isFinite(duration) || duration < 2) throw new Error("Drawing scene needs at least two seconds");
    const arm = options.arm || {width:887,height:1774,nib:[109,36],scale:0.64};
    if (![arm.width,arm.height,arm.scale].every(v=>Number.isFinite(v)&&v>0) || !Array.isArray(arm.nib) || arm.nib.length!==2 || !arm.nib.every(Number.isFinite) || arm.nib[0]<0 || arm.nib[0]>=arm.width || arm.nib[1]<0 || arm.nib[1]>=arm.height) throw new Error("Invalid arm calibration");
    const svg = root.querySelector('svg.diagram');
    const hand = root.querySelector('.drawing-arm');
    if (!svg || !hand) throw new Error("Missing diagram or calibrated drawing arm");
    const handScale = arm.scale;
    const nib = {x:arm.nib[0]*handScale, y:arm.nib[1]*handScale};
    const width = arm.width*handScale, height = arm.height*handScale;
    hand.style.width=width+'px'; hand.style.height=height+'px';
    hand.style.transformOrigin=nib.x+'px '+nib.y+'px';
    // Author coordinates explicitly; never measure DOM layout during a seek.
    const origin=options.origin || {x:100,y:230};
    const diagramScale=options.diagramScale || {x:1,y:1};
    if (![origin.x,origin.y,diagramScale.x,diagramScale.y].every(Number.isFinite) || diagramScale.x<=0 || diagramScale.y<=0) throw new Error("Invalid diagram geometry");
    const beats=JSON.parse(svg.dataset.beats || '[]');
    if (!beats.length) throw new Error('Every drawing needs an authored narration storyboard');
    const candidates=Array.from(svg.querySelectorAll('.draw')).map((p,index)=>({p,index,beat:Number(p.dataset.beat),len:p.getTotalLength()}));
    if (!candidates.length) throw new Error("No drawable strokes");
    for (const e of candidates) {
      const moves=(e.p.getAttribute("d") || "").match(/[Mm]/g) || [];
      if (moves.length>1 || !Number.isFinite(e.len) || e.len<=0 || !Number.isInteger(e.beat) || !beats[e.beat]) throw new Error("Split disconnected or invalid strokes before drawing");
    }
    let clock=.8; const events=[];
    const readHold=Math.min(4,duration*.15);
    const lastDraw=duration-readHold-.55;
    for(let bi=0;bi<beats.length;bi++){
     const group=candidates.filter(e=>e.beat===bi);
     const wanted=Math.max(.8,Number(beats[bi].at));
     const startAt=Math.max(clock,wanted);
     const next=bi+1<beats.length?Math.min(lastDraw,Math.max(wanted+1,Number(beats[bi+1].at))):lastDraw;
     const raw=group.map(e=>Math.max(.18,Math.min(1.05,e.len/1050)));
     const rawTotal=raw.reduce((a,b)=>a+b,0)+Math.max(0,group.length-1)*.1;
     const available=Math.max(.25,next-startAt-.2);
     const scale=Math.min(1,available/Math.max(.1,rawTotal));
     clock=startAt;
     for(let gi=0;gi<group.length;gi++){
      const e=group[gi],drawSeconds=raw[gi]*scale;
      const start=clock;
      const end=start+drawSeconds;
      const before=e.p.getPointAtLength(0),after=e.p.getPointAtLength(e.len);
      const previous=events[events.length-1];
      // Leave a visible lift between independent strokes; never draw across the gap.
      const travelStart=previous?Math.max(previous.end,start-.22):Math.max(.4,start-.28);
      const last=previous?previous.after:{x:before.x+160,y:before.y+440};
      const samples=[];
      for(let j=0;j<=160;j++){const q=e.p.getPointAtLength(e.len*j/160);samples.push([q.x,q.y]);}
      e.p.style.strokeDasharray=String(e.len+1)+' '+String(e.len+1);
      e.p.style.strokeDashoffset=String(e.len+1);
      events.push({...e,wanted,start,end,drawSeconds,before,after,travelStart,last,samples});
      clock=end+.1*scale;
     }
    }
    if(clock>duration-.3) throw new Error('Authored strokes exceed the scene; reduce the drawing or revise timing');
    root.dataset.handdrawEnd=clock.toFixed(3);
    root.dataset.strokeCount=String(events.length);
    const labels=Array.from(svg.querySelectorAll('.reveal')).map(el=>({el,at:Math.max(.8,Number(beats[Number(el.dataset.beat)]?.at || 0))+.15}));
    // Reveal labels only after the box/mark that anchors them has finished.
    for(const label of labels){
      const wanted=Number(label.el.dataset.at||0);const explicit=label.el.dataset.afterStroke;
      let close=explicit?events.find(e=>e.p.id===explicit):null;
      if(explicit&&!close) throw new Error("Unknown label stroke: "+explicit);
      if(!explicit)for(const e of events){if(e.wanted<=wanted&&(!close||e.wanted>close.wanted))close=e;}
      if(close)label.at=Math.max(label.at,close.end+.08);
    }
    const allText=Array.from(svg.querySelectorAll('text')).filter(el=>!el.closest('.reveal'));
    const extras=Array.from(root.querySelectorAll('.codepanel,.callout,.bottomphrase'));
    const show=(el,v)=>{el.style.opacity=String(Math.max(0,Math.min(1,v)));};
    function render(time){
      for(const e of events){const k=Math.max(0,Math.min(1,(time-e.start)/e.drawSeconds));e.p.style.strokeDashoffset=String((e.len+1)*(1-k));}
      for(const label of labels)show(label.el,(time-label.at)/.18);
      for(const el of allText)show(el,(time-clock-.05)/.25);
      for(const el of extras)show(el,(time-clock-.25)/.35);
      const active=events.find(e=>time>=e.travelStart&&time<=e.end);
      let point=null,lift=0;
      if(active){
        if(time<active.start){
          const k=(time-active.travelStart)/Math.max(.001,active.start-active.travelStart);
          const smooth=k*k*(3-2*k);lift=Math.sin(Math.PI*k)*18;
          point={x:active.last.x+(active.before.x-active.last.x)*smooth,y:active.last.y+(active.before.y-active.last.y)*smooth-lift};
        }else{
          const u=Math.max(0,Math.min(1,(time-active.start)/active.drawSeconds));
          const n=u*160,a=Math.floor(n),b=Math.min(160,a+1),f=n-a;
          point={x:active.samples[a][0]*(1-f)+active.samples[b][0]*f,y:active.samples[a][1]*(1-f)+active.samples[b][1]*f};
        }
      }else if(events.length&&time>events[events.length-1].end&&time<events[events.length-1].end+.48){
        const e=events[events.length-1],k=(time-e.end)/.48;point={x:e.after.x+380*k*k,y:e.after.y+900*k*k};
      }else{
        const previous=events.filter(e=>time>e.end).pop();
        if(previous&&time<previous.end+.35){const k=(time-previous.end)/.35;point={x:previous.after.x+350*k*k,y:previous.after.y+900*k*k};}
      }
      if(point){
        // The calibrated tip is the transform pivot: rotation cannot make it drift.
        const angle=active&&time>=active.start?Math.sin((time-active.start)*6)*1.4:-2;
        gsap.set(hand,{x:origin.x+point.x*diagramScale.x-nib.x,y:origin.y+point.y*diagramScale.y-nib.y,rotation:angle,opacity:1});
      }else gsap.set(hand,{opacity:0});
    }
    root.handdraw = {render, events, clock, calibration:arm, origin, diagramScale};
    render(0);
    const state={time:0};
    const tl=gsap.timeline({paused:true});
    tl.to(state,{time:duration,duration,ease:'none',onUpdate:()=>render(state.time)},0);
    tl.fromTo(root.querySelector('.title'),{opacity:0,y:12},{opacity:1,y:0,duration:.5,ease:'power3.out'},.1);
    return tl;
  }
};
