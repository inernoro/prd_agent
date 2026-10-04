import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';

export function AlarmIdentityPanel(): JSX.Element {
  const [form, setForm] = useState({ name: '', environment: '', location: '' });
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('正在读取通知身份…');
  useEffect(() => {
    let active = true;
    apiRequest<{identity: {instance: {id:string;name:string;environment:string;location?:string}} | null}>('/api/cds-system/alarm-identity')
      .then(({identity}) => { if (!active) return; if (identity) { setForm({ ...identity.instance, location: identity.instance.location || '' }); setId(identity.instance.id); } setNotice(identity ? '' : '尚未配置，请设置名称和环境，避免多套 CDS 通知混淆。'); })
      .catch(() => { if (active) setNotice('通知身份暂时读取失败，请刷新后重试。'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function save(): Promise<void> {
    setBusy(true); setNotice('正在保存…');
    try {
      const result = await apiRequest<{identity:{instance:{id:string}}}>('/api/cds-system/alarm-identity', {method:'PUT',body:{instance:form}});
      setId(result.identity.instance.id); setNotice('已保存，后续通知使用此身份。');
    } catch { setNotice('保存失败，请检查名称和环境，稍后重试。'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border p-4 space-y-4">
    <h2 className="text-base font-semibold">这套 CDS 在通知里叫什么</h2>
    <p className="text-sm text-muted-foreground">配置只保存在当前实例。名称用于通知和监控详情，不填写 IP、登录账号或密钥。</p>
    <div className="grid gap-4 sm:grid-cols-3">{(['name','environment','location'] as const).map((key,i) => <label key={key} className="space-y-2 text-sm">
      <span>{['实例名称（必填）','环境（必填）','位置说明（选填）'][i]}</span>
      <input className="block min-h-11 w-full rounded-md border bg-background px-3 text-base" maxLength={64} value={form[key]} disabled={busy} onChange={e=>setForm({...form,[key]:e.target.value})}/>
    </label>)}</div>
    {id ? <p className="text-sm text-muted-foreground break-all">稳定标识：{id}（改名和重启不会改变）</p> : null}
    <p className="text-sm" role="status">{notice}</p>
    <Button disabled={busy || !form.name.trim() || !form.environment.trim()} onClick={()=>void save()}>{busy?'处理中…':'保存通知身份'}</Button>
  </section>;
}
