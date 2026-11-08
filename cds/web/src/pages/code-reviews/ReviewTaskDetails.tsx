import { Link } from 'react-router-dom';
import { ArrowUpRight, Mail, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { codeReviewReportUrl, type CodeReviewTask } from '@/lib/codeReviews';
import { explainReviewError, isReviewActive as isActive, reviewCoverage, reviewTaskExplanation, reviewTaskLabel } from '@/lib/codeReviewView';
const deliveryLabels: Record<CodeReviewTask['delivery']['status'], string> = {
  not_requested: '仅报告中心', pending: '等待邮件投递', sending: '正在发送邮件', sent: '邮件已发送', failed: '邮件发送失败',
};
export function ErrorNotice({ message, title }: { message: string; title?: string }): JSX.Element {
  const explained = explainReviewError(message);
  return <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm">
    <p className="font-medium text-destructive">{title || explained.title}</p>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">{explained.next}</p>
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">技术详情</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono">{message}</pre></details>
  </div>;
}

export function TaskStatus({ task }: { task: CodeReviewTask }): JSX.Element {
  const view = reviewTaskLabel(task);
  const tone = view.tone === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : view.tone === 'warning' ? 'border-warn/30 bg-warn-soft text-warn' : 'border-border text-muted-foreground';
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${tone}`}>{isActive(task) ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}{view.label}</span>;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const findingLabels: Record<string, string> = { critical: '严重', high: '高风险', medium: '中风险', low: '低风险', info: '提示', p0: '阻断', p1: '高优先级', p2: '一般', p3: '建议' };
export function ReviewDetail({ task, now, pending, onAction, onClose }: {
  task: CodeReviewTask; now: number; pending: boolean; onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void; onClose?: () => void;
}): JSX.Element {
  const reportUrl = codeReviewReportUrl(task);
  const active = isActive(task);
  const coverage = reviewCoverage(task);
  const percent = task.progress.totalFiles > 0 && task.progress.scannedFiles <= task.progress.totalFiles ? Math.round(task.progress.scannedFiles / task.progress.totalFiles * 100) : undefined;
  const elapsed = Math.max(0, Math.floor((now - new Date(task.createdAt).getTime()) / 1000));
  return <article aria-label="审查任务详情" className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-5">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0 space-y-2"><TaskStatus task={task} /><h3 className="break-words text-base font-semibold leading-6">{task.title || task.sourceName}</h3></div>{onClose ? <Button variant="ghost" size="icon" aria-label="关闭任务详情" onClick={onClose}><X /></Button> : null}</div>
    <p className="break-words text-sm text-muted-foreground">{task.sourceName}{task.commitSha ? ` · ${task.commitSha.slice(0, 12)}` : ''}</p>
    <p className="text-sm leading-6">{reviewTaskExplanation(task)}</p>
    {task.sourceType !== 'report' ? <div aria-live="polite" className={`space-y-2 rounded-lg p-3 ${coverage.kind === 'partial' || coverage.kind === 'unknown' ? 'bg-warn-soft' : 'bg-muted/30'}`}>
      <p className="text-sm font-medium">{coverage.text}</p>
      {active ? <><progress className="h-2 w-full accent-primary" aria-label="审查文件进度" max={100} value={percent} /><p className="text-xs text-muted-foreground">创建后 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒 · 排队时间也包含在内</p></> : null}
      {task.inputSkippedFiles ? <p className="text-xs leading-5 text-muted-foreground">另有 {task.inputSkippedFiles} 项未纳入本次分析，请在报告中核对跳过原因。</p> : null}
    </div> : null}
    {task.error ? <ErrorNotice message={task.error} title="本次审查失败" /> : null}
    {task.findingsSummary && Object.keys(task.findingsSummary).length ? <div><h4 className="mb-2 text-xs font-medium text-muted-foreground">报告中的发现</h4><div className="flex flex-wrap gap-2">{Object.entries(task.findingsSummary).map(([key, count]) => <span key={key} className="rounded-md bg-muted px-2 py-1 text-xs">{findingLabels[key] || key}：{count}</span>)}</div><p className="mt-2 text-xs text-muted-foreground">发现数为工具输出，需结合报告中的证据核实。</p></div> : null}
    <div className="flex flex-wrap gap-2">{reportUrl ? <Button asChild size="sm"><Link to={reportUrl}>{task.sourceType === 'report' ? '阅读上传档案' : '阅读审查报告'}<ArrowUpRight /></Link></Button> : null}{active ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('cancel')}><X />取消审查</Button> : null}{task.sourceType !== 'report' && (task.status === 'failed' || task.status === 'cancelled') ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('retry')}><RefreshCw />重新审查</Button> : null}{task.delivery.status === 'failed' && task.reportId ? <Button variant="outline" size="sm" disabled={pending} onClick={() => onAction('delivery/retry')}><Mail />重试邮件</Button> : null}{pending ? <ContentLoading label="正在处理审查操作" variant="inline" /> : null}</div>
    {task.delivery.status !== 'not_requested' ? <div className="rounded-lg border border-border p-3 text-xs"><p className="font-medium">{deliveryLabels[task.delivery.status]}</p>{task.delivery.email ? <p className="mt-1 break-all text-muted-foreground">{task.delivery.email}</p> : null}{task.delivery.error ? <div className="mt-2"><ErrorNotice message={task.delivery.error} title="报告已保存，邮件尚未送达" /></div> : null}</div> : null}
    <details className="border-t border-border pt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">任务与技术详情</summary><dl className="mt-3 space-y-2"><div><dt className="text-muted-foreground">来源</dt><dd className="mt-1 break-all">{task.sourceName}</dd></div><div><dt className="text-muted-foreground">任务编号</dt><dd className="mt-1 break-all font-mono">{task.id}</dd></div><div><dt className="text-muted-foreground">原始阶段</dt><dd className="mt-1 break-all">{task.phase}</dd></div>{task.commitSha ? <div><dt className="text-muted-foreground">固定提交</dt><dd className="mt-1 break-all font-mono">{task.commitSha}</dd></div> : null}{task.sourceHash ? <div><dt className="text-muted-foreground">快照哈希</dt><dd className="mt-1 break-all font-mono">{task.sourceHash}</dd></div> : null}<div><dt className="text-muted-foreground">最近更新</dt><dd className="mt-1">{formatDate(task.updatedAt)}</dd></div></dl></details>
  </article>;
}
