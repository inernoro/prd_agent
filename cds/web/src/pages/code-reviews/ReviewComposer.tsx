import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronRight, FileArchive, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { listCodeReviewBranches, submitCodeReview, uploadCodeReviewReport, type CodeReviewBranch, type CodeReviewTask } from '@/lib/codeReviews';
import { ErrorNotice } from './ReviewTaskDetails';
import { ReportDocument } from './ReportDocument';

export interface ReviewProjectOption { id: string; name: string; aliasName?: string }
export interface ReviewCapabilities { engineConfigured: boolean; mailConfigured: boolean; storageConfigured?: boolean; tools?: string[] }
const inputClass = 'h-9 w-full rounded-md border border-input bg-[hsl(var(--surface-sunken))] px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function ReviewComposer({ mode, projects, projectId: initialProject, capabilities, onBack, onSaved }: {
  mode: 'source' | 'import'; projects: ReviewProjectOption[]; projectId: string; capabilities: ReviewCapabilities | null;
  onBack: () => void; onSaved: (task: CodeReviewTask) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(initialProject || projects[0]?.id || '');
  const [source, setSource] = useState<'zip' | 'github'>('zip');
  const [origin, setOrigin] = useState<'upload' | 'cds'>('upload');
  const [branches, setBranches] = useState<CodeReviewBranch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');
  const [branchAttempt, setBranchAttempt] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [github, setGithub] = useState('');
  const [ref, setRef] = useState('');
  const [exclude, setExclude] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileId = useId();
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setBranches([]); setBranchId(''); setBranchesError('');
    if (mode !== 'source' || origin !== 'cds' || !projectId) return;
    const controller = new AbortController(); setBranchesLoading(true);
    void listCodeReviewBranches(projectId, controller.signal)
      .then(value => { if (!controller.signal.aborted) setBranches(value); })
      .catch(() => { if (!controller.signal.aborted) setBranchesError('无法读取项目分支，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setBranchesLoading(false); });
    return () => controller.abort();
  }, [mode, origin, projectId, branchAttempt]);
  useEffect(() => {
    let cancelled = false;
    setPreview(''); setPreviewError('');
    if (mode === 'import' && file) void file.text().then(content => { if (!cancelled) setPreview(content); })
      .catch(() => { if (!cancelled) setPreviewError('无法读取该文件，请重新选择。'); });
    return () => { cancelled = true; };
  }, [file, mode]);
  const selectFile = (next: File | undefined): void => {
    setError('');
    if (!next) { setFile(null); return; }
    const limit = mode === 'import' ? 10 : 100;
    if (!next.size || next.size > limit * 1024 * 1024 || !(mode === 'import' ? /\.(md|markdown|html|htm)$/i : /\.zip$/i).test(next.name)) {
      setError(mode === 'import' ? '请选择 10 MiB 以内的 HTML 或 Markdown 文件。' : '请选择 100 MiB 以内的 ZIP 文件。');
      setFile(null); if (input.current) input.current.value = ''; return;
    }
    setFile(next);
    if (mode === 'import' && !title) setTitle(next.name.replace(/\.[^.]+$/, ''));
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (busy) return; setError('');
    if (!ready) { setError('请选择项目并提供源码、分支或报告文件。'); return; }
    if (mode === 'source' && !confirm) { setConfirm(true); return; }
    setBusy(true);
    try {
      const task = mode === 'import' ? await uploadCodeReviewReport(projectId, title.trim(), file!)
        : await submitCodeReview({ projectId, sourceType: origin === 'cds' ? 'cds' : source,
          ...(origin === 'cds' ? { branchId } : source === 'zip' ? { file: file! } : { githubUrl: github.trim(), ref: ref.trim() }),
          excludePatterns: exclude.split('\n').map(v => v.trim()).filter(Boolean), email: sendEmail ? email.trim() : undefined });
      if (alive.current) onSaved(task);
    } catch { if (alive.current) setError(mode === 'import' ? '报告未能保存，请检查项目权限和文件后重试。' : '任务未能提交，请检查审查服务和源码访问权限后重试。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const ready = Boolean(projectId && (mode === 'import' ? file && title.trim() : origin === 'cds' ? !branchesLoading && branches.some(b => b.id === branchId) : source === 'zip' ? file : github.trim()));
  const serviceConfigured = Boolean(capabilities?.engineConfigured && capabilities.storageConfigured !== false);
  return <section className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h1 className="text-[1.75rem] font-semibold tracking-tight">{mode === 'import' ? '导入已有审查报告' : confirm ? '确认本次审查' : '发起代码审查'}</h1>
      <p className="text-base text-muted-foreground">{mode === 'import' ? '原样保存 HTML 或 Markdown。导入报告不会启动源码审查。' : '选择源码，确认后开始。报告自动保存到当前项目。'}</p></div>
      <Button variant="outline" disabled={busy} onClick={onBack}><ArrowLeft />返回列表</Button></header>
    <form onSubmit={event => { void submit(event); }} aria-busy={busy} className={mode === 'import' ? 'grid min-w-0 items-start gap-8 lg:grid-cols-[25rem_minmax(0,1fr)]' : 'max-w-[59rem] space-y-5'}>
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        {error ? <ErrorNotice message={error} /> : null}
        {confirm ? <>
          <dl className="space-y-4 rounded-lg border border-border bg-card p-5 text-base">
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">项目</dt><dd>{projects.find(p => p.id === projectId)?.aliasName || projects.find(p => p.id === projectId)?.name}</dd></div>
            <div className="space-y-1"><dt className="text-muted-foreground">源码</dt><dd className="break-all">{origin === 'cds' ? `CDS 项目分支 · ${branches.find(b => b.id === branchId)?.branch}` : source === 'zip' ? file?.name : github}</dd></div>
            <div className="space-y-1"><dt className="text-muted-foreground">版本与范围</dt><dd>{origin === 'cds' ? '开始准备时同步并固定所选分支的提交，以报告中的 SHA 为准' : source === 'github' ? ref || '仓库默认分支；提交后记录实际提交版本' : '提交后按 ZIP 哈希固定快照'}。依赖目录、构建产物与不支持的文件按规则排除，实际覆盖以报告为准。</dd></div>
            {exclude ? <div><dt className="text-muted-foreground">额外排除</dt><dd className="whitespace-pre-wrap break-words">{exclude}</dd></div> : null}
            <div><dt className="text-muted-foreground">报告接收</dt><dd className="break-all">报告中心{sendEmail ? ` + ${email}` : ''}</dd></div>
          </dl>
          <p className="rounded-md bg-warn-soft px-4 py-3 text-base leading-6 text-warn">当前无法提供可靠的费用预估。确认开始后将按实际模型用量计费。</p>
          {!serviceConfigured ? <p role="status" className="text-base text-muted-foreground">审查服务尚未就绪，请管理员恢复服务后再提交。</p> : null}
          <div className="flex flex-wrap justify-between gap-3"><Button type="button" variant="outline" onClick={() => setConfirm(false)}>返回修改</Button><Button type="submit" disabled={busy || !serviceConfigured}>{busy ? '正在提交' : '确认并开始审查'}</Button></div>
        </> : <>
          {mode === 'source' ? <div role="tablist" aria-label="源码来源" className="flex gap-3 border-b border-border">{(['upload', 'cds'] as const).map((value, index) => <button key={value} id={`source-tab-${value}`} aria-controls="source-panel" type="button" role="tab" tabIndex={origin === value ? 0 : -1} aria-selected={origin === value} onClick={() => { setOrigin(value); setError(''); }} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'upload' : e.key === 'End' ? 'cds' : index === 0 ? 'cds' : 'upload'; setOrigin(next); document.getElementById(`source-tab-${next}`)?.focus(); } }} className={`border-b px-4 py-3 text-base ${origin === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>{value === 'upload' ? '上传源码' : 'CDS 项目'}</button>)}</div> : null}
          <div id="source-panel" role={mode === 'source' ? 'tabpanel' : undefined} aria-labelledby={mode === 'source' ? `source-tab-${origin}` : undefined} className="space-y-5">
          <label className="block space-y-2 text-base"><span>{origin === 'cds' && mode === 'source' ? 'CDS 项目' : '归属项目'} <span aria-hidden="true">*</span></span><select aria-label="归属项目" required className={inputClass} value={projectId} onChange={e => { setProjectId(e.target.value); setBranchId(''); }}><option value="">请选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.aliasName || p.name}</option>)}</select></label>
          {mode === 'import' ? <label className="block space-y-2 text-base"><span>报告标题 *</span><input className={inputClass} required value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label> : origin === 'upload' ? <div className="flex gap-2" role="group" aria-label="源码提交方式">{(['zip', 'github'] as const).map(value => <button key={value} type="button" aria-pressed={source === value} onClick={() => { setSource(value); setError(''); }} className={`rounded-md border px-3 py-2 text-base ${source === value ? 'border-primary bg-[hsl(var(--primary-soft))] text-primary' : 'border-border text-muted-foreground'}`}>{value === 'zip' ? '上传 ZIP' : 'GitHub 地址'}</button>)}</div> : null}
          {mode === 'source' && origin === 'cds' ? <div className="space-y-3">
            <label className="block space-y-2 text-base"><span>审查分支 *</span><select aria-label="审查分支" required className={inputClass} value={branchId} disabled={branchesLoading || !branches.length} onChange={e => setBranchId(e.target.value)}><option value="">{branchesLoading ? '正在读取分支' : '请选择要审查的分支'}</option>{branches.map(b => <option key={b.id} value={b.id}>{b.branch}</option>)}</select></label>
            {branchesError ? <div className="space-y-2"><ErrorNotice message={branchesError} /><Button type="button" variant="outline" onClick={() => setBranchAttempt(n => n + 1)}>重新读取分支</Button></div> : !branchesLoading && projectId && !branches.length ? <p className="text-base text-muted-foreground">该项目暂无可选分支。可先在项目中添加分支，或切换到上传源码。</p> : null}
            <p className="text-sm leading-6 text-muted-foreground">使用 CDS 已连接的仓库，无需上传文件。审查开始时同步所选分支并记录提交 SHA，不运行项目脚本。</p>
          </div> : mode === 'import' || source === 'zip' ? <div className="space-y-2">
            <label htmlFor={fileId} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) selectFile(e.dataTransfer.files[0]); }} className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed border-input px-5 py-8 text-center hover:bg-muted/30 focus-within:ring-2 focus-within:ring-ring">
              {file ? <FileArchive className="size-7 text-muted-foreground" aria-hidden="true" /> : <Upload className="size-7 text-muted-foreground" aria-hidden="true" />}
              <span className="max-w-full break-all text-base font-medium">{file ? file.name : mode === 'import' ? '拖放报告文件，或点击选择文件' : '拖放 ZIP 文件，或点击选择文件'}</span>
              <span className="text-sm text-muted-foreground">{file ? `${(file.size / 1024).toFixed(1)} KiB · 点击重新选择` : mode === 'import' ? 'HTML / Markdown，最大 10 MiB' : '仅支持 ZIP，最大 100 MiB'}</span>
              <input ref={input} id={fileId} type="file" className="sr-only" aria-label={mode === 'import' ? '报告文件' : '源码 ZIP 压缩包'} accept={mode === 'import' ? '.html,.htm,.md,.markdown' : '.zip,application/zip'} onChange={e => selectFile(e.target.files?.[0])} />
            </label>
          </div> : <div className="space-y-4"><label className="block space-y-2 text-base"><span>GitHub 仓库地址 *</span><input type="url" required className={inputClass} value={github} onChange={e => setGithub(e.target.value)} placeholder="https://github.com/owner/repository" /></label>
            <label className="block space-y-2 text-base"><span>分支、标签或提交（可选）</span><input className={inputClass} value={ref} onChange={e => setRef(e.target.value)} placeholder="留空使用默认分支" /></label>
            <p className="text-sm leading-5 text-muted-foreground">支持公开及已授权私有仓库。没有仓库权限时可改用 ZIP。</p></div>}
          </div>
          {mode === 'source' ? <details className="py-1"><summary className="cursor-pointer text-base text-primary">更多选项 <span className="ml-4 text-sm text-muted-foreground">排除目录 · 邮件通知</span></summary>
            <div className="space-y-4 pt-4"><label className="block space-y-2 text-base"><span>排除目录或模式（每行一项）</span><textarea className={`${inputClass} h-auto min-h-24 py-2`} rows={3} value={exclude} onChange={e => setExclude(e.target.value)} placeholder={'vendor/\nthirdparty/'} /></label>
              <label className="flex items-center gap-2 text-base"><input type="checkbox" checked={sendEmail} disabled={!capabilities?.mailConfigured} onChange={e => setSendEmail(e.target.checked)} />同时发送至邮箱</label>
              {!capabilities?.mailConfigured ? <p className="text-sm text-muted-foreground">邮件服务尚未启用，报告仍会保存在报告中心。</p> : null}
              {sendEmail ? <label className="block space-y-2 text-base"><span>收件邮箱</span><input type="email" required className={inputClass} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label> : null}
            </div></details> : <p className="text-base text-muted-foreground">文件原样保存，不调用模型，不产生模型调用费。</p>}
          <p className="text-sm leading-5 text-muted-foreground">报告将保存至 CDS《代码审查报告》。{mode === 'source' && !ready ? origin === 'cds' ? '请选择项目和审查分支。' : '请先选择 ZIP 文件或填写 GitHub 地址。' : ''}</p>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2"><Button variant="outline" type="button" disabled={busy} onClick={onBack}>取消</Button><Button type="submit" disabled={!ready || busy || Boolean(previewError)}>{mode === 'import' ? '保存报告' : '下一步：确认审查'}{mode === 'source' ? <ChevronRight /> : null}</Button></div>
        </>}
        {busy ? <ContentLoading label={mode === 'import' ? '正在保存原始报告' : '正在上传并创建任务'} variant="inline" /> : null}
      </fieldset>
      {mode === 'import' ? <section aria-label="原文件预览" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"><h2 className="border-b border-border px-5 py-3 text-base font-medium">原文件预览</h2>
        {previewError ? <div className="p-5"><ErrorNotice message={previewError} /></div> : preview ? <ReportDocument content={preview} format={/\.(md|markdown)$/i.test(file?.name || '') ? 'md' : 'html'} title="待上传报告原文" /> : <p className="p-8 text-base text-muted-foreground">选择文件后在这里预览原始内容。</p>}</section> : null}
    </form>
  </section>;
}
