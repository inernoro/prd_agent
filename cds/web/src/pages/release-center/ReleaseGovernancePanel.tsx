import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock, GitPullRequest, Plus, RefreshCw, ShieldCheck, Square, X } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';
import { useNowTick } from '@/hooks/useNowTick';
import { releaseActorLabel } from '@/lib/releaseProvenance';
import { Chip, formatDateTime } from './shared';
import type { BranchOption, CenterRow } from './types';
import type { ReleaseAuthorization, ReleaseConflictCheck, ReleaseGovernanceAttempt, ReleaseMergeBack } from '../../../../src/domain/release-governance';

interface GovernanceView { authorizations: ReleaseAuthorization[]; attempts: ReleaseGovernanceAttempt[]; mergeBacks: ReleaseMergeBack[]; checks?: Array<ReleaseConflictCheck & { targetId: string }>; scheduledJobs?: Array<{ id: string; name: string; targetIds: string[] }> }
export function readGovernanceView(value: unknown): GovernanceView {
  const data = value as GovernanceView | null;
  if (!data || !Array.isArray(data.authorizations) || !Array.isArray(data.attempts) || !Array.isArray(data.mergeBacks)
    || data.checks !== undefined && !Array.isArray(data.checks)
    || data.scheduledJobs !== undefined && !Array.isArray(data.scheduledJobs)) throw new Error('发布治理响应不完整');
  return data;
}
const inputClass = 'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm';
const states = { pending: '等待独立批准', approved: '已批准', rejected: '已拒绝', revoked: '已撤销' };
const prStates = { open: '待合并', closed: '已关闭未合并', merged: 'PR 已合并', unknown: '尚未核实' };
export function releaseGovernanceFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作未完成，请刷新后重试';
  if (error.status === 401) return '登录已失效，请重新登录后继续';
  if (error.status === 403) return '没有执行此操作的权限，请使用有权访问该项目的账号';
  if (error.status === 400) return '申请信息不完整，请核对分支、范围和有效期后重新提交';
  const body = error.body as { code?: unknown; message?: unknown } | null;
  if (body?.code === 'release_governance_rejected' && typeof body.message === 'string') {
    return `${body.message}。请核对申请条件后重试`;
  }
  return '发布服务暂时不可用，尚未放行，请刷新后重试';
}
const failure = releaseGovernanceFailure;

