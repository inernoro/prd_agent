import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronUp, Clock3, Download, GitBranch, MoreHorizontal, Search } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest } from '@/lib/api';
import { downloadCodeReviewReport, readCodeReview, REVIEW_CATEGORIES, REVIEW_SEVERITIES, REVIEW_SEVERITY_LABELS, type CodeReviewRead, type CodeReviewTask, type CodeReviewFinding } from '@/lib/codeReviews';
import { isReviewActive, reviewCoverage } from '@/lib/codeReviewView';
import { ErrorNotice, ReviewDetail, TaskStatus, formatDate } from './ReviewTaskDetails';
import { ReportDocument } from './ReportDocument';
import { ReviewBack, ReviewButton, ReviewCopy, ReviewEmpty, ReviewPagination } from './ReviewUi';

type ReportPayload = { report: { title: string; format: 'html' | 'md' }; content: string };
type ReaderTab = 'findings' | 'original' | 'details';
const findingTitle = (finding: CodeReviewFinding): string => finding.title || finding.message.split('\n').find(line => line.trim()) || '未提供标题';
const pageNumber = (raw: string | null) => { const value = Number(raw || '1'); return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value - 1 : 0; };
export function ReviewSeverity({ severity }: { severity: CodeReviewFinding['severity'] }): JSX.Element { return <span className={`cr-severity cr-severity-${severity}`}>{REVIEW_SEVERITY_LABELS[severity]}</span>; }
export function readableAiExplanation(raw: string): Array<{ label?: string; text: string }> {
  const text = (value: unknown): string => value == null ? '' : typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : JSON.stringify(item, null, 2)).join('\n')
      : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).map(([key, value]) => ({
        label: key === 'what' ? '问题说明' : key === 'why' ? '形成原因' : key === 'how' ? '修复思路' : key === 'learn_more' ? '参考资料' : key,
        text: text(value),
      })).filter(part => part.text.trim());
    }
    return text(value).trim() ? [{ text: text(value) }] : [];
  } catch { return raw.trim() ? [{ text: raw }] : []; }
}

