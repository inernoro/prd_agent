import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { apiRequest } from '@/lib/api';
import { downloadCodeReviewReport, readCodeReview, REVIEW_CATEGORIES, REVIEW_SEVERITIES, REVIEW_SEVERITY_LABELS,
  type CodeReviewRead, type CodeReviewTask, type CodeReviewFinding } from '@/lib/codeReviews';
import { reviewCoverage } from '@/lib/codeReviewView';
import { ErrorNotice, ReviewDetail } from './ReviewTaskDetails';
import { ReportDocument } from './ReportDocument';

type ReportPayload = { report: { title: string; format: 'html' | 'md' }; content: string };
type ReaderTab = 'findings' | 'original' | 'details';
const inputClass = 'h-9 w-full rounded-md border border-input bg-[hsl(var(--surface-sunken))] px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';
const severityClass = (severity: string): string => severity === 'critical' || severity === 'high'
  ? 'bg-[hsl(var(--bad-soft))] text-[hsl(var(--bad))]' : severity === 'medium' ? 'bg-warn-soft text-warn' : 'bg-muted text-muted-foreground';
const findingTitle = (finding: CodeReviewFinding): string => finding.title || finding.message.split('\n').find(line => line.trim()) || '未提供标题';

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

export function ReviewReportReader({ task, projectName, onBack, onAction, pending }: { task: CodeReviewTask; projectName: string; onBack: () => void;
  onAction: (action: 'cancel' | 'retry' | 'delivery/retry') => void; pending: boolean }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const imported = task.sourceType === 'report';
  const [tab, setTab] = useState<ReaderTab>(imported || task.reportId || task.progress.scannedFiles > 0 ? 'findings' : 'details');
  const [read, setRead] = useState<CodeReviewRead | null>(null);
  const [original, setOriginal] = useState<ReportPayload | null>(null);
  const [error, setError] = useState('');
  const [originalError, setOriginalError] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloadUrls] = useState(() => new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const url of downloadUrls) URL.revokeObjectURL(url); }; }, [downloadUrls]);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(query); setOffset(0); }, 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    if (!read?.resultLoading) return;
    const timer = window.setTimeout(() => setAttempt(n => n + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [read]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void readCodeReview(task.id, { offset, severity, query: search }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setRead(value); })
      .catch(() => { if (!controller.signal.aborted) setError('问题明细暂时无法读取，请重新加载；原始报告仍可单独查看。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [task.id, task.updatedAt, offset, severity, search, attempt]);
  useEffect(() => {
    const firstTabDocument = tab === 'findings' && (imported || Boolean(read && !read.result && !read.resultLoading));
    if ((tab !== 'original' && !firstTabDocument) || original || !task.reportId) return;
    const controller = new AbortController(); setOriginalError('');
    void apiRequest<ReportPayload>(`/api/code-reviews/${encodeURIComponent(task.id)}/report`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setOriginal(value); })
      .catch(() => { if (!controller.signal.aborted) setOriginalError('原始报告暂时无法读取，请重新加载。'); });
    return () => controller.abort();
  }, [task.id, task.reportId, tab, original, attempt, imported, read]);
  const result = read?.result;
  const current = read?.task || task;
  const selection = Number(params.get('issue'));
  const finding = result?.findings.find(item => item.index === selection) || result?.findings[0];
  const totalFindings = result ? Object.values(result.summary).reduce((sum, n) => sum + n, 0) : undefined;
  const tabs: Array<[ReaderTab, string]> = imported ? [['findings', '报告内容'], ['details', '文档信息']]
    : [['findings', `问题${totalFindings === undefined ? '' : ` ${totalFindings}`}`], ['original', '原始报告'], ['details', '审查详情']];
  const select = (index: number): void => setParams(current => { const next = new URLSearchParams(current); next.set('issue', String(index)); return next; });
  const coverage = reviewCoverage(current);
  const download = async (): Promise<void> => {
    if (downloading) return;
    setDownloading(true); setDownloadError('');
    try {
      const blob = await downloadCodeReviewReport(task.id);
      if (!alive.current) return;
      const url = URL.createObjectURL(blob); downloadUrls.add(url);
      const a = document.createElement('a'); a.href = url; a.download = `code-review-${task.id}.${blob.type.includes('html') ? 'html' : 'md'}`;
      document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    } catch { if (alive.current) setDownloadError('报告下载未完成，请重试。'); }
    finally { if (alive.current) setDownloading(false); }
  };
  const documentView = original ? <ReportDocument {...original.report} content={original.content} />
    : originalError ? <div className="space-y-3"><ErrorNotice message={originalError} /><Button variant="outline" onClick={() => setAttempt(n => n + 1)}>重新加载报告</Button></div>
      : task.reportId ? <ContentLoading label="正在读取报告内容" variant="panel" /> : <p className="py-8 text-base text-muted-foreground">报告尚未归档，请在审查详情中查看进度。</p>;
  return <section aria-label="代码审查报告阅读器" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="outline" onClick={onBack}><ArrowLeft />返回列表</Button>
      <Button variant="outline" disabled={(!task.reportId && !result) || downloading} onClick={() => { void download(); }}><Download />{downloading ? '正在下载' : task.reportId ? '下载报告' : '下载当前结果'}</Button></div>
    <header className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h1 className="min-w-0 max-w-full break-words text-[1.75rem] font-semibold tracking-tight">{task.title === '代码审查报告' ? task.sourceName : task.title}</h1>
      {coverage.kind === 'partial' || current.status === 'failed' ? <span className="rounded bg-warn-soft px-3 py-1 text-sm text-warn">阶段结果 · 未完成</span> : null}</div>
      <p className="break-all text-sm text-muted-foreground">{projectName}{current.branchName ? ` · ${current.branchName}` : ''} · {current.commitSha ? `固定提交 ${current.commitSha.slice(0, 12)}` : current.sourceHash ? `ZIP 快照 ${current.sourceHash.slice(0, 12)}` : current.sourceName}</p>
      <p role="status" className={`px-3 py-2 text-base ${coverage.kind === 'partial' || coverage.kind === 'unknown' || current.status === 'failed' ? 'bg-warn-soft text-warn' : 'bg-muted/40 text-muted-foreground'}`}>
        {coverage.text}{task.sourceType !== 'report' ? '。发现仅代表已分析范围，均未做运行期验证。' : ''}</p>
    </header>
    {downloadError ? <ErrorNotice message={downloadError} /> : null}
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border" role="tablist" aria-label="报告视图">
      <div className="flex gap-3">{tabs.map(([key, label], index) =>
        <button key={key} type="button" role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} aria-controls={`review-panel-${key}`} id={`review-tab-${key}`} onClick={() => setTab(key)}
          onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null; if (next !== null) { event.preventDefault(); setTab(tabs[next][0]); window.document.getElementById(`review-tab-${tabs[next][0]}`)?.focus(); } }}
          className={`border-b px-3 py-3 text-base ${tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{label}</button>)}</div>
      <span className="pb-2 text-sm text-muted-foreground">{task.sourceType === 'report' ? '原文件保存' : '静态与 AI 分析 · 发现待验证'}</span>
    </div>
    <div role="tabpanel" id={`review-panel-${tab}`} aria-labelledby={`review-tab-${tab}`}>
      {tab === 'details' ? <div className="space-y-4"><ReviewDetail task={current} now={Date.now()} pending={pending} onAction={onAction} />
        {result ? <div className="space-y-2 text-base"><h2 className="font-medium">覆盖与检查说明</h2>{result.notes.map((note, index) => <p key={index} className="break-words text-muted-foreground">{note}</p>)}</div> : null}</div> : null}
      {tab === 'original' ? documentView : null}
      {tab === 'findings' ? imported ? documentView : error ? <div className="space-y-3"><ErrorNotice message={error} /><Button variant="outline" onClick={() => setAttempt(n => n + 1)}>重新加载问题</Button></div>
        : read && !result && !read.resultLoading && task.reportId ? <div className="space-y-4"><p className="rounded-md bg-warn-soft px-4 py-3 text-base leading-6 text-warn">{read.resultUnavailableReason || '历史任务未保存可读取的问题明细'}。以下展示已归档的报告正文，问题数量与证据以原文为准。</p>{documentView}</div>
        : !read ? <ContentLoading label="正在读取问题明细" variant="panel" /> : !result ? <div className="space-y-4 py-6"><p className="text-base text-muted-foreground">{read.resultUnavailableReason}</p>
          {read.resultLoading ? <ContentLoading label="正在整理已有问题，不会重新执行审查" variant="inline" /> : task.sourceType !== 'report' ? <Button variant="outline" onClick={() => setAttempt(n => n + 1)}>重新读取问题</Button> : null}
          <Button variant="outline" onClick={() => setTab(task.reportId ? 'original' : 'details')}>{task.reportId ? '阅读原始报告' : '查看审查进度'}</Button></div>
        : <div className="space-y-4"><p className="text-base text-muted-foreground">{totalFindings} 项待验证发现{REVIEW_SEVERITIES.filter(key => result.summary[key]).map(key => ` · ${REVIEW_SEVERITY_LABELS[key]} ${result.summary[key]}`).join('')}</p>
          <div className="grid items-start gap-6 lg:grid-cols-[24rem_minmax(0,1fr)]">
            <aside aria-label="问题列表" className="min-w-0 space-y-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="问题严重程度">{['', ...REVIEW_SEVERITIES].filter(key => !key || result.summary[key as keyof typeof result.summary]).map(key =>
                <button key={key} type="button" aria-pressed={severity === key} onClick={() => { setSeverity(key); setOffset(0); }} className={`rounded px-2 py-1 text-sm ${severity === key ? 'bg-[hsl(var(--primary-soft))] text-primary' : 'bg-muted text-muted-foreground'}`}>{key ? REVIEW_SEVERITY_LABELS[key as keyof typeof REVIEW_SEVERITY_LABELS] : '全部'}</button>)}</div>
              <label className="relative block"><Search aria-hidden="true" className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><span className="sr-only">搜索文件或问题</span><input type="search" className={`${inputClass} pl-9`} placeholder="搜索文件或问题" value={query} onChange={e => setQuery(e.target.value)} /></label>
              {loading ? <ContentLoading label="正在筛选问题" variant="inline" /> : null}
              <select aria-label="选择问题" className={`${inputClass} lg:hidden`} value={finding?.index ?? ''} onChange={e => select(Number(e.target.value))}>{result.findings.map(item => <option key={item.index} value={item.index}>{item.index + 1}. {findingTitle(item)}</option>)}</select>
              <ul className="hidden max-h-[65vh] space-y-3 overflow-y-auto lg:block">{result.findings.map(item => <li key={item.index}><button type="button" aria-pressed={finding?.index === item.index} onClick={() => select(item.index)}
                className={`w-full min-w-0 space-y-2 border p-4 text-left ${finding?.index === item.index ? 'border-primary bg-[hsl(var(--primary-soft))]' : 'border-border bg-card hover:bg-muted/40'}`}>
                <span className="line-clamp-2 block text-base font-medium">{findingTitle(item)}</span><span className="block truncate font-mono text-sm text-muted-foreground">{item.filePath}{item.line ? `:${item.line}` : ''}</span>
                <span className={`inline-block rounded px-2 py-0.5 text-sm ${severityClass(item.severity)}`}>{REVIEW_SEVERITY_LABELS[item.severity]}</span></button></li>)}</ul>
              {!result.findings.length ? <p className="py-4 text-base text-muted-foreground">{totalFindings ? '没有匹配的问题，请调整筛选。' : '本次已保存的分析未返回发现；这不代表代码不存在问题。'}</p> : null}
              <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground"><span>{result.page.total} 项匹配</span><div className="flex gap-1"><Button variant="ghost" aria-label="上一页问题" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - result.page.limit))}><ChevronLeft /></Button><Button variant="ghost" aria-label="下一页问题" disabled={result.page.nextOffset === null || loading} onClick={() => setOffset(result.page.nextOffset!)}><ChevronRight /></Button></div></div>
            </aside>
            {finding ? <FindingDetail finding={finding} /> : null}
          </div></div> : null}
    </div>
  </section>;
}

export function FindingDetail({ finding }: { finding: CodeReviewFinding }): JSX.Element {
  const title = findingTitle(finding);
  const rest = finding.message.startsWith(`${title}\n\n`) ? finding.message.slice(title.length).trimStart() : '';
  const explanation = finding.aiExplanation ? readableAiExplanation(finding.aiExplanation) : [];
  return <article aria-label="问题证据详情" className="min-w-0 space-y-5 rounded-lg border border-border bg-card p-5 lg:p-6">
    <div className="flex flex-wrap gap-2 text-sm"><span className={`rounded px-3 py-1 ${severityClass(finding.severity)}`}>{REVIEW_SEVERITY_LABELS[finding.severity]}</span><span className="rounded bg-muted px-3 py-1 text-muted-foreground">{REVIEW_CATEGORIES[finding.category]} · 待验证</span></div>
    <h2 className="break-words text-2xl font-semibold">{title}</h2>
    <p className="break-all font-mono text-sm text-muted-foreground">{finding.filePath}{finding.line ? `:${finding.line}${finding.endLine ? `–${finding.endLine}` : ''}` : ''}</p>
    <section className="space-y-2"><h3 className="text-base font-medium">问题原因</h3><p className="whitespace-pre-wrap break-words text-base leading-7">{rest || finding.message}</p></section>
    {finding.codeSnippet ? <section className="space-y-2"><h3 className="text-base font-medium">代码证据</h3><pre className="max-w-full overflow-x-auto rounded-md bg-[hsl(var(--code-bg))] p-4 font-mono text-sm leading-6 text-[hsl(var(--code-fg))]"><code>{finding.codeSnippet}</code></pre></section> : null}
    <section className="space-y-2"><h3 className="text-base font-medium">修复建议</h3><p className="whitespace-pre-wrap break-words text-base leading-7">{finding.suggestion || '原始结果未提供修复建议，请结合业务语义核实。'}</p></section>
    {explanation.length ? <section className="space-y-3"><h3 className="text-base font-medium">AI 解释</h3><dl className="space-y-3">{explanation.map((part, index) => <div key={index} className="space-y-1">
      {part.label ? <dt className="text-sm font-medium">{part.label}</dt> : null}<dd className="whitespace-pre-wrap break-words text-base leading-7 text-muted-foreground">{part.text}</dd>
    </div>)}</dl></section> : null}
    <p className="border-t border-border pt-3 text-sm leading-5 text-muted-foreground">来源：{finding.tool} · 未做运行期验证。原始发现与验证结论分开保留。</p>
  </article>;
}
