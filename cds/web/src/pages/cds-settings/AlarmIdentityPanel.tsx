import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { SettingsContentSkeleton } from '@/components/skeletons/SettingsSkeleton';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';

type SourceForm = { name: string; environment: string; location: string; iconUrl: string };
type RelayStatus = { enabled: boolean; receiverHealthy?: boolean; pending: number; productionChangesReady?: boolean };
const EMPTY: SourceForm = { name: '', environment: '', location: '', iconUrl: '' };
export function AlarmIdentityPanel(): JSX.Element {
  const [form, setForm] = useState<SourceForm>(EMPTY);
  const [saved, setSaved] = useState<SourceForm | null>(null);
  const [id, setId] = useState('');
  const [relay, setRelay] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [relayLoading, setRelayLoading] = useState(true);
  const [relayRevision, setRelayRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [readError, setReadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const requestedEdit = useRef(false);
  useEffect(() => {
    let active = true;
    setInitialLoading(true); setReadError(false);
    apiRequest<{identity: {instance: {id:string;name:string;environment:string;location?:string;iconUrl?:string}} | null}>('/api/cds-system/alarm-identity')
      .then(({identity}) => { if (!active) return; const source=identity?{name:identity.instance.name,environment:identity.instance.environment,location:identity.instance.location||'',iconUrl:identity.instance.iconUrl||''}:null; setSaved(source); setForm(source||EMPTY); setId(identity?.instance.id||''); setEditing(!source?.name||!source.environment); })
      .catch(() => { if(active)setReadError(true); })
      .finally(() => { if(active)setInitialLoading(false); });
    return () => { active = false; };
  }, [revision]);
  useEffect(()=>{let active=true;setRelayLoading(true);apiRequest<RelayStatus>('/api/cds-system/alarm-relay').then(value=>{if(active)setRelay(value)}).catch(()=>{if(active)setRelay(null)}).finally(()=>{if(active)setRelayLoading(false)});return()=>{active=false}},[relayRevision]);
  useLayoutEffect(()=>{if(editing&&requestedEdit.current){requestedEdit.current=false;nameRef.current?.focus();}},[editing]);
  async function save(): Promise<void> {
    setBusy(true); setNotice(''); const submitted={...form};
    try {
      const result = await apiRequest<{identity:{instance:{id:string}}}>('/api/cds-system/alarm-identity', {method:'PUT',body:{instance:submitted}});
      setId(result.identity.instance.id); setSaved(submitted); setEditing(false); setNotice('通知来源已保存。');
      requestAnimationFrame(()=>editRef.current?.focus());
    } catch { setUnconfirmed(true); setNotice('通知来源保存结果未确认。请先核对实际配置，避免重复提交；当前输入仍保留。'); }
    finally { setBusy(false); }
  }
  useEffect(()=>{if(!notice||unconfirmed)return;const timer=setTimeout(()=>setNotice(''),3000);return()=>clearTimeout(timer);},[notice,unconfirmed]);
  const cancel=()=>{setForm(saved||EMPTY);setEditing(false);setNotice('');requestAnimationFrame(()=>editRef.current?.focus());};
  return <section className="space-y-3 border-b border-border pb-4" aria-label="通知来源">
    {initialLoading ? <SettingsContentSkeleton label="读取通知身份" /> : readError ? <div role="alert" className="space-y-2 text-sm"><p>通知来源读取失败，暂不能确认名称与环境。</p><Button className="min-h-[3.25rem]" variant="outline" onClick={()=>setRevision(x=>x+1)}>重新读取通知来源</Button></div> : <>
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><h2 className="text-base font-semibold">{editing?'通知来源与头像':saved?.name}</h2>{!editing&&saved?<p className="break-words text-sm text-muted-foreground">{saved.environment}{saved.location?` · ${saved.location}`:''}</p>:null}</div>{!editing?<Button ref={editRef} className="min-h-[3.25rem]" variant="outline" onClick={()=>{requestedEdit.current=true;setEditing(true)}}>编辑通知来源</Button>:null}</div>
    {relayLoading ? <ContentLoading label="读取通知发送方式" variant="inline" /> : <p className="text-sm text-muted-foreground">{relay ? relay.enabled ? `独立监控统一发送，主服务不重复发送。${relay.receiverHealthy===true?'接收端已连接':relay.receiverHealthy===false?'接收端暂未同步，事件继续保留':'接收端状态未确认'}，待处理 ${relay.pending} 条。` : '通知由当前实例发送。' : '发送方式暂未确认。'}</p>}
    {!relayLoading && relay?.enabled && relay.receiverHealthy && relay.productionChangesReady === false
      ? <p className="text-sm text-muted-foreground">等待独立接收端升级，正式环境变更会保留在待投递队列。</p> : null}
    {!relayLoading&&!relay?<Button className="min-h-[3.25rem]" variant="outline" onClick={()=>setRelayRevision(x=>x+1)}>重新读取发送方式</Button>:null}
    {editing?<div className="space-y-3"><p className="text-sm text-muted-foreground">仅修改当前实例的通知显示名称与环境。不填写 IP、登录账号或密钥。</p>
    <fieldset disabled={busy||unconfirmed} className="min-w-0 space-y-3"><div className="grid gap-3 sm:grid-cols-3">{(['name','environment','location'] as const).map((key,i) => <label key={key} className="block space-y-1 text-sm"><span>{['实例名称（必填）','环境（必填）','位置说明（选填）'][i]}</span><input ref={key==='name'?nameRef:undefined} className="block min-h-[3.25rem] w-full rounded-md border border-border bg-background px-3 text-base" maxLength={64} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}</div>
    <label className="block space-y-1 text-sm"><span>通知头像（选填）</span><input className="block min-h-[3.25rem] w-full rounded-md border border-border bg-background px-3 text-base" value={form.iconUrl} onChange={e=>setForm({...form,iconUrl:e.target.value})} placeholder="独立托管的 HTTPS 图片地址"/><span className="text-muted-foreground">使用公开图片，不填写签名地址或密钥。技术身份在通知详情中查看。</span></label>
    {form.iconUrl?<img src={form.iconUrl} alt="通知头像预览" className="h-12 w-12 rounded-xl" referrerPolicy="no-referrer"/>:null}</fieldset>
    {id?<p className="break-all text-sm text-muted-foreground">稳定标识：{id}（改名和重启不会改变）</p>:null}
    <div className="flex flex-wrap gap-2"><Button className="min-h-[3.25rem]" disabled={busy||unconfirmed||!form.name.trim()||!form.environment.trim()} onClick={()=>void save()}>{busy?'保存中…':'保存通知身份'}</Button>{saved?<Button className="min-h-[3.25rem]" variant="outline" disabled={busy||unconfirmed} onClick={cancel}>取消编辑来源</Button>:null}</div>
    </div>:null}
    {notice?<p className="text-sm" role="status">{notice}</p>:null}
    </>}
  </section>;
}
