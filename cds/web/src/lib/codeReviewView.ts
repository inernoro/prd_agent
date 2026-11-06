import { CODE_REVIEW_STATUS, type CodeReviewTask } from './codeReviews';

export const REVIEW_PAGE_SIZE = 20;
export type ReviewFilter = 'all' | 'active' | 'attention' | 'reports' | 'archives';
export type ReviewTone = 'neutral' | 'warning' | 'error';

export function isReviewActive(task: CodeReviewTask): boolean {
  return task.sourceType !== 'report' && Boolean(CODE_REVIEW_STATUS[task.status]?.active);
}

export function reviewCoverage(task: CodeReviewTask): { kind: 'external' | 'pending' | 'unknown' | 'partial' | 'counted'; text: string } {
  if (task.sourceType === 'report') return { kind: 'external', text: '上传的外部报告，未在 CDS 执行 AI 审查' };
  const { totalFiles: total, scannedFiles: scanned } = task.progress;
  if (!Number.isFinite(total) || !Number.isFinite(scanned) || scanned > total || total <= 0 || scanned < 0) {
    return { kind: isReviewActive(task) ? 'pending' : 'unknown', text: isReviewActive(task) ? '等待统计分析范围' : '扫描覆盖尚未确认' };
  }
  if (scanned === 0) return { kind: isReviewActive(task) ? 'pending' : 'unknown', text: `尚无有效分析结果 · 本批 ${total} 个文件` };
  if (scanned < total) return { kind: 'partial', text: `${scanned} / ${total} 个文件已分析 · 部分覆盖` };
  return { kind: 'counted', text: `本批 ${scanned} / ${total} 个文件已分析` };
}

export function needsReviewAttention(task: CodeReviewTask): boolean {
  return task.status === 'failed' || task.status === 'cancelled' || task.delivery.status === 'failed'
    || task.sourceType !== 'report' && task.status === 'completed' && ['unknown', 'partial'].includes(reviewCoverage(task).kind);
}

export function reviewTaskLabel(task: CodeReviewTask): { label: string; tone: ReviewTone } {
  if (task.status === 'failed') return { label: '审查失败', tone: 'error' };
  if (task.status === 'cancelled') return { label: '已取消', tone: 'neutral' };
  if (task.sourceType === 'report') return { label: '上传归档', tone: 'neutral' };
  if (task.status === 'completed') {
    const coverage = reviewCoverage(task);
    if (coverage.kind === 'unknown') return { label: '覆盖待核实', tone: 'warning' };
    if (coverage.kind === 'partial') return { label: '部分覆盖', tone: 'warning' };
    return { label: task.reportId ? '报告已生成' : '等待归档', tone: 'neutral' };
  }
  return { label: CODE_REVIEW_STATUS[task.status]?.label || task.status, tone: 'neutral' };
}

export function reviewTaskExplanation(task: CodeReviewTask): string {
  if (task.sourceType === 'report') return '这是一份上传保存的报告，不代表 CDS 已对源码执行过 AI 审查。';
  if (task.status === 'failed') return '本次审查未能完成。失败不代表代码没有问题，也不代表代码质量不合格。';
  if (task.status === 'cancelled') return '任务已停止，未完成的文件没有形成审查结论。需要继续时可重新审查。';
  if (task.status === 'completed') {
    if (reviewCoverage(task).kind === 'partial') return '报告只覆盖已完成分析的文件，不能作为整个项目审查完成的依据。请查看报告中的未覆盖项。';
    if (reviewCoverage(task).kind === 'unknown') return '任务虽然已结束，但没有足够的扫描计数证明覆盖情况。请先核对报告，不要按全量审查通过使用。';
    return '本批分析结果已保存。文件计数只对应本次提交的范围，具体发现和跳过项请以报告为准。';
  }
  const descriptions: Partial<Record<CodeReviewTask['status'], string>> = {
    queued: '任务已进入队列，尚未开始分析。可离开页面，稍后回来查看进度。',
    preparing: '正在检查代码来源并准备本次审查的固定快照。',
    running: '正在分析本批源码。文件进度和后续结果会自动更新。',
    archiving: '正在汇总分析结果并保存报告，报告归档后即可阅读。',
  };
  return descriptions[task.status] || '请查看最新任务状态。';
}

