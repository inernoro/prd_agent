import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Check, ClipboardList, Copy, RotateCw } from 'lucide-react';
import { AppShell, Crumb, TopBar, Workspace, useCanManageConsole } from '@/components/layout/AppShell';
import { APPROVAL_DIALOG_BODY_CLASS, APPROVAL_DIALOG_FOOTER_CLASS, APPROVAL_DIALOG_HEADER_CLASS, APPROVAL_DIALOG_WIDTH, APPROVAL_FILTERS_CLASS, APPROVAL_INBOX_CLASS, APPROVAL_ROW_CLASS, APPROVAL_ROWS_CLASS, ReleaseApprovalDetailSkeleton, ReleaseApprovalSkeleton } from '@/components/skeletons/ReleaseApprovalSkeleton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';
import { releaseApprovalInboxPath, releaseApprovalLabels, releaseApprovalPath, releaseApprovalReadFailure, releaseApprovalState, releaseApprovalTitle, releaseApprovalWorkbenchPath, type ReleaseApprovalRead } from '@/lib/releaseApproval';
import { releaseActorLabel } from '@/lib/releaseProvenance';
import { useNowTick } from '@/hooks/useNowTick';
import { Chip, formatDateTime } from './shared';
import { releaseGovernanceFailure } from './ReleaseGovernancePanel';
import type { ReleaseApprovalDetail, ReleaseApprovalInbox } from '../../../../src/domain/release-governance';

const field = 'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm';
type Command = 'approve' | 'reject' | 'reapply';

type InboxScope = { projectId: string; targetId: string };
type Filter = 'all' | 'review' | 'mine';
const hrefCenter = (scope: InboxScope) => `/release-center?${new URLSearchParams({ project: scope.projectId, target: scope.targetId })}`;
const DECISION_REFRESH_INTERVAL_MS = 10_000;
const STALE_APPROVAL_READ_MS = 15_000;

export function ReleaseApprovalPage(): JSX.Element {
  const canManage = useCanManageConsole();
  const pathId = useParams().authorizationId;
  const [params] = useSearchParams();
  const authorizationId = pathId || params.get('request');
  const projectId = params.get('project') || '';
  const targetId = params.get('target') || '';
  const [selectedScope, setSelectedScope] = useState<InboxScope>();
  const [resolvedId, setResolvedId] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const refreshInbox = useCallback(() => setRefresh(n => n + 1), []);
  const scope = projectId && targetId ? { projectId, targetId } : selectedScope;
  const back = canManage ? { label: '环境管理', href: scope ? hrefCenter(scope) : '/release-center' }
    : { label: '项目列表', href: '/project-list' };
  return <AppShell active="release-center" topbar={<TopBar left={<Crumb items={[back, { label: '审批列表' }]} />} />}>
    <Workspace fluid className="overflow-y-auto">
      <ApprovalInbox scope={scope} refresh={refresh} onRefresh={refreshInbox} opening={Boolean(authorizationId && authorizationId !== resolvedId)} />
      {authorizationId ? <ApprovalDetail key={authorizationId} id={authorizationId} scope={scope}
        onScope={setSelectedScope} onResolved={setResolvedId} onChanged={refreshInbox} /> : null}
    </Workspace>
  </AppShell>;
}

