import { ReviewUserKeyOptions, type UserKeyOptions } from './ReviewUserKeyOptions';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ChevronRight, FileArchive, FileText, Upload, X } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { listCodeReviewBranches, submitCodeReview, uploadCodeReviewReport, type CodeReviewBranch, type CodeReviewTask } from '@/lib/codeReviews';
import { ErrorNotice } from './ReviewTaskDetails';
import { ReportDocument } from './ReportDocument';
import { ReviewBack, ReviewButton } from './ReviewUi';

export interface ReviewProjectOption { id: string; name: string; aliasName?: string; githubRepoFullName?: string; branchCount?: number }
export interface ReviewCapabilities { engineConfigured: boolean; userKeyConfigured?: boolean; mailConfigured: boolean; storageConfigured?: boolean; tools?: string[] }

export function ReviewComposer({ mode, projects, projectId: initialProject, capabilities, onBack, onSaved }: {
  mode: 'source' | 'import'; projects: ReviewProjectOption[]; projectId: string; capabilities: ReviewCapabilities | null;
  onBack: () => void; onSaved: (task: CodeReviewTask) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(initialProject || '');
  const [origin, setOrigin] = useState<'upload' | 'cds'>('cds'), [source, setSource] = useState<'zip' | 'github'>('zip');
  const [branches, setBranches] = useState<CodeReviewBranch[]>([]), [branchId, setBranchId] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false), [branchesError, setBranchesError] = useState(''), [branchAttempt, setBranchAttempt] = useState(0);
  const [branchesLoadedFor, setBranchesLoadedFor] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [file, setFile] = useState<File | null>(null), [github, setGithub] = useState(''), [ref, setRef] = useState('');
  const [exclude, setExclude] = useState(''), [sendEmail, setSendEmail] = useState(false), [email, setEmail] = useState('');
  const [userKey, setUserKey] = useState<UserKeyOptions | null>(null);
  const [title, setTitle] = useState(''), [preview, setPreview] = useState(''), [previewError, setPreviewError] = useState('');
  const [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const fileId = useId(), projectRadio = useId(), input = useRef<HTMLInputElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setBranchesError('');
    if (mode !== 'source' || origin !== 'cds' || !projectId) { setBranchesLoading(false); return; }
    const controller = new AbortController(); setBranches([]); setBranchesLoading(true);
    void listCodeReviewBranches(projectId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setBranches(value); setBranchesLoadedFor(projectId); setBranchId(previous => value.some(branch => branch.id === previous) ? previous : ''); }
    }).catch(() => { if (!controller.signal.aborted) setBranchesError('分支读取失败，或当前账号没有权限。请重试或使用上传源码。'); })
      .finally(() => { if (!controller.signal.aborted) setBranchesLoading(false); });
    return () => controller.abort();
  }, [mode, origin, projectId, branchAttempt]);
  useEffect(() => {
    let cancelled = false; setPreview(''); setPreviewError('');
    if (mode === 'import' && file) void file.text().then(content => { if (!cancelled) setPreview(content); }).catch(() => { if (!cancelled) setPreviewError('文件读取失败，请重新选择文件。'); });
    return () => { cancelled = true; };
  }, [file, mode]);
  const chooseProject = (id: string): void => { setProjectId(id); setBranchId(''); setBranches([]); setError(''); };
  const selectFile = (next: File | undefined): void => {
    setError(''); if (!next) { setFile(null); return; }
    const limit = mode === 'import' ? 10 : 100;
    if (!next.size || next.size > limit * 1024 * 1024 || !(mode === 'import' ? /\.(md|markdown|html|htm)$/i : /\.zip$/i).test(next.name)) {
      setError(mode === 'import' ? '请选择 10 MiB 以内的 HTML 或 Markdown 文件。' : '请选择 100 MiB 以内的 ZIP 文件。'); setFile(null); if (input.current) input.current.value = ''; return;
    }
    setFile(next); if (mode === 'import' && !title) setTitle(next.name.replace(/\.[^.]+$/, ''));
  };
  const withEmail = sendEmail && capabilities?.mailConfigured;
  const canSubmit = Boolean(projectId && (mode === 'import' ? file && title.trim() && !previewError : origin === 'cds' ? !branchesLoading && branches.some(branch => branch.id === branchId) : source === 'zip' ? file : github.trim()));
  const serviceConfigured = Boolean(capabilities?.engineConfigured && capabilities.storageConfigured !== false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (busy) return; setError('');
    if (!canSubmit) { setError('请选择项目并提供源码、分支或报告文件。'); return; }
    if (mode === 'source' && userKey && (!userKey.apiKey.trim() || !userKey.model.trim() || !Number.isSafeInteger(userKey.tokenLimit) || userKey.tokenLimit! < 4096)) { setError('请填写有效的用户 Key、模型和 Token 额度。'); return; }
    if (mode === 'source' && !confirm) { setConfirm(true); mainScrollTop(); return; }
    setBusy(true);
    try {
      const task = mode === 'import' ? await uploadCodeReviewReport(projectId, title.trim(), file!) : await submitCodeReview({ projectId, sourceType: origin === 'cds' ? 'cds' : source,
        ...(origin === 'cds' ? { branchId } : source === 'zip' ? { file: file! } : { githubUrl: github.trim(), ref: ref.trim() }),
        userKey: userKey || undefined, excludePatterns: exclude.split('\n').map(pattern => pattern.trim()).filter(Boolean), email: withEmail ? email.trim() : undefined });
      if (alive.current) { setUserKey(null); onSaved(task); }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : mode === 'import' ? '文档未能保存，请重试。' : '任务未能提交，请检查源码权限和审查服务。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const selectedProject = projects.find(project => project.id === projectId);
  const fileFormat = /\.(md|markdown)$/i.test(file?.name || '') ? 'md' : 'html';
  const fileInput = <input ref={input} id={fileId} type="file" className="sr-only" aria-label={mode === 'import' ? '报告文件' : '源码 ZIP 压缩包'} accept={mode === 'import' ? '.html,.htm,.md,.markdown' : '.zip,application/zip'} onChange={e => selectFile(e.target.files?.[0])} />;
  const fileChooser = <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) selectFile(e.dataTransfer.files[0]); }}>
    {file ? <div className="cr-file-row">{mode === 'import' ? <FileText /> : <FileArchive />}<div><strong>{file.name}</strong><small>{mode === 'import' ? `${fileFormat === 'md' ? 'Markdown' : 'HTML'} · ` : 'ZIP · '}{(file.size / 1024).toFixed(1)} KiB</small></div><ReviewButton tone="ghost" type="button" onClick={() => input.current?.click()}>更换</ReviewButton><ReviewButton tone="ghost" type="button" className="cr-icon-button" aria-label="移除已选文件" onClick={() => { setFile(null); if (input.current) input.current.value = ''; }}><X /></ReviewButton></div>
      : <label htmlFor={fileId} className="cr-drop"><Upload aria-hidden="true" /><span>{mode === 'import' ? '拖放 HTML / Markdown，或选择文件' : '拖放 ZIP，或选择文件'}<span className="cr-row-sub">{mode === 'import' ? '最大 10 MiB，原文保留' : '仅支持 ZIP，最大 100 MiB'}</span></span></label>}{fileInput}</div>;
  const projectSelect = <label className="cr-label"><span>项目</span><select className="cr-input cr-full" aria-label="归属项目" value={projectId} required onChange={e => chooseProject(e.target.value)}><option value="">请选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.aliasName || project.name}</option>)}</select></label>;
  return <section className="cr-stack"><ReviewBack onBack={onBack} /><header className="cr-page-header"><div className="cr-page-title"><h1>{mode === 'import' ? '导入已有报告' : '发起审查'}</h1>{mode === 'source' ? <div className="cr-step-hint"><span>{confirm ? '1 选择来源' : <strong>1 选择来源</strong>}</span><ChevronRight className="size-3" /><span>{confirm ? <strong>2 确认</strong> : '2 确认'}</span></div> : null}</div></header>
    {mode === 'import' ? <p className="cr-subtitle">保存已有的 HTML 或 Markdown 文档，不启动源码审查。右侧预览即保存后的正文。</p> : null}
    <form onSubmit={event => { void submit(event); }} aria-busy={busy} className={mode === 'import' ? 'cr-import-grid' : 'cr-form-layout'}>
      <div className={mode === 'import' ? 'cr-import-controls' : 'cr-form-main'}><fieldset disabled={busy}>
        {error ? <ErrorNotice message={error} /> : null}
        {confirm ? <>
          <dl className="cr-surface cr-confirm-list"><div><dt>项目</dt><dd>{selectedProject?.aliasName || selectedProject?.name || projectId}</dd></div><div><dt>来源</dt><dd>{origin === 'cds' ? `平台项目 · ${branches.find(branch => branch.id === branchId)?.branch}` : source === 'zip' ? file?.name : github}</dd></div><div><dt>版本固定</dt><dd>{origin === 'cds' ? '开始准备时同步并固定所选分支的提交，以报告中的 SHA 为准；不包含未提交修改。' : source === 'github' ? `${ref || '仓库默认分支'}；准备时记录实际提交 SHA。` : '提交后按 ZIP 哈希固定快照。'}</dd></div><div><dt>分析范围</dt><dd>按本次支持的源码规则分析，依赖和构建产物排除；实际范围、跳过与未执行项以结果为准。</dd></div>{exclude ? <div><dt>额外排除</dt><dd className="whitespace-pre-wrap">{exclude}</dd></div> : null}<div><dt>报告接收</dt><dd>报告中心{withEmail ? ` + ${email}` : ''}</dd></div></dl>
          <p className="cr-notice cr-notice-warning">{userKey ? `本次使用自己的 ${userKey.provider} Key，模型 ${userKey.model}，保护额度 ${userKey.tokenLimit?.toLocaleString()} Token。失败时停止，不使用平台额度。费用以供应商账单为准。` : '当前无法提供可靠费用预估。确认开始后将按实际模型用量计费。'}</p>
          {!serviceConfigured ? <p role="status" className="cr-form-note">审查服务尚未就绪，请管理员恢复后再提交；已有报告仍可阅读和导入。</p> : null}
          <div className="cr-form-footer"><ReviewButton tone="primary" type="submit" disabled={!serviceConfigured || busy}>{busy ? '正在提交' : '确认并开始审查'}</ReviewButton><ReviewButton tone="ghost" type="button" onClick={() => setConfirm(false)}>返回修改</ReviewButton></div>
        </> : mode === 'import' ? <>
          {projectSelect}<label className="cr-label"><span>标题</span><input className="cr-input cr-full" aria-label="报告标题" required value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label><div className="cr-label"><span>文件</span>{fileChooser}</div>
          <p className="cr-form-note">保存时保留原文标题、表格、代码块与内联样式；上传脚本与外部资源不会执行或加载。导入文档不会生成“问题”列表。</p>
          <div className="cr-form-footer"><ReviewButton tone="primary" type="submit" disabled={!canSubmit || busy || Boolean(file && !preview)}>{busy ? '正在保存' : '保存文档'}</ReviewButton><ReviewButton tone="ghost" type="button" onClick={onBack}>取消</ReviewButton></div>
        </> : <>
          <div role="tablist" aria-label="源码来源" className="cr-tabs">{(['upload', 'cds'] as const).map((value, index) => <button key={value} id={`source-tab-${value}`} aria-controls="source-panel" type="button" role="tab" tabIndex={origin === value ? 0 : -1} aria-selected={origin === value} onClick={() => { setOrigin(value); setError(''); }} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'upload' : e.key === 'End' ? 'cds' : index === 0 ? 'cds' : 'upload'; setOrigin(next); document.getElementById(`source-tab-${next}`)?.focus(); } }}>{value === 'upload' ? '上传源码' : '平台项目'}</button>)}</div>
          <div id="source-panel" role="tabpanel" aria-labelledby={`source-tab-${origin}`} className="cr-stack">
            {origin === 'cds' ? <>
              <fieldset className="cr-stack"><legend className="cr-label mb-2">项目</legend>{projects.length > 6 ? <input className="cr-input cr-full" aria-label="搜索项目" placeholder="搜索项目" value={projectSearch} onChange={e => setProjectSearch(e.target.value)} /> : null}<div className="cr-project-options">{projects.filter(project => `${project.aliasName || ''} ${project.name}`.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())).map(project => <label className="cr-project-choice" key={project.id}><input type="radio" name={projectRadio} value={project.id} checked={projectId === project.id} onChange={() => chooseProject(project.id)} /><span><strong>{project.aliasName || project.name}</strong><small className="cr-mono">{project.githubRepoFullName ? `github.com/${project.githubRepoFullName}` : '已连接的项目仓库'}</small></span><em>{project.id === branchesLoadedFor && project.id === projectId && !branchesLoading && !branchesError ? `${branches.length} 个已登记分支` : project.branchCount === undefined ? '选择后读取分支' : project.branchCount ? `${project.branchCount} 个已登记分支` : '无已登记分支'}</em></label>)}</div>{!projects.length ? <p className="cr-placeholder">暂无可选项目。请等待项目加载完成，或检查当前账号的项目权限。</p> : null}</fieldset>
              <div className="cr-label"><span>分支</span>{!projectId ? <p className="cr-placeholder">先选择项目，再选择该项目已登记的分支。</p> : branchesLoading ? <ContentLoading label="正在读取已登记分支" variant="inline" /> : branchesError ? <div className="cr-stack"><ErrorNotice message={branchesError} /><ReviewButton type="button" onClick={() => setBranchAttempt(n => n + 1)}>重新读取分支</ReviewButton></div> : branches.length ? <select className="cr-input cr-full" aria-label="审查分支" required value={branchId} onChange={e => setBranchId(e.target.value)}><option value="">请选择分支</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.branch}</option>)}</select> : <p className="cr-placeholder">该项目没有已登记分支。可先在项目中添加分支，或切换到上传源码。</p>}
                <p className="cr-form-note">开始准备时同步并固定所选分支的提交，以报告中的 SHA 为准；不包含未提交修改。无需重新上传源码。</p></div>
            </> : <>
              {projectSelect}<div className="cr-segment" role="group" aria-label="源码提交方式">{(['zip', 'github'] as const).map(value => <button type="button" key={value} aria-pressed={source === value} onClick={() => setSource(value)}>{value === 'zip' ? 'ZIP 文件' : 'GitHub 地址'}</button>)}</div>
              {source === 'zip' ? fileChooser : <><label className="cr-label"><span>GitHub 仓库地址</span><input className="cr-input cr-full" type="url" required value={github} onChange={e => setGithub(e.target.value)} placeholder="https://github.com/owner/repository" /></label><label className="cr-label"><span>分支、标签或提交（可选）</span><input className="cr-input cr-full" value={ref} onChange={e => setRef(e.target.value)} placeholder="留空使用仓库默认分支" maxLength={250} /></label><p className="cr-form-note">私有仓库需要已有授权；未授权时可改用 ZIP。版本会在准备源码时固定并记录。</p></>}
            </>}
          </div>
          <details className="cr-more"><summary>更多选项<span>模型 Key · 排除目录 · 邮件通知</span></summary><div><ReviewUserKeyOptions value={userKey} onChange={setUserKey} configured={Boolean(capabilities?.userKeyConfigured)} /><label className="cr-label"><span>排除目录或模式（每行一项）</span><textarea className="cr-input cr-full" rows={3} value={exclude} onChange={e => setExclude(e.target.value)} placeholder={'vendor/\nthirdparty/'} /></label><label className="cr-check-row"><input type="checkbox" checked={Boolean(withEmail)} disabled={!capabilities?.mailConfigured} onChange={e => setSendEmail(e.target.checked)} />同时发送至邮箱</label>{!capabilities?.mailConfigured ? <p className="cr-form-note">邮件服务不可用，仅归档报告中心。报告仍可正常阅读。</p> : null}{withEmail ? <label className="cr-label"><span>收件邮箱</span><input type="email" className="cr-input cr-full" value={email} onChange={e => setEmail(e.target.value)} required /></label> : null}</div></details>
          <div className="cr-form-footer"><ReviewButton tone="primary" type="submit" disabled={!canSubmit || busy}>下一步：确认</ReviewButton><ReviewButton tone="ghost" type="button" onClick={onBack}>取消</ReviewButton>{!canSubmit ? <span className="cr-form-note">{!projectId ? '请选择项目' : origin === 'cds' ? '请选择分支' : source === 'zip' ? '请选择 ZIP 文件' : '请填写仓库地址'}</span> : null}</div>
        </>}
        {busy ? <ContentLoading label={mode === 'import' ? '正在保存原始文档' : '正在上传并创建任务'} variant="inline" /> : null}
      </fieldset></div>
      {mode === 'import' ? <section aria-label="原文件预览" className="cr-document"><header className="cr-preview-header"><strong>预览</strong><span className="cr-muted">{file ? `${fileFormat === 'md' ? 'Markdown' : 'HTML'} · 按原样式呈现` : '选择文件后预览'}</span></header>{previewError ? <div className="p-4"><ErrorNotice message={previewError} /></div> : preview ? <ReportDocument content={preview} format={fileFormat} title="待上传报告原文" /> : <p className="cr-empty">{file ? '正在读取文件内容…' : '选择文件后在这里预览。保存后的正文与此预览一致。'}</p>}</section> : <aside className="cr-surface cr-help"><h2>提交前须知</h2><p>“平台项目”直接使用工作台已连接的仓库，不需要重复上传。</p><p>点击“确认并开始审查”之前不会创建任务；之后可在进度页取消。</p><p>阅读和刷新结果不会触发重新扫描。</p><p>也可以从 MCP 客户端提交同样的任务，<a href="/code-reviews?view=mcp" target="_blank" rel="noopener noreferrer" aria-label="在新标签页查看接入方式">查看接入方式</a>。</p></aside>}
    </form>
  </section>;
}
function mainScrollTop(): void { document.querySelector<HTMLElement>('.cds-main')?.scrollTo({ top: 0 }); }
