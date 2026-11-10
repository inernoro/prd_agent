/** Runs before uploaded markup, in the opaque-origin iframe. No uploaded script is trusted. */
export function reportFrameBridge(token: string): string {
  return `<script nonce="${token}">(()=>{
    const token='${token}', limit=100000;
    let pending=false, lastHeight=0, pageScroll=false;
    const post=(kind,extra)=>parent.postMessage({kind,token,...extra},'*');
    const measure=()=>{
      pending=false;
      if(!document.body)return;
      const body=document.body, root=document.documentElement, box=body.getBoundingClientRect(), css=getComputedStyle(body);
      // scrollHeight is already rounded; ceil the fractional border box as well.
      const height=Math.max(1,Math.ceil(Math.max(box.bottom+scrollY+(parseFloat(css.marginBottom)||0),
        box.top+scrollY+body.scrollHeight+(parseFloat(css.borderTopWidth)||0)+(parseFloat(css.borderBottomWidth)||0))));
      pageScroll=height<=limit;
      root.style.setProperty('overflow-y',pageScroll?'hidden':'auto','important');
      if(height!==lastHeight){lastHeight=height;post('cds-report-height',{height});}
    };
    const schedule=()=>{if(!pending){pending=true;requestAnimationFrame(measure);}};
    addEventListener('message',event=>{
      if(event.source===parent&&event.data?.kind==='cds-report-measure'&&event.data.token===token){lastHeight=0;schedule();}
    });
    const nestedScroll=(target,delta)=>{
      for(let node=target instanceof Element?target:target?.parentElement;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement){
        const css=getComputedStyle(node);
        if(/auto|scroll/.test(css.overflowY)&&node.scrollHeight>node.clientHeight+1&&
          (delta<0?node.scrollTop>0:node.scrollTop+node.clientHeight<node.scrollHeight-1))return true;
      }
      return false;
    };
    addEventListener('wheel',event=>{
      if(!pageScroll||event.ctrlKey||event.metaKey||event.shiftKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||nestedScroll(event.target,event.deltaY))return;
      event.preventDefault();post('cds-report-scroll',{delta:event.deltaY,mode:event.deltaMode});
    },{passive:false});
    addEventListener('keydown',event=>{
      if(!pageScroll||event.ctrlKey||event.metaKey||event.altKey||event.defaultPrevented||
        event.target.closest?.('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])'))return;
      if(!['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)||nestedScroll(event.target,/Up|Home/.test(event.key)||event.shiftKey?-1:1))return;
      event.preventDefault();post('cds-report-key',{key:event.key,shift:event.shiftKey});
    });
    const start=()=>{
      // A report follows document flow rather than keeping an authored viewport-height shell.
      for(const node of [document.documentElement,document.body]){
        node.style.setProperty('height','auto','important');
        node.style.setProperty('min-height','0','important');
        node.style.setProperty('max-height','none','important');
      }
      const observer=new ResizeObserver(schedule);
      observer.observe(document.body);observer.observe(document.documentElement);
      addEventListener('resize',schedule);addEventListener('load',schedule);schedule();
    };
    if(document.readyState==='loading')addEventListener('DOMContentLoaded',start,{once:true});else start();
  })()</script>`;
}
