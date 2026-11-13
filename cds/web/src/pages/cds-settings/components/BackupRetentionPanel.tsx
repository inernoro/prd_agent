import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest } from '@/lib/api';

interface Result {
  scanStatus: 'complete' | 'partial'; canExecute?: boolean; maxAgeDays: number; dryRun?: boolean;
  counts: Record<string, number>;
  directories: Array<{ directory: string; error?: string; candidates?: Item[]; removed?: string[]; held?: Item[]; unknown?: Item[]; policyConflicts?: Item[]; filesystems?: Array<{ path: string; netAvailableBytesDelta: number | null }> }>;
}
interface Item { path: string; reason?: string; allocatedBytes?: number }
interface Execution { id: string; status: 'running' | 'completed' | 'failed'; startedAt: string; directory?: string; report?: Result; error?: string; stopRequested?: boolean }
const reasons: Record<string, string> = {
  'active-backup-or-restore-lease': '备份或恢复租约有效',
  'policy-conflict-no-fresh-recovery-point': '超过15天且缺少新有效恢复点，需先补备份',
  'policy-conflict-no-verified-replacement': '新恢复点完整性未确认，保留原副本',
  'backup-ownership-not-registered': '归属未登记，保留并等待确认',
  'foreign-instance-owner': '属于其他实例，保留',
  'file-still-open': '文件仍被进程打开，保留',
  'file-identity-changed': '对象已被替换，保留新对象',
  'within-retention-window-or-required-recovery-point': '在保留窗口内或为必要恢复点',
  'incomplete-outputs-need-writer-identity-and-retirement': '未完成产物不算有效恢复点，等待生产者归属核查',
  'retention-catalog-not-initialized': '尚未建立退役台账，占用未确认',
  'backup-replacement-proof-unconfirmed': '来源或完整导出证明未确认，不能替代旧恢复点',
  'unfinished-business-backup-needs-verified-replacement': '未完成文件含业务数据，需同来源的新完整备份后再回收',
  'running-or-stopped-container-mount': '运行或停止容器仍挂载该文件或父目录，保留',
  'container-or-stopped-container-references-unconfirmed': '容器挂载查询未确认，相关备份保持保护',
};
export function BackupRetentionPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [canExecute, setCanExecute] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ execution: Execution | null; canExecute: boolean }>('/api/janitor/backups/state', { signal: controller.signal }).then(body => {
      setExecution(body.execution); setCanExecute(body.canExecute);
      if (body.execution?.report) setResult(body.execution.report);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '上轮回收进度未确认。'); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (execution?.status !== 'running') return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - Date.parse(execution.startedAt)) / 1000));
      void apiRequest<{ execution: Execution | null }>('/api/janitor/backups/state', { signal: controller.signal }).then(body => {
        if (body.execution) { setExecution(body.execution); if (body.execution.report) setResult(body.execution.report); }
      }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '任务进度未确认。'); });
    }, 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [execution?.id, execution?.status, execution?.startedAt]);
  async function preview() {
    setLoading(true); setError('');
    try { const data = await apiRequest<Result>('/api/janitor/backups'); setResult(data); setCanExecute(data.canExecute === true); }
    catch (err) { setError(err instanceof Error ? err.message : '备份占用未确认。'); }
    finally { setLoading(false); }
  }
  async function execute() {
    setError('');
    try { const data = await apiRequest<{ execution: Execution }>('/api/janitor/backups/reconcile', { method: 'POST', body: { maxRemovals: 8 } }); setExecution(data.execution); setSeconds(0); }
    catch (err) { setError(err instanceof Error ? err.message : '回收尚未开始。'); }
  }
  async function cancel() {
    if (!execution) return;
    try { await apiRequest('/api/janitor/backups/cancel', { method: 'POST', body: { id: execution.id } }); setExecution({ ...execution, stopRequested: true }); }
    catch (err) { setError(err instanceof Error ? err.message : '停止尚未确认。'); }
  }
  const busy = execution?.status === 'running';
  return <div className="space-y-3 text-sm">
    <h3 className="font-medium">备份保留与退役</h3>
    <p>备份最多保留15天。活跃资源缺少新有效恢复点时显示策略冲突；在写文件、恢复租约和未知归属保持保护。</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={loading || busy} onClick={() => void preview()}>预览全局备份回收</Button>
      {canExecute && result ? <Button variant="outline" disabled={busy || loading || !result.counts.candidates} onClick={() => void execute()}>重新核查并执行一批</Button> : null}
      {busy ? <Button variant="outline" disabled={execution?.stopRequested} onClick={() => void cancel()}>{execution?.stopRequested ? '正在安全停止' : '停止后续回收'}</Button> : null}
    </div>
    {loading ? <ContentLoading label="正在核对备份身份、完整性与保留原因" variant="table" /> : null}
    {busy ? <p role="status">正在核查：{execution?.directory || '准备目录'}，已执行 {seconds} 秒。刷新页面可重新读取当前任务。</p> : null}
    {error || execution?.error ? <p role="alert" className="text-destructive">{error || execution?.error} 未确认的对象保持保留，不能据此判断零占用。</p> : null}
    {result ? <>
      <p>{result.dryRun === false ? '本轮计划' : '候选'} {result.counts.candidates ?? '未确认'}，已回收 {result.counts.removed ?? '未确认'}，保留 {result.counts.held ?? '未确认'}，失败 {result.counts.failed ?? '未确认'}，待处理 {result.counts.pending ?? '未确认'}，策略冲突 {result.counts.policyConflicts ?? '未确认'}。</p>
      {result.scanStatus === 'partial' ? <p role="status">盘点尚未完整确认；未知、冲突和待处理项继续保留。</p> : null}
      <p className="text-xs text-muted-foreground">候选分配块仅为估计，不能相加承诺释放量。实际收益读取每轮文件系统可用空间净变化，包含同期写入。</p>
      <div className="max-h-96 overflow-auto rounded-md border border-border"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">对象</th><th className="p-2">结果与保护原因</th></tr></thead><tbody>
        {result.directories.flatMap(directory => [
          ...(directory.error ? [<tr key={directory.directory} className="border-t"><td className="break-all p-2">{directory.directory}</td><td className="p-2">查询失败：{directory.error}</td></tr>] : []),
          ...(directory.candidates || []).map(item => <tr key={`candidate:${item.path}`} className="border-t"><td className="break-all p-2 font-mono">{item.path}</td><td className="p-2">{directory.removed?.includes(item.path) ? '已回收' : '候选'}，分配块估计 {item.allocatedBytes?.toLocaleString() ?? '未知'} 字节</td></tr>),
          ...[...(directory.held || []), ...(directory.unknown || [])].map((item, index) => <tr key={`held:${item.path}:${index}`} className="border-t"><td className="break-all p-2 font-mono">{item.path}</td><td className="p-2">保留：{reasons[item.reason || ''] || item.reason || '尚未确认'}{canExecute && item.reason === 'backup-ownership-not-registered' ? <Button className="ml-2" size="sm" variant="outline" disabled={busy} onClick={() => setAdopting(item.path)}>登记归属</Button> : null}</td></tr>),
          ...(directory.filesystems || []).map(fs => <tr key={`fs:${directory.directory}:${fs.path}`} className="border-t"><td className="break-all p-2">文件系统观测：{fs.path}</td><td className="p-2">实际净变化 {fs.netAvailableBytesDelta?.toLocaleString() ?? '未知'} 字节</td></tr>),
        ])}
      </tbody></table></div>
    </> : null}
    {adopting ? <BackupOwnershipForm file={adopting} onCancel={() => setAdopting(null)} onRegistered={() => { setAdopting(null); void preview(); }} /> : null}
  </div>;
}