export function explainReviewError(error: string): { title: string; next: string } {
  if (/限流|配额|rate.?limit|quota|429/i.test(error)) return { title: '模型服务请求受限', next: '请等待服务限额恢复后重试；如持续出现，请管理员检查模型配额与并发配置。' };
  if (/模型|模型池|provider|litellm|\bllm\b/i.test(error)) {
    if (/401|403|认证|unauthor|forbidden/i.test(error)) return { title: '模型服务认证失败', next: '请管理员检查审查引擎的模型服务凭据，恢复访问后再重试本次任务。' };
    if (/超时|timeout|timed out/i.test(error)) return { title: '模型服务响应超时', next: '请确认模型服务可用后重试；必要时缩小单次提交的文件范围。' };
    return { title: '模型服务暂不可用', next: '请管理员检查可用模型与服务配置，恢复后再重试。更换源码上传方式无法解决模型连接问题。' };
  }
  if (/401|403|unauthor|forbidden|授权|权限|认证/i.test(error)) return { title: '访问授权未通过', next: '请确认仓库和审查服务的访问权限，再重试。私有仓库也可改为上传 ZIP。' };
  if (/timeout|timed out|超时/i.test(error)) return { title: '服务响应超时', next: '请确认审查服务可用后重试；必要时缩小单次提交的文件范围。' };
  if (/coverage|覆盖|未分析|未扫描/i.test(error)) return { title: '扫描覆盖不足', next: '请核对已分析文件和跳过项，再补充审查尚未覆盖的代码。' };
  if (/未配置|not configured|不可达|ECONN|ENOTFOUND|503|502/i.test(error)) return { title: '服务暂不可用', next: '请稍后重试，或请管理员检查审查服务的连接配置。' };
  return { title: '本次操作未完成', next: '请展开技术详情确认失败信息，检查服务状态后重试。' };
}

export function summarizeReviews(tasks: CodeReviewTask[]) {
  const active = tasks.filter(isReviewActive).length;
  const attention = tasks.filter(needsReviewAttention).length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  const partial = tasks.filter(task => task.sourceType !== 'report' && task.status === 'completed' && ['partial', 'unknown'].includes(reviewCoverage(task).kind)).length;
  const reports = tasks.filter(task => task.sourceType !== 'report' && Boolean(task.reportId)).length;
  const archives = tasks.filter(task => task.sourceType === 'report' && Boolean(task.reportId)).length;
  const headline = failed || partial
    ? `${failed ? `${failed} 项审查失败` : ''}${failed && partial ? '，' : ''}${partial ? `${partial} 份报告的覆盖仍需核对` : ''}。`
    : active ? `${active} 项审查尚未完成，结果会在此自动更新。`
      : tasks.length ? '已有结果可供查看，请先核对报告的审查范围。' : '从一份代码开始，完成审查后在这里查看结果。';
  return { active, attention, failed, partial, reports, archives, headline };
}

export function reviewPage(tasks: CodeReviewTask[], query: string, filter: ReviewFilter, page: number) {
  const search = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter(task => {
    const matches = filter === 'all' || filter === 'active' && isReviewActive(task)
      || filter === 'attention' && needsReviewAttention(task)
      || filter === 'reports' && task.sourceType !== 'report' && Boolean(task.reportId)
      || filter === 'archives' && task.sourceType === 'report';
    return matches && (!search || [task.title, task.sourceName, task.id, task.error || ''].some(value => value.toLocaleLowerCase().includes(search)));
  });
  const pages = Math.max(1, Math.ceil(filtered.length / REVIEW_PAGE_SIZE));
  const current = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), pages - 1);
  return { items: filtered.slice(current * REVIEW_PAGE_SIZE, (current + 1) * REVIEW_PAGE_SIZE), total: filtered.length, pages, page: current };
}