export function ReleaseGovernancePanel({ projectId, row, refreshVersion, onChanged }: {
  projectId: string; row?: CenterRow; refreshVersion: number; onChanged: () => void;
}): JSX.Element | null {
  const [data, setData] = useState<GovernanceView>({ authorizations: [], attempts: [], mergeBacks: [] });
  const [loaded, setLoaded] = useState(false);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'approval' | 'debug'>('approval');
  const [dialog, setDialog] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [kind, setKind] = useState<'single' | 'debug'>('single');
  const [action, setAction] = useState<'release' | 'rollback'>('release');
  const [rollbackId, setRollbackId] = useState('');
  const [scheduledJobId, setScheduledJobId] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [paths, setPaths] = useState('');
  const [reason, setReason] = useState('');
  const [decisionReason, setDecisionReason] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [prOwner, setPrOwner] = useState('');
  const [check, setCheck] = useState<ReleaseConflictCheck>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scope = useRef(0);
  const loadSequence = useRef(0);
  const observedRefresh = useRef(refreshVersion);
  const now = useNowTick(true);
  const statusLabel = (record: ReleaseAuthorization) => record.status === 'approved' && record.consumedBy ? '本次批准已使用' : ['approved', 'pending'].includes(record.status) && Date.parse(record.expiresAt) <= now ? '已到期' : states[record.status];
  const targetId = row?.target.id || '';
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = scope.current, sequence = ++loadSequence.current;
    const response = await Promise.all([
      apiRequest<GovernanceView>(`/api/releases/governance?projectId=${encodeURIComponent(projectId)}`, { signal }),
      apiRequest<{ branches: BranchOption[] }>(`/api/branches?project=${encodeURIComponent(projectId)}`, { signal }),
    ]).catch(error => { if (!signal?.aborted && generation === scope.current && sequence === loadSequence.current) throw error; return undefined; });
    if (!response || signal?.aborted || generation !== scope.current || sequence !== loadSequence.current) return;
    const [result, source] = response;
    setData(readGovernanceView(result)); setLoaded(true); setBranches(source.branches || []);
  }, [projectId]);
  useEffect(() => {
    scope.current++; const controller = new AbortController();
    setBusy(''); setDialog(false); setLoaded(false);
    setData({ authorizations: [], attempts: [], mergeBacks: [] }); setCheck(undefined); setSelected(''); setError(''); setNotice('');
    void load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(failure(error)); });
    return () => { scope.current++; controller.abort(); };
  }, [load, targetId]);
  useEffect(() => {
    if (observedRefresh.current === refreshVersion) return;
    observedRefresh.current = refreshVersion;
    const controller = new AbortController();
    void load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(failure(error)); });
    return () => controller.abort();
  }, [load, refreshVersion]);
  const perform = async (label: string, work: () => Promise<unknown>, message: string) => {
    const generation = scope.current;
    setBusy(label); setError(''); setNotice('');
    try {
      await work();
      if (scope.current !== generation) return;
      await load(); if (scope.current !== generation) return;
      setNotice(message); onChanged(); return true;
    } catch (error) { if (scope.current === generation) setError(failure(error)); }
    finally { if (scope.current === generation) setBusy(''); }
  };
  if (!row) return null;
  const records = data.authorizations.filter(a => a.targetId === targetId && (tab === 'debug' ? a.kind === 'debug' : a.kind === 'single'));
  const current = records.find(a => a.id === selected) || records[0];
  const approval = current?.decisions?.find(decision => decision.action === 'approved');
  const attempts = data.attempts.filter(a => a.targetId === targetId && (!current || !a.authorizationId || a.authorizationId === current.id));
  const mergeBack = data.mergeBacks.find(a => a.targetId === targetId && a.sourceSha === row.currentCommit);
  const observedCheck = check || data.checks?.find(c => c.targetId === targetId && c.candidateSha === row.currentCommit);
  const base = `/api/releases/targets/${encodeURIComponent(targetId)}`;
  const decide = (decision: 'approve' | 'reject' | 'revoke') => current && perform('保存审批决定',
    () => apiRequest(`/api/releases/authorizations/${current.id}/${decision}`, { method: 'POST', body: { reason: decisionReason } }), '审批决定已保存');
  const request = async () => {
    const saved = await perform('更新主干并核验申请', () => apiRequest(`${base}/authorizations`, { method: 'POST', body: {
      branchId, kind, action, rollbackReleaseId: action === 'rollback' ? rollbackId : undefined, scheduledJobId: scheduledJobId || undefined,
      expiresAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
      allowedPaths: paths.split('\n').map(p => p.trim()).filter(Boolean), reason,
    } }), '申请已保存，等待另一位项目成员批准');
    if (saved) { setDialog(false); setReason(''); }
  };
  return <section aria-label="发布审批与连续调试" className="min-w-0 border-b border-[hsl(var(--hairline))] py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">批准与调试窗口</h2><p className="mt-1 text-xs text-muted-foreground">{row.target.name} · 每次执行都核对版本、生产基线和批准范围。</p></div>
      <div className="flex flex-wrap gap-2">
        {!row.target.governance?.required ? <Button variant="outline" disabled={!!busy} onClick={() => void perform('启用发布审批', () => apiRequest(`${base}/governance/enable`, { method: 'POST' }), '本环境已启用独立审批，所有发布入口均受约束')}><ShieldCheck />启用本环境审批</Button> : <Chip tone="ok">执行审批已启用</Chip>}
        <Button variant="outline" disabled={!!busy} onClick={() => void perform('刷新审批记录', () => Promise.resolve(), '已刷新审批记录')}><RefreshCw />刷新记录</Button>
        <Button disabled={!!busy || !loaded || !row.target.governance?.required} onClick={() => { setKind(tab === 'debug' ? 'debug' : 'single'); setAction('release'); setScheduledJobId(''); setBranchId(branches.find(b => b.status === 'running')?.id || branches[0]?.id || ''); setDialog(true); }}><Plus />新建申请</Button>
      </div>
    </div>
    {!row.target.governance?.required ? <p className="mt-2 text-xs text-muted-foreground">先启用本环境审批，再申请独立批准。</p> : null}
    {busy ? <p role="status" className="mt-3 flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4 animate-spin" />{busy}，请稍候…</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-bad">{error}</p> : null}
    {notice ? <p role="status" className="mt-3 text-sm text-ok">{notice}</p> : null}
    <div className="mt-4 flex gap-1" aria-label="授权类别"><Button variant={tab === 'approval' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('approval')}>单次审批</Button><Button variant={tab === 'debug' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('debug')}>连续调试</Button></div>
    {!loaded && !error ? <ContentLoading label="读取审批与调试窗口" variant="panel" /> : <div className="mt-3 grid min-w-0 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="max-h-80 space-y-1 overflow-auto lg:border-r lg:border-[hsl(var(--hairline))] lg:pr-4">
        {records.length ? records.map(record => <button key={record.id} className={`w-full rounded-md p-3 text-left ${current?.id === record.id ? 'bg-muted' : 'hover:bg-muted/50'}`} onClick={() => { setSelected(record.id); setDecisionReason(''); }}>
          <span className="block truncate text-sm font-medium">{record.branchName}</span><span className="mt-1 block text-xs text-muted-foreground">{statusLabel(record)} · {formatDateTime(record.expiresAt)}</span>
        </button>) : <p className="py-5 text-sm text-muted-foreground">{error ? '审批记录未读取，请刷新重试。' : tab === 'debug' ? '尚无调试窗口。限定文件或目录、执行分支和有效期后申请批准。' : '尚无审批申请。请选择已部署分支，申请固定版本的批准。'}</p>}
      </div>
      <div className="min-w-0">
        {current ? <>
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{current.kind === 'debug' ? '连续调试窗口' : current.action === 'rollback' ? '单次回滚批准' : '单次版本批准'}</h3><Chip tone={current.status === 'approved' && Date.parse(current.expiresAt) > now && !current.consumedBy ? 'ok' : 'muted'}>{statusLabel(current)}</Chip></div>
          <p className="mt-2 text-sm">{current.reason}</p>
          <dl className="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">申请人 / 执行凭据</dt><dd className="break-all">{releaseActorLabel(current.requestedBy)}</dd></div>
            {current.scheduledJobId ? <div><dt className="text-xs text-muted-foreground">执行任务</dt><dd className="break-all">{data.scheduledJobs?.find(job => job.id === current.scheduledJobId)?.name || current.scheduledJobId}</dd></div> : null}
            <div><dt className="text-xs text-muted-foreground">审批人</dt><dd>{approval ? releaseActorLabel(approval.by) : current.status === 'approved' && current.decidedBy ? releaseActorLabel(current.decidedBy) : '等待独立批准'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">候选版本</dt><dd className="break-all font-mono text-xs">{current.candidateSha}</dd></div>
            <div><dt className="text-xs text-muted-foreground">主干依据</dt><dd className="break-all font-mono text-xs">{current.mainSha}</dd></div>
            <div><dt className="text-xs text-muted-foreground">有效期</dt><dd><Clock className="mr-1 inline h-4 w-4" />截至 {formatDateTime(current.expiresAt)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">范围</dt><dd className="break-all">{current.kind === 'debug' ? current.allowedPaths.join('、') : '仅此固定版本，使用一次'}</dd></div>
          </dl>
          {current.decisionReason ? <p className="mt-3 text-sm text-muted-foreground">审批意见：{current.decisionReason}</p> : null}
          {current.decisions?.length ? <ol aria-label="审批历史" className="mt-3 space-y-1 text-xs text-muted-foreground">{current.decisions.map((decision, index) => <li key={index}>{formatDateTime(decision.at)} · {releaseActorLabel(decision.by)} · {states[decision.action]}：{decision.reason}</li>)}</ol> : null}
          {current.status === 'pending' || current.status === 'approved' ? <div className="mt-4 space-y-2">
            <label className="block text-xs text-muted-foreground">审批 / 撤销意见<input aria-label="审批意见" className={`${inputClass} mt-1`} value={decisionReason} onChange={e => setDecisionReason(e.target.value)} placeholder="说明批准依据或拒绝原因" /></label>
            <div className="flex flex-wrap gap-2">{current.status === 'pending' ? <><Button disabled={!!busy || decisionReason.trim().length < 4} onClick={() => void decide('approve')}><Check />独立批准</Button><Button variant="outline" disabled={!!busy || decisionReason.trim().length < 4} onClick={() => void decide('reject')}><X />拒绝</Button></> : null}<Button variant="outline" disabled={!!busy || decisionReason.trim().length < 4} onClick={() => void decide('revoke')}><Square />撤销授权</Button></div>
          </div> : null}
          {attempts.length ? <div className="mt-5"><h4 className="text-sm font-medium">逐次执行记录</h4><ol className="mt-2 max-h-52 space-y-2 overflow-auto">{attempts.map(attempt => <li key={attempt.id} className="border-l-2 border-[hsl(var(--hairline))] pl-3 text-xs"><span className={attempt.result === 'accepted' ? 'text-ok' : 'text-bad'}>{attempt.result === 'accepted' ? '已受理' : '已拦截'}</span> · {formatDateTime(attempt.at)} · {attempt.candidateSha.slice(0,12)}<p className="mt-1 text-muted-foreground">{attempt.reason}</p></li>)}</ol></div> : null}
        </> : null}
      </div>
    </div>}
    <div className="mt-5 grid min-w-0 gap-5 border-t border-[hsl(var(--hairline))] pt-4 lg:grid-cols-2">
      <div><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">真实合并冲突</h3><Button size="sm" variant="outline" disabled={!!busy || !row.currentCommit} onClick={() => void perform('更新主干并隔离核验', async () => { const generation = scope.current; const result = await apiRequest<{ check: ReleaseConflictCheck }>(`${base}/conflict-check`, { method: 'POST' }); if (scope.current === generation) setCheck(result.check); }, '冲突检查已完成')}><RefreshCw />核验线上与主干</Button></div>
        <p className="mt-2 text-sm text-muted-foreground">{observedCheck ? observedCheck.status === 'clean' ? '隔离合并通过，未发现文本冲突。' : observedCheck.status === 'conflicts' ? `真实冲突：${observedCheck.conflicts.join('、')}` : observedCheck.reason : '按固定提交执行隔离 Git 合并；文件重叠不等于文本冲突。'}</p>
        {observedCheck ? <p className="mt-1 break-all text-xs text-muted-foreground">main {observedCheck.mainSha.slice(0,12) || '未知'} · 版本 {observedCheck.candidateSha.slice(0,12)} · {formatDateTime(observedCheck.checkedAt)}</p> : null}
      </div>
      <div><h3 className="flex items-center gap-2 text-sm font-medium"><GitPullRequest className="h-4 w-4" />PR 回并</h3>
        {mergeBack ? <div className="mt-2 text-sm"><a href={mergeBack.url} target="_blank" rel="noreferrer" className="text-primary underline">PR #{mergeBack.number}</a> · {prStates[mergeBack.state]} · 负责人 {mergeBack.owner}<p className="mt-1 text-xs text-muted-foreground">核验于 {formatDateTime(mergeBack.checkedAt)}；Git 历史包含关系另见上方。</p><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void perform('核对 GitHub PR', () => apiRequest(`/api/releases/merge-backs/${encodeURIComponent(mergeBack.id)}/refresh`, { method: 'POST' }), 'GitHub PR 状态已更新')}>刷新 PR 状态</Button></div> : <p className="mt-2 text-xs text-muted-foreground">关联包含当前线上版本、面向项目主干的真实 PR。</p>}
        <div className="mt-2 flex flex-wrap gap-2"><input aria-label="回并 PR 编号" className={`${inputClass} min-w-0 flex-1`} placeholder="PR 编号" inputMode="numeric" value={prNumber} onChange={e => setPrNumber(e.target.value)} /><input aria-label="回并负责人" className={`${inputClass} min-w-0 flex-1`} placeholder="回并负责人" value={prOwner} onChange={e => setPrOwner(e.target.value)} /><Button size="sm" variant="outline" disabled={!!busy || !row.currentCommit || !/^\d+$/.test(prNumber) || !prOwner.trim()} onClick={() => void perform('核对并关联 GitHub PR', () => apiRequest(`${base}/merge-back`, { method: 'POST', body: { number: Number(prNumber), owner: prOwner, sourceSha: row.currentCommit } }), '回并 PR 与负责人已关联')}>关联 PR</Button></div>
      </div>
    </div>
    <Dialog open={dialog} onOpenChange={value => { if (!busy) setDialog(value); }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>申请发布批准</DialogTitle><DialogDescription>批准绑定当前生产基线和主干版本；配置、基线、范围或有效期变化后会重新拦截。</DialogDescription></DialogHeader>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="text-sm">类型<select aria-label="批准类型" className={`${inputClass} mt-1`} value={kind} onChange={e => { setKind(e.target.value as 'single' | 'debug'); setAction('release'); }}><option value="single">单次版本批准</option><option value="debug">限定范围的连续调试</option></select></label>
        <label className="text-sm">操作<select aria-label="批准操作" className={`${inputClass} mt-1`} value={action} onChange={e => setAction(e.target.value as 'release' | 'rollback')}><option value="release">发布</option>{kind === 'single' ? <option value="rollback">恢复历史成功版本</option> : null}</select></label>
        <label className="min-w-0 text-sm">执行分支<select aria-label="申请分支" className={`${inputClass} mt-1`} value={branchId} onChange={e => setBranchId(e.target.value)}><option value="">选择分支</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.branch} · {(branch.commitSha || branch.githubCommitSha || '').slice(0,12)}</option>)}</select></label>
        <label className="text-sm">有效期<select aria-label="授权有效期" className={`${inputClass} mt-1`} value={minutes} onChange={e => setMinutes(e.target.value)}><option value="15">15 分钟</option><option value="60">1 小时</option><option value="240">4 小时</option><option value="1440">24 小时</option></select></label>
        {data.scheduledJobs?.some(job => job.targetIds.includes(targetId)) ? <label className="min-w-0 text-sm sm:col-span-2">执行方式<select aria-label="批准执行任务" className={`${inputClass} mt-1`} value={scheduledJobId} onChange={e => setScheduledJobId(e.target.value)}><option value="">由本次申请账号或执行凭据发布</option>{data.scheduledJobs.filter(job => job.targetIds.includes(targetId)).map(job => <option key={job.id} value={job.id}>定时任务：{job.name}</option>)}</select><span className="mt-1 block text-xs text-muted-foreground">任务批准只供该任务使用；任务配置变化后需要重新申请。</span></label> : null}
        {action === 'rollback' ? <label className="text-sm sm:col-span-2">恢复版本<select aria-label="批准恢复版本" className={`${inputClass} mt-1`} value={rollbackId} onChange={e => setRollbackId(e.target.value)}><option value="">选择历史成功版本</option>{row.successfulRuns?.map(run => <option key={run.releaseId} value={run.releaseId}>{run.commitSha.slice(0,12)} · {formatDateTime(run.finishedAt)}</option>)}</select></label> : null}
        {kind === 'debug' ? <label className="text-sm sm:col-span-2">允许改动的文件 / 目录<textarea aria-label="允许改动范围" className={`${inputClass} mt-1 min-h-24 font-mono`} value={paths} onChange={e => setPaths(e.target.value)} placeholder={'cds/web/src/pages/release-center/\ncds/web/src/lib/releaseProvenance.ts'} /><span className="mt-1 block text-xs text-muted-foreground">每行一个仓库内路径，目录以 / 结尾。每次检查从授权基线开始的全部累计改动。</span></label> : null}
        <label className="text-sm sm:col-span-2">发布目的<textarea aria-label="发布目的" className={`${inputClass} mt-1 min-h-20`} value={reason} onChange={e => setReason(e.target.value)} placeholder="说明此次发布或连续打磨的目的" /></label>
      </div>
      {busy ? <p role="status" className="flex items-center gap-2 text-sm"><RefreshCw className="h-4 w-4 animate-spin" />{busy}，通常需要数秒…</p> : null}{error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}{notice ? <p role="status" className="text-sm text-ok">{notice}</p> : null}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={!!busy} onClick={() => setDialog(false)}>关闭</Button><Button disabled={!!busy || !branchId || reason.trim().length < 8 || kind === 'debug' && !paths.trim() || action === 'rollback' && !rollbackId} onClick={() => void request()}>提交独立审批</Button></div>
    </DialogContent></Dialog>
  </section>;
}