function BackupOwnershipForm({ file, onCancel, onRegistered }: { file: string; onCancel: () => void; onRegistered: () => void }) {
  const [owners, setOwners] = useState<{ projects: Array<{ id: string; name: string }>; services: Array<{ id: string; projectId: string }> }>({ projects: [], services: [] });
  const [project, setProject] = useState('');
  const [resource, setResource] = useState('');
  const [historicalResource, setHistoricalResource] = useState('');
  const [historicalProject, setHistoricalProject] = useState('');
  const [disposable, setDisposable] = useState(false);
  const [dispositionReason, setDispositionReason] = useState('');
  const [bindLineage, setBindLineage] = useState(false);
  const [lineageAttestation, setLineageAttestation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<typeof owners>('/api/janitor/backups/owners', { signal: controller.signal }).then(setOwners).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '归属列表未确认。'); });
    return () => controller.abort();
  }, []);
  const projectId = project === '__historical__' ? historicalProject.trim() : project;
  const serviceId = resource === '__historical__' ? historicalResource.trim() : resource;
  async function register() {
    setSaving(true);setError('');
    try { await apiRequest('/api/janitor/backups/adopt', { method: 'POST', body: { path: file, projectId, serviceId, origin: 'historical', disposition: disposable ? 'reproducible-artifact' : 'business-backup', dispositionReason,
      ...(!disposable && bindLineage ? { lineageAttestation } : {}) } });onRegistered(); }
    catch (err) { setError(err instanceof Error ? err.message : '归属或完整性未确认。'); }
    finally { setSaving(false); }
  }
  const field = 'min-h-11 rounded-md border border-input bg-background px-3 py-2';
  return <div className="space-y-3 rounded-md border border-border p-4">
    <h4 className="font-medium">登记历史备份归属</h4>
    <p className="break-all font-mono text-xs">{file}</p>
    <p>请依据交接记录确认项目与资源。登记会验证文件身份和完整性；完成后仍需重新预览并执行回收。</p>
    <p className="text-sm">业务备份不会因资源退役或台账缺失而删除唯一恢复点；手工登记也不能替代成功导出证明。</p>
    <label className="flex gap-2"><input type="checkbox" checked={disposable} onChange={event => setDisposable(event.target.checked)} />我已确认这是可再生成的测试备份，不含业务数据，允许15天后删除最后一份。</label>
    {disposable ? <label className="grid gap-1">测试数据归属与可再生成依据<input className="min-h-11 rounded-md border border-input bg-background px-3 py-2" value={dispositionReason} onChange={event=>setDispositionReason(event.target.value)} required maxLength={2000} /></label> : null}
    {!disposable ? <>
      <label className="flex gap-2"><input type="checkbox" checked={bindLineage} onChange={event=>setBindLineage(event.target.checked)} />我已依据原备份记录确认它来自所选当前资源的同一物理数据，可由该来源的新完整导出替代。</label>
      {bindLineage ? <label className="grid gap-1">原始来源核对依据<input className={field} value={lineageAttestation} onChange={event=>setLineageAttestation(event.target.value)} required maxLength={2000} /></label> : null}
      <p className="text-xs text-muted-foreground">仅选择相同名称不会关联物理来源。未确认时保留并显示策略冲突；来源核对失败也保持保护。</p>
    </> : null}
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1">所属项目<select className={field} value={project} onChange={event => { setProject(event.target.value);setResource(''); }}><option value="">请选择项目</option>{owners.projects.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}<option value="__historical__">已退役项目</option></select></label>
      {project === '__historical__' ? <label className="grid gap-1">交接记录中的项目标识<input className={field} value={historicalProject} onChange={event => setHistoricalProject(event.target.value)} /></label> : null}
      <label className="grid gap-1">所属资源<select className={field} value={resource} onChange={event => setResource(event.target.value)}><option value="">请选择资源</option>{owners.services.filter(item => item.projectId === project).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}<option value="__historical__">已退役或更名前的资源</option></select></label>
      {resource === '__historical__' ? <label className="grid gap-1">交接记录中的资源标识<input className={field} value={historicalResource} onChange={event => setHistoricalResource(event.target.value)} /></label> : null}
    </div>
    {saving ? <ContentLoading label="正在核验文件并登记归属" variant="table" /> : null}
    {error ? <p role="alert" className="text-destructive">{error} 文件继续保留。</p> : null}
    <div className="flex gap-2"><Button variant="outline" disabled={saving || !projectId || !serviceId || (!disposable && bindLineage && !lineageAttestation.trim())} onClick={() => void register()}>核验并登记</Button><Button variant="outline" disabled={saving} onClick={onCancel}>取消登记</Button></div>
  </div>;
}
