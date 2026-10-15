import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Section, ErrorBlock, LoadingBlock } from '../components';

type User = { id: string; name: string; status: string; projectIds: string[] };
type Project = { id: string; name: string; repository?: string };
type Connection = { id: string; agentName: string; repository: string; status: string; projectId?: string; userId?: string; candidates: Project[] };
type Legacy = { id: string; projectId: string; projectName: string; label?: string; scope: string; createdAt: string };
type Data = { users: User[]; requests: Connection[]; unclaimed: Legacy[] };
const inputCls = 'w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground';
const STATUS: Record<string, string> = { pending: '待核对', approved: '已批准，等待设备保存', delivered: '已接入', rejected: '已拒绝' };

export function IdentityRecoveryPanel({ onToast }: { onToast: (s: string) => void }): JSX.Element {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [choices, setChoices] = useState<Record<string, { userId?: string; projectId?: string }>>({});
  const [claim, setClaim] = useState(''); const [claimUser, setClaimUser] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const value = await apiRequest<Data>('/api/identity/connections', { signal }); setData(value); setError(''); }
    catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { const ctrl = new AbortController(); void load(ctrl.signal);
    const timer = setInterval(() => void load(ctrl.signal), 5000);
    return () => { ctrl.abort(); clearInterval(timer); }; }, [load]);
  async function perform(path: string, body: object, label: string, key: string): Promise<void> {
    setBusy(key); setError('');
    try { await apiRequest(path, { method: 'POST', body }); onToast(label); setClaim(''); setClaimUser(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  return <div className="space-y-5">
    <Section title="设备接入与身份恢复" description="Agent自动读取仓库；核对原账号和原项目后批准。新人无需复制密钥，身份与连接都丢失也沿用这里。">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">只恢复已授权的项目；账号停用或项目授权撤回时，请先恢复原权限。</p>
        <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw />刷新接入申请</Button>
      </div>
      {error ? <ErrorBlock message={error} /> : null}
      {!data ? <LoadingBlock label="加载设备接入申请" /> : null}
      {data?.requests.length === 0 ? <p className="py-3 text-sm text-muted-foreground">没有等待核对的设备。让原项目Agent执行接入口令，申请会自动出现。</p> : null}
      <div className="space-y-3">{data?.requests.map(r => {
        const projectId = choices[r.id]?.projectId || (r.candidates.length === 1 ? r.candidates[0].id : '');
        const userId = choices[r.id]?.userId || '';
        const users = data.users.filter(u => u.status === 'active' && u.projectIds.includes(projectId));
        return <section key={r.id} aria-label={`接入核对 ${r.agentName}`} className="rounded-md border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2"><b>{r.agentName}</b><span className="text-xs text-muted-foreground">{STATUS[r.status] || r.status}</span></div>
          <p className="my-2 break-all text-sm text-muted-foreground">申请仓库：{r.repository}</p>
          {r.status === 'pending' ? <>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">原项目<select aria-label={`原项目 ${r.agentName}`} className={inputCls} value={projectId} disabled={Boolean(busy)}
                onChange={e => setChoices(v => ({ ...v, [r.id]: { projectId: e.target.value, userId: '' } }))}>
                <option value="">选择原项目</option>{r.candidates.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
              <label className="space-y-1 text-sm">归属账号<select aria-label={`归属账号 ${r.agentName}`} className={inputCls} value={userId} disabled={Boolean(busy)}
                onChange={e => setChoices(v => ({ ...v, [r.id]: { projectId, userId: e.target.value } }))}>
                <option value="">核对账号后选择</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></label>
            </div>
            {!r.candidates.length ? <p className="mt-2 text-sm text-muted-foreground">没有匹配仓库的原项目，不会自动新建。请核对Agent所在仓库。</p> : null}
            {projectId && !users.length ? <p className="mt-2 text-sm text-muted-foreground">尚无正常账号获此项目授权。先在用户管理开通账号或恢复其原项目授权，再刷新。</p> : null}
            <div className="mt-3 flex gap-2"><Button size="sm" disabled={!projectId || !users.some(u => u.id === userId) || Boolean(busy)}
              onClick={() => void perform(`/api/identity/connections/${r.id}/approve`, { projectId, userId }, '已核对原账号与原项目，Agent将自动保存并验证连接', r.id)}>
              {busy === r.id ? '正在保存' : '批准原项目接入'}</Button>
              <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void perform(`/api/identity/connections/${r.id}/reject`, {}, '已拒绝这条设备接入申请', r.id)}>拒绝</Button></div>
          </> : <p className="text-xs text-muted-foreground">账号：{data.users.find(u => u.id === r.userId)?.name || '已核对'} · 原项目：{r.candidates.find(p => p.id === r.projectId)?.name || '已核对'}</p>}
        </section>;
      })}</div>
    </Section>
    {data && data.unclaimed.length > 0 ? <Section title="历史匿名凭据归属" description="仅由管理员核对确切凭据与账号，不按显示名推断、不批量认领。原密钥无需复制或更换，归属后跟随原账号和项目权限。">
      <div className="space-y-2">{data.unclaimed.map(k => {
        const key = `${k.projectId}/${k.id}`; return <div key={key} className="rounded-md border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm"><b>{k.projectName}</b><span>{k.label || '历史凭据'}</span><code className="text-xs text-muted-foreground">{k.id}</code>
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { setClaim(key); setClaimUser(''); }}>核对归属</Button></div>
          {claim === key ? <div className="mt-3 flex flex-wrap items-center gap-2">
            <select aria-label={`凭据归属账号 ${k.id}`} className={inputCls} value={claimUser} onChange={e => setClaimUser(e.target.value)}>
              <option value="">选择已获此项目授权的原账号</option>{data.users.filter(u => u.status === 'active' && u.projectIds.includes(k.projectId)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select><p className="text-xs text-muted-foreground">只绑定这张现有凭据，不扩大项目权限；已撤销或已有归属的凭据不能认领。</p>
            <Button size="sm" disabled={!claimUser || Boolean(busy)} onClick={() => void perform(`/api/identity/legacy-credentials/${k.projectId}/${k.id}/claim`, { userId: claimUser }, '这张历史凭据已归属原账号，后续账号和项目撤权立即生效', key)}>确认这张凭据归属</Button>
            <Button size="sm" variant="outline" onClick={() => setClaim('')}>取消核对</Button>
          </div> : null}
        </div>;
      })}</div>
    </Section> : null}
  </div>;
}
