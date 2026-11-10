import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronLeft, LoaderCircle, X } from 'lucide-react';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { ChannelFields, existingChannelIds, monitorErrorMessage, useChannels } from './monitorChannels';
import './agent-monitor-connect.css';

interface Proposal { id: string; name: string; kind: string; url?: string; host?: string; port?: number; method?: string; expectedStatus?: string; existingMonitorId?: string; }
interface Session {
  id: string; expiresAt: number; projectId: string | null;
  status: 'waiting' | 'connected' | 'proposed' | 'confirming' | 'completed' | 'revoked';
  agentName?: string; proposals: Proposal[]; timeline: Array<{at: string; kind: string}>;
  result?: { monitors: Array<{id: string; name: string}>; targetIds: string[] };
}
interface Props {
  onClose(): void; onSaved(result: { targetIds: string[] }): void | Promise<void>; onBusy?(busy: boolean): void;
  onManageNotifications(): void; onUseMcp?(): void;
}
const TIMELINE: Record<string, string> = { created: '已生成接入令牌，等待智能体使用', connected: '智能体已连接', 'instructions-read': '已读取只读监控提交说明', 'proposals-submitted': '已提交监控提议，等待你确认', completed: '已确认并保存监控', revoked: '接入已取消，令牌已撤销' };
const CLIENTS = [{id:'cli',label:'命令行智能体'},{id:'ide',label:'IDE 智能体'},{id:'http',label:'自建智能体'}] as const;
const shellQuote = (value:string):string => `'${value.replace(/'/g,"'\\''")}'`;

