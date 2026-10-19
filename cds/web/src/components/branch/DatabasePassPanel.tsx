import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';
import { databasePassState } from '@/lib/databasePassState';

interface Pass {
  id:string;username:string;database:string;runtime:string;host:string;port?:number;
  status:string;allowlist:string[];ttlMinutes:number;expiresAt:string;reason?:string;
}
interface Overview {
  capability:{enabled:boolean;host:string;defaultTtlMinutes:number;reason:string};
  currentIp:string;passes:Pass[];events:Array<{ts:string;passId:string;event:string;ip?:string;reason?:string;count?:number}>;
}
const statusNames:Record<string,string>={prepared:'待放行',active:'已放行',expired:'已到期并回收',revoked:'已撤销并回收','cleanup-failed':'入口关闭，账号回收重试中',preparing:'准备中'};
const eventNames:Record<string,string>={'review-approved':'范围审查通过','account-prepared':'独立账号已准备','credentials-copied':'复制凭据','activation-approved':'放行审查通过',activated:'入口已放行','connection-accepted':'网络连接通过白名单','connection-denied':'网络连接被拒','connection-closed':'连接已断开','account-reclaimed':'账号已回收','account-cleanup-failed':'账号回收待重试','authentication-denied':'账号或协议不匹配，连接被拒','connection-denials-summarized':'重复拒绝连接汇总','audit-record-damaged':'部分审计记录不完整，原始证据已保留'};

