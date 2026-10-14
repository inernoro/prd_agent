import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function AlarmIdentityPanel(): JSX.Element {
  const [form, setForm] = useState({ name: '', environment: '', location: '', iconUrl: '' });
  const [id, setId] = useState('');
  const [relay, setRelay] = useState<{enabled:boolean;receiverHealthy:boolean;pending:number}|null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('正在读取通知身份…');
  useEffect(() => {
    let active = true;
    apiRequest<{enabled:boolean;receiverHealthy:boolean;pending:number}>('/api/cds-system/alarm-relay').then(value=>{if(active)setRelay(value)}).catch(()=>undefined);
    apiRequest<{identity: {instance: {id:string;name:string;environment:string;location?:string;iconUrl?:string}} | null}>('/api/cds-system/alarm-identity')
      .then(({identity}) => { if (!active) return; if (identity) { setForm({ ...identity.instance, location: identity.instance.location || '', iconUrl: identity.instance.iconUrl || '' }); setId(identity.instance.id); } setNotice(identity ? '' : '尚未配置，请设置名称和环境，避免多套 CDS 通知混淆。'); })
      .catch(() => { if (active) setNotice('通知身份暂时读取失败，请刷新后重试。'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function save(): Promise<void> {
    setBusy(true); setNotice('正在保存…');
    try {
      const result = await apiRequest<{identity:{instance:{id:string}}}>('/api/cds-system/alarm-identity', {method:'PUT',body:{instance:form}});
      setId(result.identity.instance.id); setNotice('已保存。通知显示业务名称，排查详情保留来源。');
    } catch { setNotice('保存失败，请检查名称和环境，稍后重试。'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border p-4 space-y-4">
    <h2 className="text-base font-semibold">通知来源与头像</h2>
    <p className="text-sm text-muted-foreground">配置只保存在当前实例。技术名称用于排查详情，不填写 IP、登录账号或密钥。</p>
    {relay ? <p className="text-sm" role="status">{relay.enabled ? `手机通知由独立监控统一发送，主服务不重复发送。${relay.receiverHealthy ? '接收端已连接' : '接收端暂未同步，事件继续保留'}，待处理 ${relay.pending} 条。` : '手机通知由当前实例发送。'}</p> : <p className="text-sm text-muted-foreground">暂未取得发送方式，请刷新后查看。</p>}
    <div className="grid gap-4 sm:grid-cols-3">{(['name','environment','location'] as const).map((key,i) => <label key={key} className="space-y-2 text-sm">
      <span>{['实例名称（必填）','环境（必填）','位置说明（选填）'][i]}</span>
      <input className="block min-h-11 w-full rounded-md border bg-background px-3 text-base" maxLength={64} value={form[key]} disabled={busy} onChange={e=>setForm({...form,[key]:e.target.value})}/>
    </label>)}</div>
    <label className="block space-y-2 text-sm"><span>通知头像（选填）</span><input className="block min-h-11 w-full rounded-md border bg-background px-3 text-base" value={form.iconUrl} disabled={busy} onChange={e=>setForm({...form,iconUrl:e.target.value})} placeholder="独立托管的 HTTPS 图片地址"/><span className="text-muted-foreground">使用公开图片，不填写签名地址或密钥。通知保留业务名称与环境，技术身份在详情中查看。</span></label>
    {form.iconUrl ? <img src={form.iconUrl} alt="通知头像预览" className="h-12 w-12 rounded-xl" referrerPolicy="no-referrer"/> : null}
    {id ? <p className="text-sm text-muted-foreground break-all">稳定标识：{id}（改名和重启不会改变）</p> : null}
    <p className="text-sm" role="status">{notice}</p>
    <Button disabled={busy || !form.name.trim() || !form.environment.trim()} onClick={()=>void save()}>{busy?'处理中…':'保存通知身份'}</Button>
  </section>;
}