function ApprovalInbox({ scope, refresh, onRefresh, opening }: {
  scope?: InboxScope; refresh: number; onRefresh: () => void; opening: boolean;
}): JSX.Element {
  const [state, setState] = useState<ReleaseApprovalRead<ReleaseApprovalInbox>>();
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNowTick(Boolean(state?.result));
  const key = scope ? new URLSearchParams(scope).toString() : '';
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void apiRequest<ReleaseApprovalInbox>(`/api/releases/approval-inbox?${key}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result?.target || !Array.isArray(result.records)) throw new Error('审批列表响应不完整');
        setState({ key, result });
      })
      .catch(error => {
        if (!controller.signal.aborted) setState(previous => releaseApprovalReadFailure(previous, key, error, releaseGovernanceFailure(error)));
      });
    return () => controller.abort();
  }, [key, refresh]);

  const result = state?.key === key ? state?.result : undefined;
  const error = state?.key === key ? state?.error : undefined;
  if (!result && !error && (key || opening)) return <ReleaseApprovalSkeleton hasScope={Boolean(key || opening)} />;

  const records = result?.records.map(record => ({ ...record, state: releaseApprovalState(record, now) })) || [];
  const waiting = records.filter(record => record.state === 'pending' && record.mayReview);
  const mine = records.filter(record => record.applicant);
  const visible = filter === 'review' ? waiting : filter === 'mine' ? mine
    : [...waiting, ...records.filter(record => record.state !== 'pending' || !record.mayReview)];
  const filterOptions: Array<{ id: Filter; name: string; count: number }> = [
    { id: 'all', name: '全部申请', count: records.length }, { id: 'review', name: '待我审批', count: waiting.length },
    { id: 'mine', name: '我发起的', count: mine.length },
  ];
  return <div className={APPROVAL_INBOX_CLASS}>
    <div className="mb-4 flex justify-end">
      <Button variant="ghost" size="sm" onClick={onRefresh}><RotateCw />刷新记录</Button>
    </div>
    <header className="mb-5">
      <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground"><ClipboardList className="size-4 text-primary" />{result?.target.name || '发布中心'}{result?.target.environment === 'staging' ? ' · 预发' : ''}</span>
      <h1 id="release-approval-inbox" tabIndex={-1} className="mt-1 text-2xl font-semibold">审批列表</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">{waiting.length ? `有 ${waiting.length} 笔申请需要你审批。打开一笔核对范围，再决定是否批准。` : '打开申请查看当前状态、下一步和审批记录。'}</p>
    </header>
    {error ? <p role="alert" className="mb-3 text-sm text-bad">{result ? '刷新失败，仍显示上次读取的记录。' : null}{error}</p> : null}
    {!result && !error ? <p className="text-sm text-muted-foreground">从发布中心选中一个环境，再打开该环境的审批列表。</p> : null}
    {result ? <section aria-label="环境审批申请" className={APPROVAL_ROWS_CLASS}>
        <div className={APPROVAL_FILTERS_CLASS}>
          {filterOptions.map(option => <Button key={option.id} variant={filter === option.id ? 'secondary' : 'ghost'} size="sm" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>
            {option.name}<span className="tabular-nums text-muted-foreground">{option.count}</span>
          </Button>)}
        </div>
        {visible.length ? <ul aria-label="审批申请" className="divide-y divide-[hsl(var(--hairline))]">
          {visible.map(record => <li key={record.id}>
            <Link to={releaseApprovalPath(record.id, scope)} data-approval-row={record.id} className={`${APPROVAL_ROW_CLASS} group hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{releaseApprovalTitle(record)}</span>
                  <Chip tone={record.state === 'pending' && record.mayReview || record.state === 'expired' ? 'warn' : record.state === 'approved' ? 'ok' : 'muted'}>
                    {record.state === 'pending' && record.mayReview ? '待你审批' : releaseApprovalLabels[record.state]}
                  </Chip>
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground" title={record.purpose}>{record.purpose}</p>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{record.branchName} · {record.candidateSha.slice(0, 12)}</div>
              </div>
              <div className="col-start-1 row-start-2 text-xs text-muted-foreground sm:col-auto sm:row-auto">
                <span className="font-medium text-foreground">{record.applicant ? '我发起的' : releaseActorLabel(record.requestedBy)}</span>
                <span className="ml-2 sm:hidden">截止 {formatDateTime(record.expiresAt)}</span>
              </div>
              <div className="hidden text-xs text-muted-foreground sm:block">截止 {formatDateTime(record.expiresAt)}</div>
              <span className="row-start-1 inline-flex items-center gap-1.5 col-start-2 text-sm text-primary sm:col-auto sm:row-auto">
                <span className="sr-only sm:not-sr-only">查看申请</span><ArrowUpRight className="size-4" />
              </span>
            </Link>
          </li>)}
        </ul> : <p className="px-5 py-7 text-sm text-muted-foreground">{filter === 'review' ? '没有需要你审批的申请。' : filter === 'mine' ? '你还没有在此环境发起申请。' : '这个环境还没有审批申请。'}</p>}
      </section> : null}
  </div>;
}