export function DatabasePassPanel({branchId,resourceId,allowed,onCopy}:{branchId:string;resourceId:string;allowed:boolean;onCopy:(value:string)=>Promise<void>}):JSX.Element {
  const base=`/api/branches/${encodeURIComponent(branchId)}/resources/${encodeURIComponent(resourceId)}/database-passes`;
  const generation=useRef(0);
  const [overview,setOverview]=useState<Overview|null>(null);
  const [ip,setIp]=useState('');const [ttl,setTtl]=useState('30');
  const [busy,setBusy]=useState('');const [error,setError]=useState('');const [loadError,setLoadError]=useState('');const [notice,setNotice]=useState('');
  const [now,setNow]=useState(Date.now());
  const load=useCallback(async(scope:number)=>{const value=await apiRequest<Overview>(base);if(scope===generation.current){setOverview(value);setLoadError('');setIp(current=>current||value.currentIp);}},[base]);
  useEffect(()=>{
    ++generation.current;
    setOverview(null);setIp('');setError('');setLoadError('');setNotice('');setBusy('');setTtl('30');
    if(!allowed)return;
    let cancelled=false;
    const refresh=async()=>{try{const value=await apiRequest<Overview>(base);if(!cancelled){setOverview(value);setLoadError('');setIp(current=>current||value.currentIp);}}catch(e){if(!cancelled)setLoadError(e instanceof Error?e.message:'无法读取通行证');}};
    void refresh();const timer=window.setInterval(()=>{setNow(Date.now());void refresh();},5000);
    return()=>{cancelled=true;++generation.current;window.clearInterval(timer);};
  },[base,allowed]);
  async function run(key:string,action:(current:()=>boolean)=>Promise<unknown>){
    const scope=generation.current,current=()=>scope===generation.current;
    setBusy(key);setError('');setNotice('');
    try{const message=await action(current);if(!current())return;if(typeof message==='string')setNotice(message);await load(scope);}
    catch(e){if(current())setError(e instanceof Error?e.message:'操作未完成，请重试');}
    finally{if(current())setBusy('');}
  }
  if(!allowed)return <div className="rounded border border-border p-3 text-xs text-muted-foreground">数据库通行证需要项目管理员审查和签发；当前角色没有放行权限。</div>;
  const {latest,terminal,current}=databasePassState(overview?.passes||[]);
  return <section className="space-y-3 rounded-md border border-border bg-background/50 p-3" aria-label="数据库通行证">
    <div className="flex flex-wrap items-center gap-2"><ShieldCheck className="h-4 w-4"/><h3 className="text-sm font-semibold">数据库通行证 · 本地工具直连</h3><span className="text-xs text-muted-foreground">默认只读 · 30 分钟 · 独立临时账号</span></div>
    <p className="text-xs leading-5 text-muted-foreground">申请后复制账号、密码和 TLS 证书，再放行白名单。期限从成功放行开始；到期断开现有连接并回收账号。当前 IP 是本次页面访问的来源，数据库工具经 VPN 或内网访问时可能不同，请核对。</p>
    {overview?.capability.enabled?<p className="text-xs">直连主机：<code>{overview.capability.host}</code>。网络需能访问该地址；内网地址仅供内网验收。</p>:<p className="text-xs text-muted-foreground">{overview?.capability.reason||'正在读取实例通行证配置…'}</p>}
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
      <label className="grid min-w-0 gap-1 text-xs">白名单 IP（每行一个 IPv4/CIDR）<textarea aria-label="通行证白名单 IP" disabled={!!busy||!!current} value={current?current.allowlist.join('\n'):ip} onChange={e=>setIp(e.target.value)} className="h-10 min-h-10 min-w-0 rounded border border-border bg-background px-2 py-2 font-mono" rows={1}/></label>
      <label className="grid min-w-0 gap-1 text-xs">有效期（分钟）<input aria-label="通行证有效期" disabled={!!busy||!!current} type="number" min={1} max={30} value={current?String(current.ttlMinutes):ttl} onChange={e=>setTtl(e.target.value)} className="h-10 min-w-0 rounded border border-border bg-background px-2 font-mono"/></label>
    </div>
    {current?<p className="text-xs text-muted-foreground">当前通行证的白名单和期限已固定；如需调整，请先撤销再申请。</p>:null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!overview?.currentIp||!!busy||!!current} onClick={()=>{setIp(overview?.currentIp||'');setNotice('已选择页面当前 IP。');}}>使用当前 IP{overview?.currentIp?` · ${overview.currentIp}`:''}</Button>
      <Button size="sm" disabled={!!busy||!overview?.capability.enabled||!!current} onClick={()=>void run('prepare',async()=>{
        const minutes=Number(ttl);if(!Number.isInteger(minutes)||minutes<1||minutes>30)throw new Error('有效期须为1–30分钟');
        const allowlist=ip.split(/[\n,]/).map(x=>x.trim()).filter(Boolean);if(!allowlist.length)throw new Error('请填写白名单 IP');
        await apiRequest(base,{method:'POST',body:{allowlist,ttlMinutes:minutes}});return '临时账号已准备，入口尚未放行。请先复制，再放行。';
      })}>{busy==='prepare'?<Loader2 className="animate-spin"/>:null}申请通行证</Button>
    </div>
    {current?<div className="space-y-2 rounded border border-border p-3 text-xs">
      <div className="font-semibold">{statusNames[current.status]||current.status}</div>
      <div className="grid gap-1 font-mono"><span>账号：{current.username}</span><span>密码：独立随机生成，复制时提供，不写入日志</span><span>数据库：{current.database} · 只读</span><span>地址：{current.host}:{current.port}</span><span>白名单：{current.allowlist.join(', ')}</span></div>
      {current.status==='active'?<p>有效期至 {new Date(current.expiresAt).toLocaleString()} · 剩余 {Math.max(0,Math.ceil((Date.parse(current.expiresAt)-now)/60000))} 分钟</p>:null}
      {current.reason?<p>{current.reason}</p>:null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!!busy||!['prepared','active'].includes(current.status)} onClick={()=>void run('copy',async(isCurrent)=>{
          const credentials=await apiRequest<Record<string,unknown>>(`${base}/${current.id}/credentials`);
          if(!isCurrent())return;await onCopy(JSON.stringify(credentials,null,2));return '连接信息已复制，包含独立账号、密码与TLS CA。请将tlsCa保存为证书文件，并在客户端开启证书验证。';
        })}><Copy/>复制连接信息</Button>
        <Button size="sm" disabled={!!busy||current.status!=='prepared'} onClick={()=>void run('activate',async()=>{
          await apiRequest(`${base}/${current.id}/activate`,{method:'POST',body:{}});return '已放行该通行证的白名单，到期会断连回收。复制成功不代表客户端已连接。';
        })}>{busy==='activate'?<Loader2 className="animate-spin"/>:null}放行当前白名单</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={()=>void run('revoke',()=>apiRequest(`${base}/${current.id}`,{method:'DELETE'}))}>撤销通行证</Button>
      </div>
    </div>:null}
    {notice&&!terminal?<p className="text-xs leading-5" role="status">{notice}</p>:null}
    {overview?.events.some(e=>e.event==='audit-record-damaged')?<p className="rounded border border-warn/30 bg-warn/10 p-2 text-xs" role="alert">部分审计记录不完整，原始文件已保留，请管理员核对；仍可查看和撤销现有通行证。</p>:null}
    {loadError?<p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs" role="alert">{loadError}</p>:null}
    {error?<p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs" role="alert">{error}</p>:null}
    {overview?.events.length?<details className="text-xs"><summary className="cursor-pointer">审计记录（{overview.events.length}）</summary><div className="mt-2 max-h-44 space-y-1 overflow-auto font-mono">{overview.events.slice(0,30).map((event,index)=><div key={event.ts+index}>{new Date(event.ts).toLocaleTimeString()} · {eventNames[event.event]||event.event}{event.ip?` · ${event.ip}`:''}{event.count?` · ${event.count} 次`:''}</div>)}</div></details>:null}
    {terminal&&latest?<p className="rounded border border-border p-2 text-xs" role="status">最近通行证 {latest.username}：{statusNames[latest.status]}。重新访问须申请新通行证。</p>:null}
  </section>;
}