export function ReviewReportReader({ task, projectName, onBack, onAction, pending }: { task: CodeReviewTask; projectName: string; onBack: () => void; onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void; pending: boolean }): JSX.Element {
  const [params, setParams] = useSearchParams(), location = useLocation();
  const imported = task.sourceType === 'report';
  const [defaultTab] = useState<ReaderTab>(imported ? 'findings' : isReviewActive(task) ? 'details' : task.reportId || task.progress.scannedFiles > 0 ? 'findings' : 'details');
  const requestedTab = params.get('tab');
  const tab = (['findings', 'original', 'details'].includes(requestedTab || '') && !(imported && requestedTab === 'original') ? requestedTab : defaultTab) as ReaderTab;
  const severity = REVIEW_SEVERITIES.includes(params.get('severity') as CodeReviewFinding['severity']) ? params.get('severity')! : '';
  const search = params.get('rq') || '', offset = pageNumber(params.get('issuePage')) * 10;
  const [query, setQuery] = useState(search), [read, setRead] = useState<CodeReviewRead | null>(null), [original, setOriginal] = useState<ReportPayload | null>(null);
  const [error, setError] = useState(''), [originalError, setOriginalError] = useState(''), [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState(''), [retryConfirm, setRetryConfirm] = useState(false);
  const [downloadUrls] = useState(() => new Set<string>()), alive = useRef(true), detail = useRef<HTMLDivElement>(null);
  const update = useCallback((changes: Record<string, string | undefined>) => setParams(current => { const next = new URLSearchParams(current); for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); } return next; }, { replace: true, state: location.state }), [setParams, location.state]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const url of downloadUrls) URL.revokeObjectURL(url); }; }, [downloadUrls]);
  useEffect(() => { setQuery(search); }, [search]);
  useEffect(() => {
    if (query === search) return;
    const timer = window.setTimeout(() => update({ rq: query || undefined, issuePage: undefined, issue: undefined, issueEdge: undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [query, search, update]);
  useEffect(() => {
    if (!read?.resultLoading) return;
    const timer = window.setTimeout(() => setAttempt(n => n + 1), 2000); return () => window.clearTimeout(timer);
  }, [read]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void readCodeReview(task.id, { offset, limit: 10, severity, query: search }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setRead(value); })
      .catch(() => { if (!controller.signal.aborted) setError('问题明细暂时无法读取，请重新加载。已有原始报告仍可单独查看。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [task.id, task.updatedAt, offset, severity, search, attempt]);
  const result = read?.result, current = read?.task || task;
  const showArchivedFallback = Boolean(task.reportId && !read?.resultLoading);
  const needsOriginal = tab === 'original' || tab === 'findings' && (imported || !result && !loading && !read?.resultLoading);
  useEffect(() => {
    if (!needsOriginal || original || !task.reportId) return;
    const controller = new AbortController(); setOriginalError('');
    void apiRequest<ReportPayload>(`/api/code-reviews/${encodeURIComponent(task.id)}/report`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setOriginal(value); })
      .catch(() => { if (!controller.signal.aborted) setOriginalError('原文读取失败，请重新加载。'); });
    return () => controller.abort();
  }, [task.id, task.reportId, needsOriginal, original, attempt]);
  const selection = /^\d+$/.test(params.get('issue') || '') ? Number(params.get('issue')) : Number.NaN;
  const finding = result?.findings.find(item => item.index === selection) || (params.get('issueEdge') === 'last' ? result?.findings.at(-1) : result?.findings[0]);
  const position = finding ? result!.findings.indexOf(finding) : -1;
  const totalFindings = result ? Object.values(result.summary).reduce((sum, n) => sum + n, 0) : undefined;
  const coverage = reviewCoverage(current), sha = current.commitSha || current.sourceHash;
  const tabs: Array<[ReaderTab, string, string?]> = imported ? [['findings', '报告内容'], ['details', '文档信息']]
    : [['findings', '问题', totalFindings === undefined ? undefined : String(totalFindings)], ['original', '原始报告', task.reportId ? undefined : '未归档'], ['details', '审查详情']];
  const select = (index: number) => {
    update({ issue: String(index), issueEdge: undefined });
    requestAnimationFrame(() => { if (detail.current && detail.current.getBoundingClientRect().top < (document.querySelector('.cds-main')?.getBoundingClientRect().top || 0)) detail.current.scrollIntoView({ block: 'start' }); });
  };
  const previous = Boolean(result && (position > 0 || offset > 0)), next = Boolean(result && (position < result.findings.length - 1 || result.page.nextOffset !== null));
  const move = (direction: -1 | 1) => {
    if (!result || !finding || loading) return;
    const adjacent = result.findings[position + direction];
    if (adjacent) select(adjacent.index);
    else if (direction < 0 && offset > 0) update({ issuePage: String(offset / 10), issue: undefined, issueEdge: 'last' });
    else if (direction > 0 && result.page.nextOffset !== null) update({ issuePage: String(result.page.nextOffset / 10 + 1), issue: undefined, issueEdge: undefined });
  };
  const download = async (): Promise<void> => {
    if (downloading) return; setDownloading(true); setDownloadError('');
    try {
      const blob = await downloadCodeReviewReport(task.id); if (!alive.current) return;
      const url = URL.createObjectURL(blob); downloadUrls.add(url);
      const link = document.createElement('a'); link.href = url; link.download = `code-review-${task.id}.${blob.type.includes('html') ? 'html' : 'md'}`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    } catch { if (alive.current) setDownloadError('报告下载未完成，请重试。'); }
    finally { if (alive.current) setDownloading(false); }
  };
  const documentView = original ? <div className="cr-document"><ReportDocument {...original.report} content={original.content} /></div>
    : originalError ? <div className="cr-stack"><ErrorNotice message={originalError} /><ReviewButton onClick={() => setAttempt(n => n + 1)}>重新加载报告</ReviewButton></div>
      : task.reportId ? <ContentLoading label="正在读取报告内容" variant="panel" /> : <div className="cr-placeholder">报告尚未归档。已保存的结构化问题仍可阅读与下载；当前未形成完整归档报告。</div>;
  const severitySelect = <select className="cr-input cr-full" aria-label="问题严重程度" value={severity} onChange={e => update({ severity: e.target.value || undefined, issuePage: undefined, issue: undefined, issueEdge: undefined })}><option value="">全部程度{totalFindings === undefined ? '' : ` · ${totalFindings}`}</option>{REVIEW_SEVERITIES.map(key => <option key={key} value={key}>{REVIEW_SEVERITY_LABELS[key]}{result ? ` · ${result.summary[key]}` : ''}</option>)}</select>;
  const changeOffset = (value: number) => update({ issuePage: String(value / 10 + 1), issue: undefined, issueEdge: undefined });
  return <section aria-label="代码审查报告阅读器" className="cr-stack cr-fade cr-reader"><ReviewBack onBack={onBack} />
    <header className="cr-page-header"><div className="cr-page-title"><h1 title={task.title}>{task.title === '代码审查报告' ? task.sourceName : task.title}</h1><TaskStatus task={current} /></div><div className="cr-page-actions">{!imported && (task.status === 'failed' || task.status === 'cancelled') ? <><span className="cr-desktop"><ReviewButton tone="ghost" onClick={() => setRetryConfirm(true)} disabled={pending}>重新审查</ReviewButton></span><details className="cr-mobile"><summary className="cr-button cr-icon-button" aria-label="更多报告操作"><MoreHorizontal /></summary><div className="cr-overflow-menu"><ReviewButton onClick={() => setRetryConfirm(true)} disabled={pending}>重新审查</ReviewButton></div></details></> : null}<ReviewButton className="cr-download" aria-label={downloading ? '正在下载' : task.reportId ? '下载报告' : '下载当前结果'} title={task.reportId ? '下载报告' : '下载当前结果'} disabled={(!task.reportId && !result) || downloading} onClick={() => { void download(); }}><Download /><span className="cr-desktop">{downloading ? '正在下载' : task.reportId ? '下载报告' : '下载当前结果'}</span></ReviewButton></div></header>
    <div className="cr-source-meta"><span className="cr-meta-item">{projectName}</span><span className="cr-meta-item cr-mono cr-break">{imported ? current.sourceName : <><GitBranch />{current.branchName || current.ref || current.sourceName}</>}</span>{sha ? <span className="cr-meta-item cr-mono">{current.commitSha ? '' : 'ZIP 快照 '}{sha.slice(0, 12)}<ReviewCopy compact text={sha} label={current.commitSha ? '复制提交 SHA' : '复制快照哈希'} /></span> : null}<span className="cr-meta-item cr-muted">{formatDate(current.createdAt)}（UTC+8）</span></div>
    <div className="cr-coverage" role="status"><div className="cr-row-inline">{coverage.kind === 'partial' || current.status === 'failed' ? <AlertTriangle /> : null}<strong>{coverage.text}</strong>{!imported ? <span className="cr-muted">{current.error ? '执行已停止，已有结果不代表未分析部分。' : '工具发现均待验证，不代表代码质量通过。'}</span> : null}</div>
      <p>{imported ? '保存已有文档，未将文档声明转换为源码扫描结论。' : result ? `${current.inputSkippedFiles === undefined ? '输入排除数量未记录' : `输入已排除 ${current.inputSkippedFiles.toLocaleString()} 项`} · 覆盖与未执行项见审查详情 · ${current.modelCredential ? `用户 Key · ${current.modelCredential.provider} · ${current.modelCredential.model} · 用量见审查详情` : '模型与费用未提供'}` : '按当前任务记录展示覆盖；检查工具、跳过与未执行项以保存的说明为准。'}</p></div>
    {retryConfirm ? <div role="group" aria-label="确认重新审查" className="cr-notice"><p>继续使用原任务与固定源码，重试可能产生新的模型用量；当前无法可靠预估费用。</p><div className="cr-dialog-actions"><ReviewButton tone="primary" disabled={pending} onClick={() => { setRetryConfirm(false); onAction('retry'); }}>确认重试审查</ReviewButton><ReviewButton tone="ghost" onClick={() => setRetryConfirm(false)}>取消</ReviewButton></div></div> : null}
    {downloadError ? <ErrorNotice message={downloadError} /> : null}
    <div className="cr-tabs" role="tablist" aria-label="报告视图">{tabs.map(([key, label, extra], index) => <button key={key} type="button" role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} aria-controls={`review-panel-${key}`} id={`review-tab-${key}`} onClick={() => update({ tab: key })} onKeyDown={event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (target !== null) { event.preventDefault(); update({ tab: tabs[target][0] }); document.getElementById(`review-tab-${tabs[target][0]}`)?.focus(); }
    }}>{label}{extra ? <small>{extra}</small> : null}</button>)}</div>
    <div className="cr-panel-fade" role="tabpanel" id={`review-panel-${tab}`} aria-labelledby={`review-tab-${tab}`}>
      {tab === 'findings' && loading && read ? <span role="status" className="sr-only">正在更新问题列表</span> : null}
      {tab === 'details' ? <div className="cr-stack"><ReviewDetail task={current} now={Date.now()} pending={pending} onAction={onAction} />{result ? <section className="cr-surface cr-progress-summary"><h2>覆盖与检查说明</h2>{result.notes.length ? result.notes.map((note, index) => <p key={index} className="cr-break cr-form-note">{note}</p>) : <p className="cr-form-note">原始结果未提供额外检查说明。</p>}</section> : null}</div> : null}
      {tab === 'original' || tab === 'findings' && imported ? documentView : null}
      {tab === 'findings' && !imported ? <div className="cr-stack">
        {error ? <div className="cr-row-inline"><ErrorNotice message={error} /><ReviewButton onClick={() => setAttempt(n => n + 1)}>重新读取问题</ReviewButton></div> : null}
        {!read && loading ? <ContentLoading label="正在读取问题明细" variant="panel" /> : !result ? showArchivedFallback ? <div className="cr-stack"><p className="cr-notice">{read?.resultUnavailableReason || '历史任务没有可读取的结构化明细'}。以下直接展示已归档正文，不能把缺失视为零问题。</p>{documentView}</div> : <div className="cr-stack"><p className="cr-form-note">{read?.resultUnavailableReason}</p>{read?.resultLoading ? <ContentLoading label="正在整理已有问题，不会重新执行审查" variant="inline" /> : <ReviewButton onClick={() => setAttempt(n => n + 1)}>重新读取问题</ReviewButton>}<ReviewButton onClick={() => update({ tab: 'details' })}>查看审查进度</ReviewButton></div>
          : <>
            <div className="cr-report-grid"><aside aria-label="问题列表" className="cr-surface cr-issue-nav cr-desktop"><div className="cr-issue-filters">{severitySelect}<label className="cr-search"><Search aria-hidden="true" /><span className="sr-only">搜索文件或问题</span><input className="cr-input" type="search" maxLength={300} placeholder="标题或文件" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
              <ul>{result.findings.map(item => <li key={item.index}><button type="button" className="cr-issue-item" aria-pressed={finding?.index === item.index} onClick={() => select(item.index)}><span className="cr-issue-top"><ReviewSeverity severity={item.severity} /><span className="cr-issue-file cr-mono" title={item.filePath}>{item.filePath.split('/').at(-1)}{item.line ? `:${item.line}` : ' · 无行号'}</span></span><span className="cr-issue-title">{findingTitle(item)}</span></button></li>)}</ul>
              {!result.findings.length ? <p className="cr-form-note p-4">{totalFindings ? '没有匹配的问题，请调整筛选。' : '已保存分析未返回发现，不代表代码不存在问题。'}</p> : null}
              <ReviewPagination offset={result.page.offset} limit={result.page.limit} total={result.page.total} disabled={loading} onOffset={changeOffset} noun="项问题" />
            </aside>
            <div className="cr-mobile cr-mobile-issue-select"><div className="cr-mobile-filter-row"><label><span className="sr-only">严重程度</span>{severitySelect}</label><details className="cr-mobile-search"><summary className="cr-button cr-icon-button" aria-label="搜索文件或问题"><Search /></summary><label className="cr-search-popover"><span className="sr-only">搜索文件或问题</span><input className="cr-input cr-full" type="search" maxLength={300} placeholder="标题或文件" value={query} onChange={e => setQuery(e.target.value)} /></label></details></div><label><span className="sr-only">选择问题</span><select aria-label="选择问题" className="cr-input cr-full" value={finding?.index ?? ''} onChange={e => select(Number(e.target.value))}>{result.findings.map(item => <option key={item.index} value={item.index}>{REVIEW_SEVERITY_LABELS[item.severity]} · {findingTitle(item)}</option>)}</select></label><div className="cr-issue-pager"><ReviewButton disabled={!previous || loading} onClick={() => move(-1)}>上一条</ReviewButton><span>{finding ? result.page.offset + position + 1 : 0} / {result.page.total}</span><ReviewButton disabled={!next || loading} onClick={() => move(1)}>下一条</ReviewButton></div></div>
            <div ref={detail} className="min-w-0">{loading ? <ContentLoading label="正在读取筛选结果" variant="inline" /> : null}{finding ? <FindingDetail finding={finding} task={current} position={result.page.offset + position + 1} total={result.page.total} previous={previous && !loading} next={next && !loading} onPrevious={() => move(-1)} onNext={() => move(1)} /> : <ReviewEmpty title={totalFindings ? '没有匹配的问题' : '已保存范围未返回发现'}>这不代表代码没有问题。请核对覆盖范围与原始检查说明。</ReviewEmpty>}</div>
          </div></>}
      </div> : null}
    </div>
  </section>;
}

export function FindingDetail({ finding, task, position, total, previous, next, onPrevious, onNext }: { finding: CodeReviewFinding; task?: CodeReviewTask; position?: number; total?: number; previous?: boolean; next?: boolean; onPrevious?: () => void; onNext?: () => void }): JSX.Element {
  const title = findingTitle(finding), rest = finding.message.startsWith(`${title}\n\n`) ? finding.message.slice(title.length).trimStart() : '';
  const explanation = finding.aiExplanation ? readableAiExplanation(finding.aiExplanation) : [];
  return <article aria-label="问题证据详情" className="cr-surface cr-finding"><header className="cr-finding-header"><div className="cr-row-inline cr-finding-position">{position && total ? <span>问题 {position} / {total}</span> : <span>工具发现 · 待验证</span>}{onPrevious && onNext ? <span className="cr-row-inline cr-end cr-desktop"><ReviewButton tone="ghost" className="cr-icon-button" aria-label="上一条问题" disabled={!previous} onClick={onPrevious}><ChevronUp /></ReviewButton><ReviewButton tone="ghost" className="cr-icon-button" aria-label="下一条问题" disabled={!next} onClick={onNext}><ChevronDown /></ReviewButton></span> : null}</div><h2>{title}</h2><div className="cr-source-meta cr-small"><ReviewSeverity severity={finding.severity} /><span className="cr-meta-item cr-muted">{REVIEW_CATEGORIES[finding.category]}</span><span className="cr-meta-item cr-muted"><Clock3 />待验证</span>{finding.id ? <span className="cr-meta-item cr-mono cr-muted">{finding.id}</span> : null}</div><p className="cr-mono cr-break">{finding.filePath}{finding.line ? `:${finding.line}${finding.endLine ? `–${finding.endLine}` : ''}` : ' · 行号未提供'}</p></header>
    <div className="cr-finding-body"><section><h3>问题原因</h3><p>{rest || finding.message}</p></section><section><h3>代码证据</h3>{finding.codeSnippet ? <pre className="cr-code"><code>{finding.codeSnippet}</code></pre> : <p className="cr-form-note">原始结果未提供代码片段，请结合文件位置核实。</p>}</section><section><h3>修复建议</h3><p>{finding.suggestion || '原始结果未提供修复建议，请结合业务语义核实。'}</p></section>
      {explanation.length ? <section><h3>模型解释</h3><dl className="cr-explanation">{explanation.map((part, index) => <div key={index}>{part.label ? <dt>{part.label}</dt> : null}<dd>{part.text}</dd></div>)}</dl></section> : null}
      <dl className="cr-facts cr-finding-footer"><dt>检查工具</dt><dd>{finding.tool || '未提供'}</dd><dt>验证状态</dt><dd>待验证（工具发现，尚未人工确认）；未做运行期验证。</dd>{task ? <><dt>所属任务</dt><dd className="cr-mono">{task.id}{task.commitSha ? ` · ${task.commitSha.slice(0, 8)}` : ''}</dd></> : null}</dl>
    </div>
  </article>;
}