function ApprovalDetail({ id, scope, onScope, onResolved, onChanged }: {
  id: string; scope?: InboxScope; onScope: (scope: InboxScope) => void; onResolved: (id: string) => void; onChanged: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const canManage = useCanManageConsole();
  const [read, setRead] = useState<ReleaseApprovalRead<ReleaseApprovalDetail>>();
  const { result: data, error: loadError } = read || {};
  const [notice, setNotice] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [command, setCommand] = useState<Command>();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const activeRead = useRef<{ controller: AbortController; startedAt: number } | null>(null);
  const submitting = useRef(false);
  const lastStatus = useRef<ReleaseApprovalDetail['authorization']['status']>();
  const decisionField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (command) decisionField.current?.focus(); }, [command]);
  const now = useNowTick(Boolean(data));
  const endpoint = `/api/releases/authorizations/${encodeURIComponent(id)}`;
  const readApproval = useCallback((replace = false) => {
    const startedAt = Date.now();
    const reading = activeRead.current;
    if (submitting.current || (!replace && reading && startedAt - reading.startedAt < STALE_APPROVAL_READ_MS)) return;
    reading?.controller.abort();
    const controller = new AbortController();
    activeRead.current = { controller, startedAt };
    void apiRequest<ReleaseApprovalDetail>(endpoint, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const { projectId, targetId, status } = result.authorization;
      onScope({ projectId, targetId });
      setRead({ key: endpoint, result });
      if (lastStatus.current && lastStatus.current !== status) onChanged();
      lastStatus.current = status;
    }).catch(error => {
      if (controller.signal.aborted) return;
      const message = error instanceof ApiError && error.status === 404
        ? '找不到这笔申请。请向发起人索取正确链接。' : releaseGovernanceFailure(error);
      setRead(previous => releaseApprovalReadFailure(previous, endpoint, error, message));
    }).finally(() => {
      if (activeRead.current?.controller === controller) activeRead.current = null;
      if (!controller.signal.aborted) onResolved(id);
    });
  }, [endpoint, id, onChanged, onResolved, onScope]);
  useEffect(() => {
    readApproval();
    return () => {
      activeRead.current?.controller.abort();
      activeRead.current = null;
    };
  }, [readApproval]);

  const waitingForDecision = Boolean(data?.viewer.applicant && releaseApprovalState(data.authorization, now) === 'pending');
  useEffect(() => {
    if (!waitingForDecision) return;
    const refreshVisible = () => { if (!document.hidden) readApproval(); };
    const timer = window.setInterval(refreshVisible, DECISION_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [readApproval, waitingForDecision]);

  function close() {
    if (sending) return;
    const record = data?.authorization;
    const target = record || scope;
    navigate(target ? releaseApprovalInboxPath(target.projectId, target.targetId) : '/release-center/approval', { replace: true });
  }

  if (!data) return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent frame style={{ width: APPROVAL_DIALOG_WIDTH }}>
      <DialogHeader className={APPROVAL_DIALOG_HEADER_CLASS}>
        <DialogDescription className={loadError ? 'text-left' : 'sr-only'}>{loadError || '正在核对这笔申请和你的访问权限。'}</DialogDescription>
        {!loadError ? <div className="flex h-5 items-center gap-2" aria-hidden="true"><span className="cds-loading-skeleton-line h-3 w-20" /><span className="cds-loading-skeleton-line h-4 w-12" /></div> : null}
        <DialogTitle className="text-left text-xl font-semibold">{loadError ? '无法打开发布审批' : '读取发布审批'}</DialogTitle>
      </DialogHeader>
      {loadError ? <div className={APPROVAL_DIALOG_BODY_CLASS}><Button variant="outline" onClick={() => readApproval(true)}>重新读取</Button></div>
        : <ReleaseApprovalDetailSkeleton />}
    </DialogContent>
  </Dialog>;

  const { authorization: record, target, viewer } = data;
  const state = releaseApprovalState(record, now);
  const typeLabel = releaseApprovalTitle(record);
  const center = hrefCenter(record);
  const shareUrl = new URL(releaseApprovalPath(id), window.location.origin).href;
  const approval = record.decisions?.find(decision => decision.action === 'approved');
  const review = state === 'pending' && viewer.mayReview;
  const waiting = state === 'pending' && viewer.applicant;
  const reapply = state === 'expired' && viewer.mayReapply;
  const mayContinue = state === 'approved' && viewer.applicant && canManage && !record.scheduledJobId && !record.deploymentVersionId;
  const mayContinueBatch = state === 'approved' && viewer.applicant && canManage && Boolean(record.deploymentVersionId);
  const approvedLabel = approval ? releaseActorLabel(approval.by) : releaseActorLabel(record.decidedBy);
  const next = review ? '轮到你审批' : waiting ? '等待另一位成员审批' : state === 'expired' ? '需要重新申请'
    : state === 'approved' ? '已批准，等待执行' : state === 'used' ? '这笔批准已使用'
      : state === 'rejected' ? '申请已拒绝' : state === 'revoked' ? '授权已撤销' : '这笔申请暂不可审批';
  const help = review ? '核对分支、范围和截止时间，再批准或拒绝。' : waiting ? '你是申请人。把这笔申请发给另一位有项目授权的成员。'
    : state === 'expired' ? (reapply ? '这笔申请不能再批准，请重新发起。' : '这笔申请不能再批准，请让原申请人重新发起。')
      : state === 'approved' ? `由 ${approvedLabel} 批准。${record.scheduledJobId ? '等待指定任务执行。' : '接下来由申请人执行。'}`
        : (record.decisionReason || '在下方查看审批记录。');
  function open(nextCommand: Command) {
    setReason(nextCommand === 'reapply' ? record.reason : ''); setSubmitError(''); setCommand(nextCommand);
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(shareUrl); setNotice('已复制这笔申请的链接'); }
    catch { setShowLink(true); setNotice('请复制下方的审批链接'); }
  }
  async function submit() {
    if (!command || submitting.current || loadError || (command === 'reapply' ? !reapply : !review)) return;
    submitting.current = true;
    activeRead.current?.controller.abort();
    activeRead.current = null;
    setSending(true); setSubmitError('');
    try {
      if (command === 'reapply') {
        const result = await apiRequest<{authorization: { id: string }}>(`/api/releases/targets/${encodeURIComponent(record.targetId)}/authorizations`, {
          method:'POST', body: { branchId: record.branchId, kind: record.kind, action: record.action,
            allowedPaths: record.allowedPaths, rollbackReleaseId: record.rollbackReleaseId,
            deploymentVersionId: record.deploymentVersionId, scheduledJobId: record.scheduledJobId,
            expiresAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(), reason: reason.trim() },
        });
        onChanged(); navigate(releaseApprovalPath(result.authorization.id, record), { replace: true }); return;
      }
      const result = await apiRequest<{authorization: ReleaseApprovalDetail['authorization']}>(`${endpoint}/${command}`, { method:'POST', body:{ reason:reason.trim() } });
      lastStatus.current = result.authorization.status;
      setRead({ key: endpoint, result: { ...data!, authorization: result.authorization } });
      setCommand(undefined); onChanged();
      setNotice(command === 'approve' ? '批准已保存，申请人可以继续执行' : '拒绝已保存');
    } catch (error) { setSubmitError(releaseGovernanceFailure(error)); }
    finally { submitting.current = false; setSending(false); }
  }
  const commandLabel = command === 'reapply' ? '重新申请' : command === 'reject' ? '拒绝申请' : '填写批准意见';
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent frame style={{ width: APPROVAL_DIALOG_WIDTH }} aria-describedby="approval-next-step"
      onEscapeKeyDown={event => { if (sending) event.preventDefault(); else if (command) { event.preventDefault(); setCommand(undefined); } }}
      onCloseAutoFocus={event => {
        const row = Array.from(document.querySelectorAll<HTMLElement>('[data-approval-row]')).find(item => item.dataset.approvalRow === id);
        const nextFocus = row || document.getElementById('release-approval-inbox');
        if (nextFocus) { event.preventDefault(); nextFocus.focus({ preventScroll:true }); }
      }}>
      <DialogHeader className={APPROVAL_DIALOG_HEADER_CLASS}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{target.name}{target.environment === 'staging' ? ' · 预发' : ''}<Chip tone={state === 'pending' || state === 'expired' ? 'warn' : state === 'approved' ? 'ok' : 'muted'}>{releaseApprovalLabels[state]}</Chip></div>
        <DialogTitle className="text-left text-xl font-semibold">{typeLabel}</DialogTitle>
      </DialogHeader>
      <div className={APPROVAL_DIALOG_BODY_CLASS}>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">申请人</dt><dd className="break-words">{releaseActorLabel(record.requestedBy)}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-muted-foreground">截止时间 · 本地</dt><dd className="break-words tabular-nums">{formatDateTime(record.expiresAt)}</dd></div>
          <div className="col-span-2 min-w-0"><dt className="text-xs text-muted-foreground">执行分支</dt><dd className="break-all font-mono text-xs leading-5">{record.branchName} · {record.candidateSha.slice(0, 12)}</dd></div>
          <div className="col-span-2 min-w-0"><dt className="text-xs text-muted-foreground">批准范围</dt><dd className="break-all font-mono text-xs leading-5">{record.kind === 'debug' ? <ul>{record.allowedPaths.map(path => <li key={path}>{path}</li>)}</ul> : '仅此固定版本，使用一次'}</dd></div>
        </dl>
        <details className="rounded-md border border-[hsl(var(--hairline))] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">申请依据与审批记录</summary>
          <div className="mt-2 space-y-2 text-sm"><p className="whitespace-pre-wrap break-words">{record.reason}</p>
            <div className="break-all text-xs text-muted-foreground">候选版本：{record.candidateSha}<br />主干依据：{record.mainSha}
              {record.deploymentVersionId ? <><br />固定部署版本：{record.deploymentVersionId}</> : null}
              {record.rollbackReleaseId ? <><br />回滚记录：{record.rollbackReleaseId}</> : null}
              {record.scheduledJobId ? <><br />执行任务：{record.scheduledJobId}</> : null}
            </div>
            {record.decisions?.length ? <ol aria-label="审批记录" className="space-y-1">{record.decisions.map((decision,index) => <li key={index}>{formatDateTime(decision.at)} · {releaseActorLabel(decision.by)} · {releaseApprovalLabels[decision.action]}：{decision.reason}</li>)}</ol> : <p className="text-xs text-muted-foreground">暂无审批决定。</p>}
          </div>
        </details>
        {command ? <div className="space-y-2 rounded-md border border-[hsl(var(--hairline))] px-3 py-3">
          <p className="text-sm font-semibold">{commandLabel}</p>
          {command === 'reapply' ? <label className="block text-sm">有效期<select className={`${field} mt-1`} value={minutes} onChange={e => setMinutes(e.target.value)}><option value="15">15 分钟</option><option value="60">1 小时</option><option value="240">4 小时</option><option value="1440">24 小时</option></select></label> : null}
          <label className="block text-sm">{command === 'reapply' ? '申请目的（至少 8 字）' : '审批意见（至少 4 字）'}<textarea ref={decisionField} className={`${field} mt-1`} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>
          {submitError ? <p role="alert" className="text-sm text-bad">{submitError}</p> : null}
          {command !== 'reapply' && !review ? <p role="alert" className="text-sm text-bad">这笔申请现在已不能审批。取消当前操作后可查看最新状态。</p> : null}
        </div> : null}
        {showLink ? <input className={field} aria-label="可复制的审批链接" readOnly value={shareUrl} onFocus={e => e.currentTarget.select()} /> : null}
      </div>
      <footer className={APPROVAL_DIALOG_FOOTER_CLASS}>
        <div id="approval-next-step" className="text-xs leading-5 text-muted-foreground" aria-live="polite"><strong className="mr-2 text-sm text-foreground">{next}</strong>{command === 'reapply' ? '新申请会重新核验当前分支和批准范围。' : command ? '决定会记录你的身份，不会直接执行发布。' : help}</div>
        {loadError ? <p role="alert" className="text-xs text-bad">暂时无法核对最新审批状态，请刷新申请。{loadError}</p> : null}
        {notice ? <p role="status" className="text-xs text-ok">{notice}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {command ? <>
            <Button variant="outline" disabled={sending} onClick={() => setCommand(undefined)}>取消</Button>
            <Button variant={command === 'reject' ? 'destructive' : 'default'} disabled={Boolean(loadError) || sending || (command === 'reapply' ? !reapply || reason.trim().length < 8 : !review || reason.trim().length < 4)} onClick={() => void submit()}>{sending ? '正在保存…' : command === 'reapply' ? '提交新申请' : command === 'reject' ? '确认拒绝' : '确认批准'}</Button>
          </> : <>
            <Button variant={loadError ? 'default' : 'ghost'} onClick={() => readApproval(true)}><RotateCw />刷新申请</Button>
            {review && !loadError ? <><Button variant="outline" onClick={() => open('reject')}>拒绝</Button><Button onClick={() => open('approve')}><Check />批准申请</Button></> : null}
            {waiting && !loadError ? <Button onClick={() => void copyLink()}><Copy />复制审批链接</Button> : null}
            {reapply && !loadError ? <Button onClick={() => open('reapply')}>重新申请</Button> : null}
            {mayContinue && !loadError ? <Button asChild><Link to={record.action === 'release' ? releaseApprovalWorkbenchPath(record) : center}>{record.action === 'release' ? '前往发布工作台' : '返回环境管理'}</Link></Button> : null}
            {mayContinueBatch && !loadError ? <Button asChild><Link to={`/release-console?${new URLSearchParams({ project: record.projectId, mode: 'batch' })}`}>前往批次发布</Link></Button> : null}
            {!review && !waiting && !reapply && !mayContinue && !mayContinueBatch && !loadError ? <Button variant="outline" onClick={close}>返回列表</Button> : null}
          </>}
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}
