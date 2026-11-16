import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, ArrowRight, Loader2 } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DtsBodySkeleton, DtsHeading } from '@/components/skeletons/DtsSkeleton';
import { apiRequest } from '@/lib/api';
import { dtsApi, loadDts, type Plan, type Run, type DtsMode } from '@/lib/dts';

const inputClass = 'w-full rounded-md border border-input bg-background p-2 text-sm';
const panelClass = 'rounded-lg border border-input bg-background p-5 space-y-4';
const active = (r: Run) => !['completed', 'failed', 'cancelled', 'paused'].includes(r.status);
const labels: Record<Run['status'], string> = { preparing: '复核差异', submitting: '提交中', running: '传输中', verifying: '核对数据', pausing: '暂停中', paused: '已暂停', cancelling: '取消中', cancelled: '已取消', completed: '已完成', failed: '未通过', uncertain: '待确认' };
export function DtsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') || '';
  const [projects, setProjects] = useState<{ id: string; name: string; aliasName?: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void apiRequest<{ projects: typeof projects }>('/api/projects', { signal: c.signal }).then(r => setProjects(r.projects)).catch(() => { if (!c.signal.aborted) setError('项目列表暂不可用，请刷新重试'); });
    return () => c.abort();
  }, []);
  return <AppShell active="project-list" topbar={<TopBar left={<Crumb items={[{ label: '项目', href: '/project-list' }, { label: '数据同步' }]} />} />}>
    <Workspace fluid><div className="mx-auto max-w-5xl space-y-6 py-6">
      <DtsHeading selector={<label className="min-w-56 text-sm">所属项目<select aria-label="所属项目" className={inputClass} value={projectId} onChange={e => setParams(e.target.value ? { project: e.target.value } : {})}><option value="">选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.aliasName || p.name}</option>)}</select></label>} />
      {error && <p role="alert">{error}</p>}
      {projectId ? <ProjectDts key={projectId} projectId={projectId} /> : <p className={panelClass}>请选择项目，查看已批准的数据连接和同步任务。</p>}
    </div></Workspace>
  </AppShell>;
}
function ProjectDts({ projectId }: { projectId: string }): JSX.Element {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadDts>> | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [pollError, setPollError] = useState('');
  const [source, setSource] = useState(''), [target, setTarget] = useState(''), [mode, setMode] = useState<DtsMode>('append-only');
  const [plan, setPlan] = useState<Plan | null>(null), [revision, setRevision] = useState(0);
  const alive = useRef(true), operation = useRef<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const c = new AbortController();
    void loadDts(projectId, c.signal).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); });
    return () => c.abort();
  }, [projectId, revision]);
  const hasActive = data?.runs.some(active) ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState === 'visible') {
          const r = await dtsApi<{ runs: Run[] }>(projectId, '/runs', 'GET', undefined, c.signal);
          if (!c.signal.aborted) { setData(d => d ? { ...d, runs: r.runs } : d); setPollError(''); }
        }
      } catch { if (!c.signal.aborted) setPollError('暂时无法更新任务状态，下方保留最近确认的结果，请稍后刷新。'); }
      finally { if (!c.signal.aborted) timer = setTimeout(poll, 3000); }
    };
    timer = setTimeout(poll, 3000); return () => { c.abort(); clearTimeout(timer); };
  }, [projectId, hasActive]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await fn(); if (alive.current) setRevision(r => r + 1); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '操作暂未完成，请刷新原任务后重试'); }
    finally { if (alive.current) setBusy(false); }
  }
  const clearPlan = () => { setPlan(null); operation.current = null; };
  const compare = () => perform(async () => { clearPlan(); const r = await dtsApi<{ plan: Plan }>(projectId, '/plans', 'POST', { sourceId: source, targetId: target, mode }); if (alive.current) { setPlan(r.plan); operation.current = crypto.randomUUID(); } });
  const start = () => perform(async () => { if (!plan || !operation.current) return; await dtsApi<{ run: Run }>(projectId, '/runs', 'POST', { planId: plan.id, idempotencyKey: operation.current }); if (alive.current) { setNotice('同步任务已登记，可在下方继续查看进度。'); clearPlan(); } });
  if (!data) return error ? <div className={panelClass}><p role="alert">{error}</p><Button onClick={() => { setError(''); setRevision(r => r + 1); }}>重新加载</Button></div> : <DtsBodySkeleton />;
  const choices = data.connections.filter(c => c.kind === 'mongo');
  return <>
    {error && <p className="rounded-md border border-destructive p-3 text-sm" role="alert">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {!data.capabilities.configured && <p className={panelClass}>尚未连接传输服务。管理员可在下方配置服务，并登记需要同步的环境。</p>}
    <section className={panelClass} aria-label="比较数据"><div className="flex items-center justify-between"><h2 className="font-semibold">选择同步范围</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRevision(v => v + 1)}><RefreshCw />刷新</Button></div>
      <div className="grid items-end gap-4 md:grid-cols-[1fr_auto_1fr]">{(['source', 'target'] as const).map((side, i) => <div key={side} className="contents">{i === 1 && <ArrowRight className="hidden md:block" />}<label className="space-y-2 text-sm">{side === 'source' ? '源环境（正式）' : '目标环境（备用）'}<select className={inputClass} aria-label={side === 'source' ? '源环境' : '目标环境'} disabled={busy} value={side === 'source' ? source : target} onChange={e => { clearPlan(); (side === 'source' ? setSource : setTarget)(e.target.value); }}><option value="">选择已批准的连接</option>{choices.map(c => <option key={c.id} value={c.id} disabled={side === 'target' && !c.allowWrite}>{c.name} · {c.database}/{c.collection}</option>)}</select></label></div>)}</div>
      <label className="block text-sm">同步方式<select className={inputClass} value={mode} disabled={busy} onChange={e => { clearPlan(); setMode(e.target.value as DtsMode); }}><option value="append-only">只追加缺失记录</option><option value="account-authority">账号资料以正式环境为准</option></select></label>
      <p className="text-sm text-muted-foreground">{mode === 'append-only' ? '已有记录和备用环境专属数据会保留。' : '仅校准管理员批准的资料字段；身份授权由集群统一管理。'}</p>
      <Button disabled={busy || !source || !target || source === target || !data.capabilities.configured || !data.capabilities.executeAllowed} onClick={() => void compare()}>{busy && <Loader2 className="animate-spin" />}比较差异</Button>
      {plan && <div className="space-y-3 rounded-md border border-input p-4" aria-label="比较结果"><p>新增 {plan.insertCount} 条 · 校准 {plan.updateCount} 条 · 保留已有 {plan.skipCount} 条</p><p className="text-sm text-muted-foreground">目标可用空间 {(plan.targetFreeBytes / 1024 ** 3).toFixed(1)} GB；本次预留 {(plan.requiredFreeBytes / 1024 ** 2).toFixed(0)} MB。两端版本已通过契约检查。</p><Button disabled={busy || !data.capabilities.executeAllowed} onClick={() => void start()}>按此差异同步</Button></div>}
    </section>
    <section className={panelClass} aria-label="账号同步规则"><h2 className="font-semibold">账号同步规则</h2><p className="text-sm text-muted-foreground">新账号每 5 秒检查并追加；已有账号每天 03:00（上海时间）按正式环境校准已批准字段。</p>
      {data.policies.map(p => <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-input pt-3"><div><p>{data.connections.find(c => c.id === p.sourceId)?.name} → {data.connections.find(c => c.id === p.targetId)?.name} · {p.enabled ? '已启用' : '已停用'}</p>{p.lastError && <p className="text-sm" role="alert">{p.lastError}</p>}</div><Button variant="outline" disabled={busy || !data.capabilities.executeAllowed} onClick={() => void perform(async () => { await dtsApi(projectId, `/policies/${encodeURIComponent(p.id)}`, 'PATCH', { enabled: !p.enabled }); })}>{p.enabled ? '停用' : '启用'}</Button></div>)}
      <Button variant="outline" disabled={busy || !source || !target || source === target || !data.capabilities.configured || !data.capabilities.executeAllowed} onClick={() => void perform(async () => { await dtsApi(projectId, '/policies', 'POST', { sourceId: source, targetId: target }); setNotice('账号同步规则已启用。'); })}>为所选环境启用账号同步</Button>
    </section>
    <section className={panelClass} aria-label="同步任务">{pollError && <p role="alert">{pollError}</p>}<h2 className="font-semibold">同步任务</h2>{!data.runs.length && <p className="text-sm text-muted-foreground">还没有同步任务。</p>}{data.runs.map(r => <article key={r.id} className="space-y-2 border-t border-input pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="flex items-center gap-2">{active(r) && <Loader2 className="h-4 w-4 animate-spin" />}{labels[r.status]}</strong><time className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString('zh-CN')}</time></div><p className="text-sm">{data.connections.find(c => c.id === r.plan.sourceId)?.name || '源环境'} → {data.connections.find(c => c.id === r.plan.targetId)?.name || '目标环境'} · {r.plan.mode === 'append-only' ? '只追加' : '账号资料校准'}</p><p className="text-sm">{r.message}</p><p className="text-xs text-muted-foreground">新增 {r.plan.insertCount} · 校准 {r.plan.updateCount} · 已核对 {r.appliedCount}</p><div className="flex flex-wrap gap-2">{(['pause', 'resume', 'cancel'] as const).filter(a => a === 'resume' ? ['paused', 'failed', 'cancelled'].includes(r.status) : active(r) && !['preparing', 'pausing', 'cancelling'].includes(r.status)).map(a => <Button key={a} variant="outline" size="sm" disabled={busy || !data.capabilities.executeAllowed} onClick={() => void perform(async () => { await dtsApi(projectId, `/runs/${encodeURIComponent(r.id)}/${a}`, 'POST', {}); })}>{a === 'pause' ? '暂停' : a === 'resume' ? '重新比较后续传' : '取消'}</Button>)}</div></article>)}</section>
    {data.capabilities.configureAllowed && <DtsSetup projectId={projectId} services={data.services} onSaved={() => setRevision(r => r + 1)} />}
  </>;
}
function DtsSetup({ projectId, services, onSaved }: { projectId: string; services: Awaited<ReturnType<typeof loadDts>>['services']; onSaved: () => void }): JSX.Element {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [infraId, setInfraId] = useState('');
  const managed = services.find(s => s.id === infraId);
  async function save(e: React.FormEvent<HTMLFormElement>, engine: boolean) {
    e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); setBusy(true); setError('');
    try {
      const body = engine ? { ...values, version: '3.0.0' } : { name: values.name, kind: managed?.kind ?? 'mongo', ...(managed ? { infraId: managed.id } : {}), environmentRole: values.environmentRole, allowWrite: values.allowWrite === 'on', uriEnv: managed?.uriEnv ?? values.uriEnv, database: values.database, collection: values.collection,
        contract: { id: values.contractId, version: Number(values.version), accepts: String(values.accepts).split(',').map(Number), fields: Object.fromEntries(String(values.fields).split('\n').filter(Boolean).map(line => line.trim().split(':').map(x => x.trim()))) }, accountFields: String(values.accountFields || '').split(',').map(f => f.trim()).filter(Boolean) };
      await dtsApi(projectId, engine ? '/engine' : '/connections', engine ? 'PUT' : 'POST', body); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : '连接尚未登记，请稍后重试'); } finally { setBusy(false); }
  }
  const field = (name: string, label: string, defaultValue?: string, placeholder?: string) => <label key={name} className="block space-y-1 text-sm">{label}<input required={name !== 'accountFields'} className={inputClass} name={name} defaultValue={defaultValue} placeholder={placeholder} /></label>;
  return <details className={panelClass}><summary className="cursor-pointer text-sm font-medium">管理员连接设置</summary><p className="text-sm text-muted-foreground">仅系统所有者可配置。连接引用当前项目已有私密配置，密码不会进入此页面。</p>{error && <p role="alert">{error}</p>}
    <form onSubmit={e => void save(e, true)} className="space-y-3"><h3 className="font-medium">连接 SeaTunnel 3.0.0</h3>{field('baseUrl', '传输服务地址', undefined, 'https://…')}{field('usernameEnv', '服务用户名配置名', 'DTS_ENGINE_USER')}{field('passwordEnv', '服务密码配置名', 'DTS_ENGINE_PASSWORD')}<Button disabled={busy} variant="outline">验证并连接</Button></form>
    <form onSubmit={e => void save(e, false)} className="space-y-3 border-t border-input pt-4"><h3 className="font-medium">登记 MongoDB 环境</h3><label className="block text-sm">已有项目数据服务<select aria-label="已有项目数据服务" className={inputClass} value={infraId} onChange={e => setInfraId(e.target.value)}><option value="">使用其他已有私密连接配置</option>{services.filter(s => s.kind === 'mongo').map(s => <option key={s.id} value={s.id} disabled={!s.ready}>{s.name} · {s.ready ? '可连接' : '尚未就绪'}</option>)}</select></label><label className="block text-sm">环境角色<select name="environmentRole" className={inputClass} defaultValue="other"><option value="other">其他环境</option><option value="production">正式环境（账号权威源）</option><option value="standby">备用环境</option><option value="acceptance">验收环境</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowWrite" />允许作为同步写入目标</label><div className="grid gap-3 md:grid-cols-2">{field('name', '环境名称')}{managed ? <p className="text-sm">连接配置：{managed.uriEnv}（来自项目数据服务）</p> : field('uriEnv', '数据库连接配置名', undefined, 'DTS_SOURCE_URI')}{field('database', '数据库')}{field('collection', '集合')}{field('contractId', '数据契约名称')}{field('version', '本环境契约版本', '1')}{field('accepts', '可接收源版本（逗号分隔）', '1')}{field('accountFields', '每日校准资料字段（逗号分隔）')}</div><label className="block text-sm">批准字段（每行 字段:类型）<textarea name="fields" required className={inputClass} defaultValue={'_id:string\nname:string'} rows={4} /></label><Button disabled={busy} variant="outline">验证并登记环境</Button></form>
  </details>;
}
