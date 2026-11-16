import { useCallback, useEffect, useState } from 'react';
import { Archive, ChevronDown, Download, RotateCcw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiRequest, apiDownload } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

type Policy = { ready: boolean; enabled: boolean; hotDays: number; lastCompletedAt: string | null; error: string };
type Batch = { id: string; source: string; status: string; from: string; to: string; count: number; rawBytes: number; storedBytes: number; migrated: number; verifiedAt: string | null; restoredAt: string | null; records: { id: string; requestId: string }[] };
const names: Record<string, string> = { api: '系统请求', llm: '模型请求', 'legacy-llm': '历史模型请求', execution: '网关执行记录' };
const states: Record<string, string> = { uploading: '正在归档', verified: '已校验', completed: '归档完成', failed: '归档中断，可重试' };
const time = (value: string) => new Date(value).toLocaleString();
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;

export default function LogArchivePanel() {
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const canWrite = isRoot || permissions.includes('super') || permissions.includes('logs.write');
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(30);
  const [items, setItems] = useState<Batch[]>([]);
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [recordOpen, setRecordOpen] = useState(false);
  const [record, setRecord] = useState('');
  const [expanded, setExpanded] = useState('');
  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (source) query.set('source', source);
    if (from) query.set('from', new Date(from).toISOString());
    if (to) query.set('to', new Date(to).toISOString());
    if (requestId) query.set('requestId', requestId);
    const res = await apiRequest<{ items: Batch[] }>(`/api/logs/archives?${query}`);
    if (res.success) setItems(res.data.items);
    else setMessage(res.error?.message || '归档列表暂时无法读取，请稍后重试。');
  }, [source, from, to, requestId]);
  const loadPolicy = useCallback(async () => {
    const res = await apiRequest<Policy>('/api/logs/archives/policy');
    if (res.success) { setPolicy(res.data); setEnabled(res.data.enabled); setDays(res.data.hotDays); }
    else setMessage(res.error?.message || '归档策略暂时无法读取，请稍后重试。');
  }, []);
  useEffect(() => {
    if (!open) return;
    void loadPolicy();
    void load();
    const timer = setInterval(() => {
      void load();
      void apiRequest<Policy>('/api/logs/archives/policy').then((res) => { if (res.success) setPolicy(res.data); });
    }, 15000);
    return () => clearInterval(timer);
  }, [open, load, loadPolicy]);
  async function act(key: string, operation: () => Promise<void>) {
    setBusy(key); setMessage('');
    try { await operation(); }
    catch { setMessage('操作未完成，日志仍保留；请稍后重试或检查归档配置。'); }
    finally { setBusy(''); }
  }
  async function action(batch: Batch, kind: 'verify' | 'restore') {
    await act(`${batch.id}-${kind}`, async () => {
      const res = await apiRequest<{ restored?: number }>(`/api/logs/archives/${batch.id}/${kind}`, { method: 'POST', timeoutMs: 120000 });
      if (!res.success) { setMessage(res.error?.message || '归档操作未完成，请稍后重试。'); return; }
      setMessage(kind === 'verify' ? '完整性校验和冷库回读通过。' : `已恢复 ${res.data.restored ?? 0} 条未发生变化的日志；恢复正文在热库至少保留 7 天。`);
      await load();
    });
  }
  const input = 'rounded-lg px-3 py-2 text-sm border border-[var(--border-default)] bg-[var(--bg-input)] text-[var(--text-primary)]';
  return <GlassCard className="p-4 shrink-0">
    <button type="button" className="flex w-full items-center gap-2 text-sm font-semibold" onClick={() => setOpen(!open)} aria-expanded={open}>
      <Archive size={16} />归档日志<ChevronDown size={14} className={open ? 'rotate-180' : ''} />
      <span className="ml-auto text-xs font-normal" style={{ color: 'var(--text-secondary)' }}>压缩异机保存，历史内容可查回</span>
    </button>
    {open && <div className="mt-4 space-y-4 max-h-[55vh] overflow-auto">
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>完整日志加密保存至异机冷库，校验并实际回读成功后才迁出热库正文；保留检索索引，冷库不自动删除。查询已有归档无需恢复到热库。</p>
      {canWrite && <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm flex gap-2 items-center"><input type="checkbox" checked={enabled} disabled={!policy?.ready || !!busy} onChange={(e) => setEnabled(e.target.checked)} />启用自动归档与正文迁出</label>
        <label className="text-sm">热库保留 <input aria-label="热库保留天数" type="number" min={7} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${input} w-20`} /> 天</label>
        <Button size="sm" disabled={!!busy || !policy || (enabled && !policy.ready) || days < 7 || days > 365} onClick={() => void act('policy', async () => {
          const res = await apiRequest('/api/logs/archives/policy', { method: 'PUT', body: { enabled, hotDays: days } });
          if (res.success) { setMessage('归档策略已保存。'); await loadPolicy(); }
          else setMessage(res.error?.message || '策略未保存，请检查配置后重试。');
        })}>保存策略</Button>
      </div>}
      {policy && !policy.ready && <p className="text-xs" role="status">自动归档尚未就绪，请管理员配置异机冷库和归档密钥的独立备份。当前原文继续保留。</p>}
      {policy?.error && <p role="alert" className="text-sm">{policy.error}</p>}
      <div className="flex flex-wrap gap-2">
        <select aria-label="日志来源" className={input} value={source} onChange={(e) => setSource(e.target.value)}><option value="">全部来源</option>{Object.entries(names).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <input aria-label="归档开始时间" type="datetime-local" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input aria-label="归档结束时间" type="datetime-local" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        <input aria-label="请求标识" placeholder="请求标识" className={input} value={requestId} onChange={(e) => setRequestId(e.target.value)} />
        <Button size="sm" disabled={!!busy} onClick={() => void act('list', load)}>刷新</Button>
      </div>
      {busy && <div className="flex items-center gap-2 text-sm" role="status"><MapSpinner size={16} />{busy.endsWith('restore') ? '正在校验并恢复，通常需数秒至两分钟' : '正在处理并核对归档，请稍候'}</div>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {!items.length && <p className="py-4 text-sm" style={{ color: 'var(--text-muted)' }}>此范围暂无归档；可调整日期和请求标识后查询。</p>}
      {items.map((batch) => <div key={batch.id} className="rounded-xl border border-[var(--border-subtle)] p-3 space-y-2">
        <div className="flex flex-wrap gap-3 items-center text-sm"><b>{names[batch.source] || batch.source}</b><span>{states[batch.status] || '等待核查'}</span><span>{batch.count} 条</span><span>{bytes(batch.rawBytes)} → {bytes(batch.storedBytes)}</span></div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{time(batch.from)} 至 {time(batch.to)}；已迁出 {batch.migrated} 条正文{batch.verifiedAt && `；最近校验 ${time(batch.verifiedAt)}`}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!!busy || !batch.verifiedAt} onClick={() => setExpanded(expanded === batch.id ? '' : batch.id)}>查看日志</Button>
          <Button size="sm" disabled={!!busy || !batch.verifiedAt} onClick={() => void act(`${batch.id}-download`, async () => {
            const file = await apiDownload(`/api/logs/archives/${batch.id}/download`, `map-logs-${batch.id}.json.gz`);
            const url = URL.createObjectURL(file.blob); const a = document.createElement('a'); a.href = url; a.download = file.fileName; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            setMessage('归档已下载，可解压查看完整日志。');
          })}><Download size={13} />下载</Button>
          {canWrite && <><Button size="sm" disabled={!!busy || !batch.verifiedAt} onClick={() => void action(batch, 'verify')}><ShieldCheck size={13} />校验</Button><Button size="sm" disabled={!!busy || !batch.verifiedAt} onClick={() => void action(batch, 'restore')}><RotateCcw size={13} />恢复到热库</Button></>}
        </div>
        {expanded === batch.id && <div className="space-y-1">{batch.records.map((r) => <Button key={r.id} size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(`${batch.id}-read`, async () => {
          setRecordOpen(true); setRecord('');
          const res = await apiRequest<{ json: string }>(`/api/logs/archives/${batch.id}/records/${encodeURIComponent(r.id)}`, { timeoutMs: 120000 });
          if (res.success) setRecord(res.data.json); else { setRecordOpen(false); setMessage(res.error?.message || '日志暂时无法回读，请检查归档后重试。'); }
        })}>{r.requestId || r.id}</Button>)}</div>}
      </div>)}
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>最多显示最近 100 个匹配批次，请缩小日期范围查找更早记录。关闭自动归档不会删除冷库内容。</p>
    </div>}
    <Dialog open={recordOpen} onOpenChange={setRecordOpen} title="归档日志完整内容" content={record ? <pre className="whitespace-pre-wrap break-all max-h-[65vh] overflow-auto text-xs">{record}</pre> : <div className="flex gap-2 items-center"><MapSpinner size={16} />正在从冷库读取并校验</div>} />
  </GlassCard>;
}
