import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Mail, RefreshCw, X } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { codeReviewReportUrl, getCodeReviewAudit, type CodeReviewTask, type CodeReviewAuditPage } from '@/lib/codeReviews';
import { explainReviewError, isReviewActive, reviewCoverage, reviewTaskExplanation, reviewTaskLabel } from '@/lib/codeReviewView';
import { ReviewButton } from './ReviewUi';

const deliveryLabels: Record<CodeReviewTask['delivery']['status'], string> = { not_requested: '仅报告中心', pending: '等待邮件投递', sending: '正在发送邮件', sent: '邮件已发送', failed: '邮件发送失败' };
export function ErrorNotice({ message, title }: { message: string; title?: string }): JSX.Element {
  const explained = explainReviewError(message);
  return <div role="alert" className="cr-notice cr-notice-error"><strong className="cr-row-inline"><AlertTriangle className="size-4" />{title || explained.title}</strong><p>{explained.next}</p><details className="cr-small"><summary>技术详情</summary><pre className="cr-code cr-break">{message}</pre></details></div>;
}
export function TaskStatus({ task }: { task: CodeReviewTask }): JSX.Element {
  const view = reviewTaskLabel(task), active = isReviewActive(task);
  const label = task.sourceType === 'report' ? '已保存' : view.label === '报告已生成' ? '已完成' : view.label === '部分覆盖' ? '部分完成' : view.label === '审查失败' ? '失败' : view.label;
  const tone = active ? task.status === 'queued' ? 'idle' : 'running' : view.tone === 'error' ? 'error' : view.tone === 'warning' ? 'warning' : task.status === 'completed' && task.sourceType !== 'report' && reviewCoverage(task).kind === 'counted' ? 'ok' : 'neutral';
  return <span className={`cr-status cr-status-${tone}`}><i aria-hidden="true" />{label}</span>;
}
export function formatDate(value: string): string { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未提供'; }
const timeOnly = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未记录';
const stages = [{ id: 'queued', title: '排队', text: '任务已创建并进入队列。' }, { id: 'preparing', title: '准备源码', text: '准备本次审查的固定源码快照。' }, { id: 'running', title: '分析', text: '按已提交的范围执行分析，发现仍需结合证据核实。' }, { id: 'archiving', title: '归档', text: '生成报告正文并归档至报告中心。' }];
function stageOf(task: CodeReviewTask): number {
  if (task.status === 'completed') return 4;
  const direct = stages.findIndex(stage => stage.id === task.status);
  if (direct >= 0) return direct;
  return task.engineCompleted ? 3 : task.engineTaskId || task.progress.scannedFiles > 0 ? 2 : -1;
}

export function ReviewDetail({ task, now, pending, onAction, onClose }: { task: CodeReviewTask; now: number; pending: boolean; onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void; onClose?: () => void }): JSX.Element {
  const [cancelConfirm, setCancelConfirm] = useState(false), [retryConfirm, setRetryConfirm] = useState(false);
  const active = isReviewActive(task), coverage = reviewCoverage(task), stage = stageOf(task), reportUrl = codeReviewReportUrl(task);
  const progressKnown = task.progress.totalFiles > 0 && task.progress.scannedFiles >= 0 && task.progress.scannedFiles <= task.progress.totalFiles;
  const count = task.findingsSummary ? Object.values(task.findingsSummary).reduce((n, value) => n + value, 0) : undefined;
  const phaseText = task.status === 'failed' || task.status === 'cancelled' ? task.error || reviewTaskExplanation(task) : task.phase;
  return <article aria-label="审查任务详情" className="cr-stack">
    {onClose ? <ReviewButton tone="ghost" className="cr-icon-button cr-end" aria-label="关闭任务详情" onClick={onClose}><X /></ReviewButton> : null}
    {task.sourceType === 'report' ? <div className="cr-surface cr-progress-summary"><h2>文档信息</h2><dl className="cr-facts"><dt>来源</dt><dd>{task.sourceName}</dd><dt>保存时间</dt><dd>{formatDate(task.createdAt)}（UTC+8）</dd><dt>文档编号</dt><dd className="cr-mono">{task.id}</dd><dt>执行说明</dt><dd>上传的已有文档，未在 CDS 执行 AI 审查。</dd></dl>{reportUrl ? <a className="cr-task-action" href={reportUrl}>阅读上传档案<ChevronRight /></a> : null}</div> : <>
      <div className="cr-progress-grid"><div className="cr-surface cr-stages">{stage < 0 ? <p className="cr-form-note">任务已停止，原记录未提供精确终止阶段；以下不推断各阶段是否完成。</p> : null}{stages.map((item, index) => {
        const failed = index === stage && (task.status === 'failed' || task.status === 'cancelled');
        const state = index < stage ? 'done' : failed ? 'error' : index === stage ? 'current' : 'pending';
        return <div className="cr-stage" key={item.id} data-state={state}><span className="cr-stage-number" aria-hidden="true">{state === 'done' ? <Check /> : index + 1}</span><div className="cr-stage-main"><div className="cr-stage-title"><h3>{item.title}</h3><span className="cr-tag">{state === 'done' ? '完成' : failed ? task.status === 'cancelled' ? '已取消' : '失败' : state === 'current' ? '进行中' : '未开始'}</span></div>
          <p>{index === stage ? phaseText : index === 1 && task.commitSha ? `源码已固定到提交 ${task.commitSha.slice(0, 12)}。` : item.text}</p>
          {index === 2 && progressKnown ? <div className="cr-stage-progress"><progress aria-label="审查文件进度" max={task.progress.totalFiles} value={task.progress.scannedFiles} /><span className="cr-num">{task.progress.scannedFiles.toLocaleString()} / {task.progress.totalFiles.toLocaleString()} 个候选文件</span></div> : null}
        </div></div>;
      })}</div><div className="cr-stack"><div className="cr-surface cr-progress-summary"><dl className="cr-facts"><dt>候选文件</dt><dd className="cr-num">{task.progress.totalFiles > 0 ? task.progress.totalFiles.toLocaleString() : '尚未提供'}</dd><dt>已分析</dt><dd className="cr-num">{progressKnown ? task.progress.scannedFiles.toLocaleString() : '尚未提供'}</dd><dt>已保存发现</dt><dd>{count === undefined ? '尚未提供' : `${count.toLocaleString()} 项（待验证）`}</dd><dt>预计剩余</dt><dd>暂无可靠估计</dd><dt>接收方式</dt><dd>{task.delivery.status === 'not_requested' ? '报告中心' : '报告中心 + 邮件'}</dd></dl>
        <div className="cr-page-actions">{reportUrl ? <a href={reportUrl} className="cr-button cr-button-default">阅读审查报告</a> : null}{active ? <ReviewButton tone="danger" disabled={pending} onClick={() => setCancelConfirm(true)}>取消审查</ReviewButton> : null}
          {task.status === 'failed' || task.status === 'cancelled' ? <ReviewButton disabled={pending} onClick={() => setRetryConfirm(true)}><RefreshCw />重新审查</ReviewButton> : null}
          {task.delivery.status === 'failed' && task.reportId ? <ReviewButton disabled={pending} onClick={() => onAction('delivery/retry')}><Mail />重试邮件</ReviewButton> : null}</div>
        {cancelConfirm && active ? <div role="group" aria-label="确认取消审查" className="cr-confirm-dialog"><p>取消后停止未完成部分，已保存的结果仍可阅读。</p><div className="cr-dialog-actions"><ReviewButton tone="danger" disabled={pending} onClick={() => { setCancelConfirm(false); onAction('cancel'); }}>确认取消</ReviewButton><ReviewButton tone="ghost" onClick={() => setCancelConfirm(false)}>继续等待</ReviewButton></div></div> : null}
        {retryConfirm && !active ? <div role="group" aria-label="确认重试审查" className="cr-confirm-dialog"><p>将继续跟踪原任务，并可能产生新的模型用量。已固定的源码和已有结果保留。</p><div className="cr-dialog-actions"><ReviewButton tone="primary" disabled={pending} onClick={() => { setRetryConfirm(false); onAction('retry'); }}>确认重试审查</ReviewButton><ReviewButton tone="ghost" onClick={() => setRetryConfirm(false)}>取消</ReviewButton></div></div> : null}
      </div><p className="cr-form-note">此页自动查询任务状态，不会重新扫描；刷新浏览器后仍可继续查看本任务。最近记录更新 {formatDate(task.updatedAt)}（UTC+8）。</p></div></div>
      <p className="cr-form-note" role="status">{coverage.text}。{reviewTaskExplanation(task)}{active ? `创建后 ${Math.max(0, Math.floor((now - Date.parse(task.createdAt)) / 60000))} 分钟（含排队）。` : ''}</p>
      {task.inputSkippedFiles ? <p className="cr-form-note">另有 {task.inputSkippedFiles.toLocaleString()} 项未纳入分析，请结合覆盖说明核对。</p> : null}
      {task.error ? <ErrorNotice message={task.error} title="本次审查失败" /> : null}
      <ReviewEvents task={task} />
    </>}
    {task.delivery.status !== 'not_requested' ? <div className="cr-surface cr-progress-summary"><h3>{deliveryLabels[task.delivery.status]}</h3>{task.delivery.email ? <p className="cr-break cr-form-note">{task.delivery.email}</p> : null}{task.delivery.error ? <ErrorNotice message={task.delivery.error} title="报告已保存，邮件尚未送达" /> : null}</div> : null}
    {pending ? <ContentLoading label="正在处理审查操作" variant="inline" /> : null}
    <details className="cr-form-note"><summary>任务与技术详情</summary><dl className="cr-facts"><dt>来源</dt><dd>{task.sourceName}</dd><dt>任务编号</dt><dd className="cr-mono">{task.id}</dd><dt>原始阶段</dt><dd>{task.phase}</dd><dt>固定提交</dt><dd className="cr-mono">{task.commitSha || '未记录'}</dd><dt>快照哈希</dt><dd className="cr-mono">{task.sourceHash || '未记录'}</dd></dl></details>
  </article>;
}

function ReviewEvents({ task }: { task: CodeReviewTask }): JSX.Element {
  const [data, setData] = useState<CodeReviewAuditPage | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void getCodeReviewAudit(task.id, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) setError('事件记录暂时无法读取。'); });
    return () => controller.abort();
  }, [task.id, attempt]);
  const label = (operation?: string) => operation?.startsWith('github.') ? '获取 GitHub 源码' : operation === 'cds.branch_snapshot' ? '固定 CDS 分支源码' : operation?.startsWith('deepaudit.') ? '读取审查引擎响应' : operation || '审查事件';
  return <section className="cr-surface" aria-label="审查事件记录"><header className="cr-event-header cr-row-inline">事件记录（UTC+8）<ReviewButton tone="ghost" className="cr-end" onClick={() => setAttempt(n => n + 1)}>刷新事件</ReviewButton></header>
    <div className="cr-event-log">{data?.nextBefore ? <p>以下仅展示最近 {data.events.length} 条已有上游事件，不代表完整执行日志。</p> : null}<p>{timeOnly(task.createdAt)}　任务已创建</p>{data?.events.slice().reverse().map((event, index) => <p key={event.sequence ?? index}>{timeOnly(event.startedAt)}　{label(event.operation)}{event.status ? ` · HTTP ${event.status}` : ''}{event.outcome ? ` · ${event.outcome}` : ''}</p>)}<p>{timeOnly(task.updatedAt)}　当前记录：{task.phase}</p>{!data && !error ? <ContentLoading label="正在读取已有事件" variant="inline" /> : null}{error ? <p>{error}</p> : null}</div>
    <p className="cr-form-note px-4 py-2">仅显示已保存的事件，不推算未记录的阶段时间。{data?.nextBefore ? '当前为最近一页事件。' : ''}</p>
  </section>;
}