/** Actual draft-only session; every progress item comes from the server. */
export function AgentMonitorConnect({onClose,onSaved,onBusy,onManageNotifications,onUseMcp}:Props):JSX.Element {
  const [session,setSession]=useState<Session|null>(null);
  const [secret,setSecret]=useState('');
  const [step,setStep]=useState<1|2|3>(1);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [creating,setCreating]=useState(true);
  const [ttlHours,setTtlHours]=useState<1|24>(24);
  const [generation,setGeneration]=useState(0);
  const [selected,setSelected]=useState<string[]>([]);
  const [customChannels,setCustomChannels]=useState<string[]|undefined>();
  const [copied,setCopied]=useState('');
  const [advanced,setAdvanced]=useState(false);
  const [client,setClient]=useState<typeof CLIENTS[number]['id']>('cli');
  const active=useRef<Session|null>(null);
  const proposalsSeen=useRef('');
  const channels=useChannels();
  const defaultIds=channels.data?.settings.defaultChannelIds ?? channels.data?.channels.filter(c=>c.enabled&&(!c.projects.length||(session?.projectId!=null&&c.projects.includes(session.projectId)))).map(c=>c.id) ?? [];
  const selectedChannels=existingChannelIds(customChannels??defaultIds,channels.data?.channels??[]);

  useEffect(()=>{
    let disposed=false;
    setCreating(true);setError(null);setSecret('');setSession(null);setSelected([]);setCustomChannels(undefined);
    void apiRequest<Session&{token:string}>('/api/uptime/onboarding',{method:'POST',body:{ttlHours}}).then(value=>{
      if(disposed){void apiRequest(`/api/uptime/onboarding/${value.id}`,{method:'DELETE'}).catch(()=>undefined);return;}
      const {token,...view}=value;active.current=view;setSession(view);setSecret(token);
    }).catch(e=>{if(!disposed)setError(monitorErrorMessage(e));}).finally(()=>{if(!disposed)setCreating(false);});
    return ()=>{
      disposed=true;
      const current=active.current;active.current=null;
      if(current&&current.status!=='completed'&&current.status!=='revoked')void apiRequest(`/api/uptime/onboarding/${current.id}`,{method:'DELETE'}).catch(()=>undefined);
    };
  },[generation,ttlHours]);
  const sessionId=session?.id;
  useEffect(()=>{
    if(!sessionId)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async():Promise<void>=>{
      try{
        const value=await apiRequest<Session>(`/api/uptime/onboarding/${sessionId}`);
        if(disposed||active.current?.id!==sessionId||active.current.status==='completed')return;
        active.current=value;setSession(value);
        if(value.status==='proposed'&&proposalsSeen.current!==value.id){proposalsSeen.current=value.id;setSelected(value.proposals.filter(p=>!p.existingMonitorId).map(p=>p.id));}
        if(value.status==='completed'||value.status==='revoked')return;
      }catch(e){if(!disposed){setError(monitorErrorMessage(e));if(e instanceof ApiError&&[401,404,410].includes(e.status)){setSecret('');if(e.status!==401&&active.current?.id===sessionId)active.current={...active.current,status:'revoked'};setSession(prev=>prev?{...prev,status:'revoked'}:null);return;}}}
      if(!disposed)timer=setTimeout(()=>void poll(),2000);
    };
    timer=setTimeout(()=>void poll(),500);
    return ()=>{disposed=true;clearTimeout(timer);};
  },[sessionId]);
  const close=async(next:()=>void):Promise<void>=>{
    if(busy)return;setBusy(true);onBusy?.(true);
    try{
      const current=active.current;
      if(current&&current.status!=='completed'&&current.status!=='revoked'){
        try{await apiRequest(`/api/uptime/onboarding/${current.id}`,{method:'DELETE'});}
        catch(e){if(!(e instanceof ApiError&&[404,410].includes(e.status)))throw e;}
      }
      active.current=null;setSecret('');next();
    }catch(e){setError(monitorErrorMessage(e));}
    finally{setBusy(false);onBusy?.(false);}
  };
  const origin=window.location.origin;
  const instructions=session?`${origin}${apiUrl(`/api/uptime/onboarding-agent/${session.id}/instructions`)}`:'';
  const prompt='请为我的服务找出健康检查和关键只读接口，按上面的 CDS 说明提交监控提议，等我在页面确认。不要提交密码、密钥和写入操作。';
  const snippet=session&&secret?(client==='cli'
    ?`curl --fail --silent --show-error \\\n  --header ${shellQuote(`Authorization: Bearer ${secret}`)} \\\n  ${shellQuote(instructions)}`
    :client==='ide'
      ?`请先读取本次 CDS 监控接入说明：\nGET ${instructions}\nAuthorization: Bearer ${secret}\n按响应的 submitPath 提交只读监控提议，等待我在 CDS 确认。`
      :`const response = await fetch(${JSON.stringify(instructions)}, {\n  headers: { Authorization: ${JSON.stringify(`Bearer ${secret}`)} }\n});\nif (!response.ok) throw new Error(\`CDS HTTP \${response.status}\`);\nconst instructions = await response.json();\n// 按 instructions.submitPath 提交只读提议，等待用户确认。`):'';
  const copy=async(value:string,key:string):Promise<void>=>{try{await navigator.clipboard.writeText(value);setCopied(key);}catch{setError('复制未完成，请选中文本手动复制。');}};
  const next=async():Promise<void>=>{
    if(!session||busy)return;
    if(step===1){setStep(2);return;}
    if(step===2){setStep(3);return;}
    setBusy(true);onBusy?.(true);setError(null);
    try{
      const result=await apiRequest<NonNullable<Session['result']>>(`/api/uptime/onboarding/${session.id}/confirm`,{method:'POST',body:{proposalIds:selected,...(customChannels!==undefined?{channelIds:selectedChannels}:{})}});
      const completed:Session={...session,status:'completed',result};active.current=completed;setSecret('');await onSaved(result);onClose();
    }catch(e){setError(monitorErrorMessage(e));}
    finally{setBusy(false);onBusy?.(false);}
  };
  const done=session?.status==='completed';
  return <>
    <div className="dh"><div className="dh-r"><Dialog.Title>接入我的服务</Dialog.Title><span className="sp"/>{onUseMcp&&!done&&<button type="button" className="btn ghost sm" disabled={busy} onClick={()=>void close(onUseMcp)}>连接 MCP</button>}<button type="button" className="xb" aria-label="关闭" disabled={busy} onClick={()=>void close(onClose)}><X className="ic s"/></button></div><Dialog.Description className="hint">{done?'已追加到我的订阅，等待真实观测':'把 CDS 的监控说明交给你的智能体。智能体提交只读监控提议，你在这里确认后才会生效。'}</Dialog.Description>{!done&&<div className="steps">{['交给智能体','智能体提交','确认并通知'].map((name,i)=><span key={name} className={`step${step===i+1?' on':step>i+1?' done':''}`}><i/><span>{i+1} · {name}</span></span>)}</div>}</div>
    <div className="db">
      {error&&<div role="alert" className="drawer-error">{error}<button type="button" className="linkb" onClick={()=>{setError(null);if(!session||session.status==='revoked'){setStep(1);setGeneration(v=>v+1);}}}>重试</button></div>}
      {creating?<div className="card" role="status"><LoaderCircle className="ic"/>正在生成本次接入令牌…</div>:null}
      {done?<div className="ob-done"><span className="pill ok"><Check className="ic s"/>接入完成</span><h3>已追加 {session.result?.monitors.length??0} 项监控</h3><p className="hint">第一次检查到达前显示“等待首次观测”；不会用示例数据代替检查结果。</p><div className="chrows">{session.result?.monitors.map(m=><div key={m.id} className="chrow"><span className="gl none"/><b>{m.name}</b><span className="sp"/><span className="hint">等待首次观测</span></div>)}</div></div>:session&&step===1?<>
        <div className="fld"><span className="lbl2">你的智能体</span><div className="seg agent-clients" role="group" aria-label="智能体类型">{CLIENTS.map(item=><button type="button" key={item.id} className={client===item.id?'on':''} aria-pressed={client===item.id} onClick={()=>{setClient(item.id);setCopied('');}}>{item.label}</button>)}</div></div>
        <div className="fld"><div className="sec-h"><span className="lbl2">① 让智能体读取 CDS 监控说明</span><span className="sp"/><button type="button" className="linkb" onClick={()=>void copy(snippet,'prompt')}>{copied==='prompt'?'已复制':'复制'}</button></div><pre className="code">{snippet}</pre><p className="hint">只允许提交提议 · 有效至 {new Date(session.expiresAt).toLocaleString('zh-CN')} · 完成或关闭接入后撤销</p></div>
        <div className="fld"><div className="sec-h"><span className="lbl2">② 对智能体说</span><span className="sp"/><button type="button" className="linkb" onClick={()=>void copy(prompt,'say')}>{copied==='say'?'已复制':'复制'}</button></div><div className="say">{prompt}</div></div>
        <button type="button" className="adv" aria-expanded={advanced} onClick={()=>setAdvanced(!advanced)}>{advanced?'收起高级选项':'高级选项'}</button>
        {advanced&&<div className="advb"><div className="fld"><span className="lbl2">令牌权限</span><span className="tag">仅提交提议 · 由你确认后生效</span></div><div className="fld"><label htmlFor="monitor-agent-expiry">有效期</label><select id="monitor-agent-expiry" className="inp" value={ttlHours} onChange={e=>setTtlHours(Number(e.target.value) as 1|24)} disabled={busy||session.status!=='waiting'}><option value={1}>1 小时</option><option value={24}>24 小时</option></select></div></div>}
        <div className="soft"><b>智能体会做什么</b><ol><li>读取本次接入的监控规范和可用检查方式</li><li>在你的项目里找出健康检查与只读接口</li><li>向 CDS 提交监控提议，等待你确认</li><li>确认后，由 CDS 按真实规则定时观测</li></ol></div>
      </>:session&&step===2?<>
        <div className="tl">{session.timeline.map((item,i)=><div className="tli" key={`${item.kind}:${i}`}><span className="d"/><span>{TIMELINE[item.kind]||'接入状态已更新'}</span><time className="t">{new Date(item.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></div>)}{session.status!=='proposed'&&<div className="tli wait"><span className="d"/><span>{session.status==='connected'?'等待智能体提交监控提议':'等待智能体连接'}</span></div>}</div>
        {session.status==='proposed'?<section className="sect"><h3>{session.agentName||'智能体'} 提交了 {session.proposals.length} 项提议</h3><p className="hint">只会追加你勾选的项目。此时尚未执行检查，也未创建监控。</p><div className="disc">{session.proposals.map(p=><label className={`di${selected.includes(p.id)?' on':''}${p.existingMonitorId?' ex':''}`} key={p.id}><input type="checkbox" disabled={!!p.existingMonitorId} checked={selected.includes(p.id)} onChange={()=>setSelected(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id])}/><span className="di-b"><b>{p.name}</b><span className="tool">{p.kind==='tcp'?`TCP ${p.host}:${p.port}`:`${p.method||'GET'} ${p.url}`}</span><span className="hint">{p.kind==='health-json'?'读取自检结果并核对所选判据':p.kind==='tcp'?'检查端口连通性':`预期状态码 ${p.expectedStatus||'200-399'}`}</span></span><span className="tag">{p.existingMonitorId?'已有监控':'只读'}</span></label>)}</div></section>:<p className="hint">收到提议后会在这里逐项列出；当前尚未创建任何监控。</p>}
      </>:session&&step===3?<>
        <section className="sect"><h3>异常时通知</h3><p className="hint">默认沿用当前通知设置；你也可以为这次追加的服务单独选择通道。</p>{channels.loading?<ContentLoading label="读取通知通道" variant="rows" />:channels.error?<div role="alert" className="drawer-error">{channels.error}<button type="button" className="linkb" disabled={busy} onClick={()=>void channels.reload()}>重试加载通知通道</button></div>:channels.data?<><ChannelFields data={channels.data} selected={selectedChannels} projectId={session.projectId} disabled={busy} onToggle={id=>setCustomChannels(selectedChannels.includes(id)?selectedChannels.filter(v=>v!==id):[...selectedChannels,id])} onManage={()=>void close(onManageNotifications)}/>{customChannels!==undefined&&<button type="button" className="linkb" onClick={()=>setCustomChannels(undefined)}>恢复沿用默认</button>}</>:null}<div className="hint">沿用系统当前异常与恢复通知规则；服务未收到有效观测前不会显示正常。</div></section>
        <section className="sect"><h3>将追加 {selected.length} 项服务</h3><div className="chrows">{session.proposals.filter(p=>selected.includes(p.id)).map(p=><div className="chrow" key={p.id}><Check className="ic xs"/>{p.name}</div>)}</div></section>
      </>:null}
    </div>
    <div className="df">{done?<><span className="sp"/><button type="button" className="btn pri" onClick={onClose}>查看我的订阅</button></>:<>{step>1&&<button type="button" className="btn ghost" disabled={busy} onClick={()=>setStep(step===3?2:1)}><ChevronLeft className="ic s"/>上一步</button>}<button type="button" className="btn ghost" disabled={busy} onClick={()=>void close(onClose)}>取消</button><span className="sp"/><button type="button" className="btn pri" disabled={creating||busy||!session||session.status==='revoked'||(step>1&&!selected.length)||(step===3&&(channels.loading||!!channels.error))} onClick={()=>void next()}>{busy?'正在保存…':step===1?'已交给智能体':step===2?(session?.status==='proposed'?`确认 ${selected.length} 项，下一步`:'等待智能体提交…'):'完成接入'}</button></>}</div>
  </>;
}
