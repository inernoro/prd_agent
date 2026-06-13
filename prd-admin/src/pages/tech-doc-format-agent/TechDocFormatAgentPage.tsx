import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FileUp,
  FileText,
  Folder,
  Github,
  GitBranch,
  Link2,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { toast } from '@/lib/toast';
import { streamDirectChat } from '@/services/real/aiToolbox';
import {
  getTechDocGitHubAuthStatus,
  getTechDocGitHubContext,
  getTechDocGitHubTree,
  listTechDocGitHubRepositories,
  pollTechDocGitHubDeviceFlow,
  startTechDocGitHubDeviceFlow,
  type TechDocDeviceFlowStart,
  type TechDocGitHubAuthStatus,
  type TechDocGitHubContext,
  type TechDocGitHubRepository,
  type TechDocGitHubTreeItem,
} from '@/services/real/techDocFormatAgent';
import {
  buildPm2502Draft,
  buildTechDocGenerationPrompt,
  buildTechDocRepairPrompt,
  PM2502_TECH_DOC_TEMPLATE,
  validateTechDocContentQuality,
  validateTechDocFormat,
  type TechDocDraftInput,
  type TechDocIssue,
} from '@/lib/techDocFormat';

type ActiveTab = 'generate' | 'check' | 'template';
type RunPhase = 'idle' | 'streaming' | 'done' | 'error';

interface RequirementFile {
  name: string;
  content: string;
  size: number;
}

interface DeviceFlowState extends TechDocDeviceFlowStart {
  startedAt: number;
  status: 'polling' | 'expired' | 'denied' | 'failed';
  errorDetail?: string;
}

const DEFAULT_FORM: TechDocDraftInput = {
  projectName: '',
  appName: '',
  moduleName: '',
  featureName: '',
  requirementText: '',
  projectLinks: '',
  uiLink: '',
  showdocLink: '',
  testCaseLink: '',
};

function severityLabel(severity: TechDocIssue['severity']): string {
  if (severity === 'error') return '必须修复';
  if (severity === 'warning') return '建议修复';
  return '提示';
}

function stageText(seconds: number): string {
  if (seconds < 5) return '正在读取 PM2502 模板与用户输入';
  if (seconds < 20) return '正在按固定章节归档内容';
  if (seconds < 45) return '正在补齐接口、流程、影响范围与实施规划';
  return '内容较多，仍在生成并保持流式输出';
}

function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TechDocFormatAgentPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('generate');
  const [form, setForm] = useState<TechDocDraftInput>(DEFAULT_FORM);
  const [checkDoc, setCheckDoc] = useState('');
  const [checkFileName, setCheckFileName] = useState('');
  const [generatedDoc, setGeneratedDoc] = useState('');
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [modelInfo, setModelInfo] = useState<{ model?: string; platform?: string } | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requirementFileInputRef = useRef<HTMLInputElement>(null);
  const [requirementFiles, setRequirementFiles] = useState<RequirementFile[]>([]);
  const [githubAuth, setGithubAuth] = useState<TechDocGitHubAuthStatus | null>(null);
  const [githubAuthLoading, setGithubAuthLoading] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);
  const [repoQuery, setRepoQuery] = useState('');
  const [repos, setRepos] = useState<TechDocGitHubRepository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<TechDocGitHubRepository | null>(null);
  const [treeItems, setTreeItems] = useState<TechDocGitHubTreeItem[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [projectContext, setProjectContext] = useState<TechDocGitHubContext | null>(null);
  const [projectContextLoading, setProjectContextLoading] = useState(false);

  useEffect(() => {
    if (phase !== 'streaming') {
      setElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => setElapsedSec((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => {
      abortRef.current?.();
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  const loadGitHubAuthStatus = useCallback(async () => {
    setGithubAuthLoading(true);
    const res = await getTechDocGitHubAuthStatus();
    setGithubAuthLoading(false);
    if (res.success && res.data) {
      setGithubAuth(res.data);
      return;
    }
    toast.error('GitHub 连接状态加载失败', res.error?.message ?? '请稍后重试');
  }, []);

  useEffect(() => {
    void loadGitHubAuthStatus();
  }, [loadGitHubAuthStatus]);

  const loadRepositories = useCallback(async (query = repoQuery) => {
    if (!githubAuth?.connected) return;
    setReposLoading(true);
    const res = await listTechDocGitHubRepositories(query, 1, 30);
    setReposLoading(false);
    if (!res.success || !res.data) {
      toast.error('仓库列表加载失败', res.error?.message ?? '请确认 GitHub 授权仍有效');
      return;
    }
    setRepos(res.data.items);
  }, [githubAuth?.connected, repoQuery]);

  useEffect(() => {
    if (githubAuth?.connected) {
      void loadRepositories('');
    }
  }, [githubAuth?.connected, loadRepositories]);

  const loadTree = useCallback(async (repo: TechDocGitHubRepository, path = '') => {
    setTreeLoading(true);
    const res = await getTechDocGitHubTree(repo.owner, repo.repo, path, repo.defaultBranch ?? undefined);
    setTreeLoading(false);
    if (!res.success || !res.data) {
      toast.error('项目路径加载失败', res.error?.message ?? '请确认账号有仓库访问权限');
      return;
    }
    setTreeItems(res.data.items);
    setCurrentPath(res.data.path || '');
  }, []);

  const loadProjectContext = useCallback(async (repo: TechDocGitHubRepository, path = '') => {
    setProjectContextLoading(true);
    const res = await getTechDocGitHubContext(repo.owner, repo.repo, path, repo.defaultBranch ?? undefined);
    setProjectContextLoading(false);
    if (!res.success || !res.data) {
      toast.error('项目内容读取失败', res.error?.message ?? '请确认账号有仓库访问权限');
      return null;
    }
    setProjectContext(res.data);
    return res.data;
  }, []);

  const startGitHubConnect = useCallback(async () => {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    setDeviceFlow(null);
    const res = await startTechDocGitHubDeviceFlow();
    if (!res.success || !res.data) {
      toast.error('无法发起 GitHub 授权', res.error?.message ?? '请检查 OAuth 配置');
      return;
    }
    const flow: DeviceFlowState = {
      ...res.data,
      startedAt: Date.now(),
      status: 'polling',
    };
    setDeviceFlow(flow);
    window.open(res.data.verificationUriComplete, '_blank', 'noopener,noreferrer');
  }, []);

  useEffect(() => {
    if (!deviceFlow || deviceFlow.status !== 'polling') return;

    let cancelled = false;
    const poll = async () => {
      const res = await pollTechDocGitHubDeviceFlow(deviceFlow.flowToken);
      if (cancelled) return;
      if (!res.success || !res.data) {
        setDeviceFlow((prev) => prev ? { ...prev, status: 'failed', errorDetail: res.error?.message ?? '授权轮询失败' } : prev);
        return;
      }
      if (res.data.status === 'done') {
        setDeviceFlow(null);
        toast.success('GitHub 已连接');
        await loadGitHubAuthStatus();
        return;
      }
      if (res.data.status === 'expired' || res.data.status === 'denied') {
        setDeviceFlow((prev) => prev ? { ...prev, status: res.data.status === 'expired' ? 'expired' : 'denied' } : prev);
        return;
      }
      const interval = res.data.status === 'slow_down'
        ? deviceFlow.intervalSeconds + 5
        : deviceFlow.intervalSeconds;
      pollTimerRef.current = window.setTimeout(poll, Math.max(1, interval) * 1000);
    };

    pollTimerRef.current = window.setTimeout(poll, Math.max(1, deviceFlow.intervalSeconds) * 1000);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, [deviceFlow, loadGitHubAuthStatus]);

  const generatedValidation = useMemo(
    () => validateTechDocFormat(generatedDoc),
    [generatedDoc],
  );

  const checkValidation = useMemo(
    () => validateTechDocFormat(checkDoc),
    [checkDoc],
  );

  const selectedTreeSummary = useMemo(() => {
    if (!selectedRepo) return '';
    const dirs = treeItems.filter((item) => item.type === 'dir').slice(0, 30);
    const files = treeItems.filter((item) => item.type !== 'dir').slice(0, 30);
    return [
      dirs.length > 0 ? `目录：${dirs.map((item) => item.path).join('、')}` : '',
      files.length > 0 ? `文件：${files.map((item) => item.path).join('、')}` : '',
    ].filter(Boolean).join('\n');
  }, [selectedRepo, treeItems]);

  const generationInput = useMemo<TechDocDraftInput>(() => ({
    ...form,
    requirementFiles: requirementFiles.map((file) => ({
      name: file.name,
      content: file.content,
    })),
    githubProject: selectedRepo ? {
      fullName: selectedRepo.fullName,
      owner: selectedRepo.owner,
      repo: selectedRepo.repo,
      branch: selectedRepo.defaultBranch ?? undefined,
      path: selectedProjectPath || currentPath || '/',
      htmlUrl: selectedRepo.htmlUrl ?? undefined,
      treeSummary: selectedTreeSummary,
      files: (projectContext?.files ?? []).map((file) => ({
        path: file.path,
        content: file.content,
      })),
    } : undefined,
  }), [currentPath, form, projectContext?.files, requirementFiles, selectedProjectPath, selectedRepo, selectedTreeSummary]);

  const contentQualityValidation = useMemo(
    () => validateTechDocContentQuality(generatedDoc, generationInput),
    [generatedDoc, generationInput],
  );

  const generatedCombinedValidation = useMemo(() => {
    const issues = [...generatedValidation.issues, ...contentQualityValidation.issues];
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    const infoCount = issues.filter((issue) => issue.severity === 'info').length;
    return {
      passed: errorCount === 0,
      score: Math.min(generatedValidation.score, contentQualityValidation.score),
      issues,
      summary: { errorCount, warningCount, infoCount },
    };
  }, [contentQualityValidation, generatedValidation]);

  const canGenerate =
    form.requirementText.trim().length > 0
    || form.projectLinks.trim().length > 0
    || requirementFiles.length > 0
    || !!selectedRepo;

  const updateForm = useCallback((key: keyof TechDocDraftInput, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const copyText = useCallback(async (content: string, label: string) => {
    if (!content.trim()) {
      toast.warning('暂无可复制内容');
      return;
    }
    await navigator.clipboard.writeText(content);
    toast.success(`${label}已复制`);
  }, []);

  const handleBuildDraft = useCallback(() => {
    const draft = buildPm2502Draft(generationInput);
    setGeneratedDoc(draft);
    setPhase('done');
    setErrorMsg('');
    setModelInfo(null);
    setActiveTab('generate');
    toast.success('已生成 PM2502 底稿', '底稿仅用于起草，完整文档仍需通过内容质量校验');
  }, [generationInput]);

  const runPrompt = useCallback((prompt: string) => {
    abortRef.current?.();
    setGeneratedDoc('');
    setErrorMsg('');
    setModelInfo(null);
    setPhase('streaming');

    abortRef.current = streamDirectChat({
      message: prompt,
      onStart: (info) => {
        setModelInfo(info);
      },
      onText: (chunk) => {
        setGeneratedDoc((prev) => prev + chunk);
      },
      onError: (message) => {
        setPhase('error');
        setErrorMsg(message || '生成失败');
      },
      onDone: () => {
        setPhase('done');
        abortRef.current = null;
      },
    });
  }, []);

  const handleAiGenerate = useCallback(() => {
    if (!canGenerate) {
      toast.warning('请先填写功能说明、上传需求文件或选择 GitHub 项目');
      return;
    }
    runPrompt(buildTechDocGenerationPrompt(generationInput));
  }, [canGenerate, generationInput, runPrompt]);

  const handleRepair = useCallback(() => {
    if (!generatedDoc.trim()) {
      toast.warning('暂无可修复文档');
      return;
    }
    const issues = generatedCombinedValidation.issues.filter((issue) => issue.severity !== 'info');
    if (issues.length === 0) {
      toast.success('当前文档已通过格式与内容校验');
      return;
    }
    runPrompt(buildTechDocRepairPrompt(generatedDoc, issues));
  }, [generatedCombinedValidation.issues, generatedDoc, runPrompt]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setPhase('idle');
    toast.info('已停止生成');
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCheckFileName(file.name);
    setCheckDoc(text);
    setActiveTab('check');
    event.target.value = '';
  }, []);

  const handleRequirementFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    const next: RequirementFile[] = [];
    for (const file of files) {
      const text = await file.text();
      next.push({
        name: file.name,
        content: text.slice(0, 40_000),
        size: file.size,
      });
    }
    setRequirementFiles((prev) => [...prev, ...next].slice(0, 8));
    event.target.value = '';
    toast.success('需求文件已读取', `已加入 ${next.length} 个文件`);
  }, []);

  const removeRequirementFile = useCallback((name: string) => {
    setRequirementFiles((prev) => prev.filter((file) => file.name !== name));
  }, []);

  const handleSelectRepo = useCallback((repo: TechDocGitHubRepository) => {
    setSelectedRepo(repo);
    setSelectedProjectPath('');
    setProjectContext(null);
    setCurrentPath('');
    setTreeItems([]);
    updateForm('projectLinks', repo.htmlUrl ?? repo.fullName);
    void loadTree(repo, '');
  }, [loadTree, updateForm]);

  const handleOpenTreePath = useCallback((item: TechDocGitHubTreeItem) => {
    if (!selectedRepo || item.type !== 'dir') return;
    void loadTree(selectedRepo, item.path);
  }, [loadTree, selectedRepo]);

  const handleSelectCurrentPath = useCallback(async () => {
    if (!selectedRepo) return;
    const path = currentPath || '/';
    const context = await loadProjectContext(selectedRepo, currentPath);
    if (!context) return;
    setSelectedProjectPath(path);
    toast.success('已读取项目上下文', `读取 ${context.files.length} 个关键文件`);
  }, [currentPath, loadProjectContext, selectedRepo]);

  const inputClass =
    'w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] outline-none focus:border-indigo-400/50';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 p-5">
      <header className="shrink-0 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-indigo-400/20 bg-indigo-500/10 p-3">
            <FileText size={24} className="text-indigo-200" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[color:var(--text-primary)]">技术分析文档格式校验 Agent</h1>
            <p className="mt-1 max-w-3xl text-sm text-[color:var(--text-secondary)]">
              根据功能说明、上传需求文件和 GitHub 项目路径生成 PM2502 技术分析文档，也可检查已有文档格式。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeTab === 'generate' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('generate')}
          >
            <Wand2 size={14} />
            生成文档
          </Button>
          <Button
            variant={activeTab === 'check' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('check')}
          >
            <ShieldCheck size={14} />
            检查文档
          </Button>
          <Button
            variant={activeTab === 'template' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('template')}
          >
            <FileText size={14} />
            模板真源
          </Button>
        </div>
      </header>

      {activeTab === 'generate' && (
        <div className="min-h-0 flex-1 grid gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <GlassCard className="min-h-0 flex flex-col gap-4 p-4" overflow="hidden">
            <div className="shrink-0">
              <h2 className="text-base font-semibold text-[color:var(--text-primary)]">输入功能与项目资料</h2>
              <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                信息不足时会按模板补“待定/不涉及”，不会删除 PM2502 固定栏目。
              </p>
            </div>
            <div
              className="min-h-0 flex-1 space-y-3 pr-1"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  项目名称
                  <input className={inputClass} value={form.projectName} onChange={(e) => updateForm('projectName', e.target.value)} placeholder="例如 PM2603 技术分析" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  应用
                  <input className={inputClass} value={form.appName} onChange={(e) => updateForm('appName', e.target.value)} placeholder="例如 米多总后台" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  模块
                  <input className={inputClass} value={form.moduleName} onChange={(e) => updateForm('moduleName', e.target.value)} placeholder="例如 百宝箱" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  功能
                  <input className={inputClass} value={form.featureName} onChange={(e) => updateForm('featureName', e.target.value)} placeholder="例如 技术分析文档校验" />
                </label>
              </div>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                方案/项目链接
                <textarea
                  className={`${inputClass} min-h-[72px] resize-y`}
                  value={form.projectLinks}
                  onChange={(e) => updateForm('projectLinks', e.target.value)}
                  placeholder="粘贴功能、项目、代码仓库、需求文档等链接"
                />
              </label>

              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[color:var(--text-primary)]">
                      <FileUp size={14} />
                      上传需求文件
                    </div>
                    <p className="mt-1 text-[11px] text-[color:var(--text-secondary)]">
                      支持 .md/.txt 等文本文件，内容会作为需求上下文参与生成。
                    </p>
                  </div>
                  <input
                    ref={requirementFileInputRef}
                    type="file"
                    multiple
                    accept=".md,.markdown,.txt,text/markdown,text/plain"
                    className="hidden"
                    onChange={handleRequirementFiles}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => requirementFileInputRef.current?.click()}
                  >
                    <Upload size={14} />
                    上传
                  </Button>
                </div>
                {requirementFiles.length > 0 ? (
                  <div className="space-y-2">
                    {requirementFiles.map((file) => (
                      <div key={file.name} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                        <FileText size={13} className="shrink-0 text-indigo-200" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-[color:var(--text-primary)]">{file.name}</div>
                          <div className="text-[10px] text-[color:var(--text-secondary)]">{Math.ceil(file.size / 1024)} KB</div>
                        </div>
                        <button
                          type="button"
                          className="rounded p-1 text-[color:var(--text-secondary)] hover:bg-white/10 hover:text-[color:var(--text-primary)]"
                          onClick={() => removeRequirementFile(file.name)}
                          aria-label={`移除 ${file.name}`}
                        >
                          <XCircle size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-[color:var(--text-secondary)]">
                    还没有上传需求文件
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[color:var(--text-primary)]">
                      <Github size={14} />
                      GitHub 项目路径
                    </div>
                    <p className="mt-1 text-[11px] text-[color:var(--text-secondary)]">
                      连接账号后选择仓库和目录，生成时会带入项目路径与目录摘要。
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    onClick={loadGitHubAuthStatus}
                    disabled={githubAuthLoading}
                  >
                    {githubAuthLoading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
                    刷新
                  </Button>
                </div>

                {!githubAuth?.oauthConfigured && !githubAuthLoading && (
                  <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                    管理员尚未配置 GitHub OAuth Device Flow，暂不能选择仓库。
                  </div>
                )}

                {githubAuth?.oauthConfigured && !githubAuth.connected && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-[color:var(--text-secondary)]">
                      当前未连接 GitHub。连接后可读取你有权限访问的仓库列表。
                    </div>
                    <Button variant="primary" size="sm" onClick={startGitHubConnect}>
                      <Github size={14} />
                      连接 GitHub
                    </Button>
                  </div>
                )}

                {deviceFlow && (
                  <div className="mt-3 rounded-lg border border-indigo-400/20 bg-indigo-500/10 p-3 text-xs text-indigo-100">
                    <div className="flex items-center justify-between gap-2">
                      <span>授权码：<span className="font-mono font-semibold">{deviceFlow.userCode}</span></span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1"
                        onClick={() => window.open(deviceFlow.verificationUriComplete, '_blank', 'noopener,noreferrer')}
                      >
                        <Link2 size={12} />
                        打开授权页
                      </button>
                    </div>
                    <div className="mt-2">
                      {deviceFlow.status === 'polling' && '等待 GitHub 授权完成，本页会自动检测。'}
                      {deviceFlow.status === 'expired' && '授权已超时，请重新连接。'}
                      {deviceFlow.status === 'denied' && '你在 GitHub 页面拒绝了授权。'}
                      {deviceFlow.status === 'failed' && `授权失败：${deviceFlow.errorDetail ?? '未知错误'}`}
                    </div>
                  </div>
                )}

                {githubAuth?.connected && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                      {githubAuth.avatarUrl ? (
                        <img src={githubAuth.avatarUrl} alt={githubAuth.login} className="h-5 w-5 rounded-full" />
                      ) : (
                        <Github size={14} />
                      )}
                      已连接 {githubAuth.login}
                    </div>

                    <div className="flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[color:var(--text-secondary)]" />
                        <input
                          className={`${inputClass} pl-7`}
                          value={repoQuery}
                          onChange={(e) => setRepoQuery(e.target.value)}
                          placeholder="搜索仓库"
                        />
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => loadRepositories(repoQuery)} disabled={reposLoading}>
                        {reposLoading ? <MapSpinner size={14} /> : <Search size={14} />}
                        搜索
                      </Button>
                    </div>

                    <div className="max-h-[180px] space-y-2 overflow-y-auto pr-1">
                      {repos.map((repo) => (
                        <button
                          key={repo.id}
                          type="button"
                          className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                            selectedRepo?.id === repo.id
                              ? 'border-indigo-400/40 bg-indigo-500/10'
                              : 'border-white/10 bg-black/20 hover:bg-white/[0.05]'
                          }`}
                          onClick={() => handleSelectRepo(repo)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-semibold text-[color:var(--text-primary)]">{repo.fullName}</span>
                            <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[color:var(--text-secondary)]">
                              {repo.isPrivate ? '私有' : '公开'}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-[color:var(--text-secondary)]">
                            <GitBranch size={11} />
                            {repo.defaultBranch || '默认分支'}
                          </div>
                        </button>
                      ))}
                      {repos.length === 0 && !reposLoading && (
                        <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-[color:var(--text-secondary)]">
                          暂无仓库，连接后点击搜索刷新
                        </div>
                      )}
                    </div>

                    {selectedRepo && (
                      <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                          <button
                            type="button"
                            className="min-w-0 truncate text-left text-indigo-100"
                            onClick={() => void loadTree(selectedRepo, '')}
                          >
                            {selectedRepo.fullName}
                          </button>
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={handleSelectCurrentPath}
                            disabled={projectContextLoading}
                          >
                            {projectContextLoading ? <MapSpinner size={12} /> : null}
                            读取并选中
                          </Button>
                        </div>
                        <div className="mb-2 flex items-center gap-1 text-[10px] text-[color:var(--text-secondary)]">
                          <Folder size={11} />
                          /{currentPath}
                          {selectedProjectPath && (
                            <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-100">
                              已选 /{selectedProjectPath === '/' ? '' : selectedProjectPath}
                            </span>
                          )}
                        </div>
                        {projectContext && selectedProjectPath && (
                          <div className="mb-2 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2 py-1.5 text-[10px] text-emerald-100">
                            已读取 {projectContext.files.length} 个关键项目文件：
                            {projectContext.files.slice(0, 3).map((file) => file.path).join('、')}
                            {projectContext.files.length > 3 ? ' 等' : ''}
                          </div>
                        )}
                        <div className="max-h-[160px] space-y-1 overflow-y-auto pr-1">
                          {treeLoading && (
                            <div className="flex items-center gap-2 px-2 py-3 text-xs text-[color:var(--text-secondary)]">
                              <MapSpinner size={14} />
                              加载目录中
                            </div>
                          )}
                          {!treeLoading && currentPath && (
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[color:var(--text-secondary)] hover:bg-white/10"
                              onClick={() => {
                                const parent = currentPath.split('/').slice(0, -1).join('/');
                                void loadTree(selectedRepo, parent);
                              }}
                            >
                              <Folder size={13} />
                              返回上级
                            </button>
                          )}
                          {!treeLoading && treeItems.map((item) => (
                            <button
                              key={item.path}
                              type="button"
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[color:var(--text-secondary)] hover:bg-white/10 disabled:opacity-50"
                              onClick={() => handleOpenTreePath(item)}
                              disabled={item.type !== 'dir'}
                            >
                              {item.type === 'dir' ? <Folder size={13} /> : <FileText size={13} />}
                              <span className="min-w-0 flex-1 truncate">{item.name}</span>
                              {item.type === 'dir' && <ChevronRight size={12} />}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  UI 设计图
                  <input className={inputClass} value={form.uiLink} onChange={(e) => updateForm('uiLink', e.target.value)} placeholder="可选" />
                </label>
                <label className="space-y-1 text-xs text-[color:var(--text-secondary)]">
                  Showdoc 地址
                  <input className={inputClass} value={form.showdocLink} onChange={(e) => updateForm('showdocLink', e.target.value)} placeholder="可选" />
                </label>
              </div>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                测试用例
                <input className={inputClass} value={form.testCaseLink} onChange={(e) => updateForm('testCaseLink', e.target.value)} placeholder="可选" />
              </label>

              <label className="block space-y-1 text-xs text-[color:var(--text-secondary)]">
                功能与需求说明
                <textarea
                  className={`${inputClass} min-h-[180px] resize-y`}
                  value={form.requirementText}
                  onChange={(e) => updateForm('requirementText', e.target.value)}
                  placeholder="描述要分析的功能、输入输出、接口、前端交互、排期约束等"
                />
              </label>
            </div>
            <div className="shrink-0 flex flex-wrap gap-2 border-t border-white/10 pt-3">
              <Button variant="secondary" size="sm" onClick={handleBuildDraft}>
                <FileText size={14} />
                生成底稿
              </Button>
              <Button variant="primary" size="sm" onClick={handleAiGenerate} disabled={phase === 'streaming'}>
                {phase === 'streaming' ? <MapSpinner size={14} /> : <Wand2 size={14} />}
                AI 生成并校验
              </Button>
              {phase === 'streaming' && (
                <Button variant="danger" size="sm" onClick={handleStop}>
                  停止
                </Button>
              )}
            </div>
          </GlassCard>

          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">输出文档与自动校验</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  生成完成后会用同一套 PM2502 校验器检查，未通过可一键修复。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => copyText(generatedDoc, '生成文档')}>
                  <Copy size={14} />
                  复制
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => downloadMarkdown(generatedDoc, 'pm2502-tech-analysis.md')}
                  disabled={!generatedDoc.trim()}
                >
                  <Download size={14} />
                  下载
                </Button>
                <Button variant="secondary" size="sm" onClick={handleRepair} disabled={!generatedDoc.trim() || phase === 'streaming'}>
                  <RefreshCw size={14} />
                  修复格式
                </Button>
              </div>
            </div>

            <div className="shrink-0 mt-3 flex flex-wrap items-center gap-2 text-xs">
              {phase === 'streaming' && (
                <span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/20 bg-indigo-500/10 px-3 py-1 text-indigo-100">
                  <MapSpinner size={12} />
                  {stageText(elapsedSec)}，已等待 {elapsedSec} 秒
                </span>
              )}
              {modelInfo?.model && (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[color:var(--text-secondary)]">
                  模型：{modelInfo.model}{modelInfo.platform ? ` / ${modelInfo.platform}` : ''}
                </span>
              )}
              {phase === 'error' && (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-400/20 bg-red-500/10 px-3 py-1 text-red-200">
                  <XCircle size={12} />
                  {errorMsg}
                </span>
              )}
              {generatedDoc.trim() && phase !== 'streaming' && (
                <ValidationBadge result={generatedCombinedValidation} />
              )}
            </div>

            <div
              className="mt-3 min-h-0 flex-1 rounded-xl border border-white/10 bg-black/20 p-3"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
            >
              {generatedDoc ? (
                <StreamingText
                  text={generatedDoc}
                  streaming={phase === 'streaming'}
                  mode="blur"
                  className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[color:var(--text-primary)]"
                />
              ) : (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center text-[color:var(--text-secondary)]">
                  <FileText size={36} className="mb-3 opacity-60" />
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">等待生成 PM2502 技术分析文档</p>
                  <p className="mt-1 max-w-md text-xs">先填写左侧信息，可生成本地底稿，也可调用 AI 生成完整技术分析文档。</p>
                </div>
              )}
            </div>

            {generatedDoc.trim() && phase !== 'streaming' && (
              <IssueList issues={generatedCombinedValidation.issues} />
            )}
          </GlassCard>
        </div>
      )}

      {activeTab === 'check' && (
        <div className="min-h-0 flex-1 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">上传或粘贴技术分析文档</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                  支持 Markdown 或纯文本文件，检查按 PM2502 模板严格执行。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} />
                  上传文档
                </Button>
                <Button variant="secondary" size="sm" onClick={() => copyText(checkDoc, '待检查文档')}>
                  <Copy size={14} />
                  复制
                </Button>
              </div>
            </div>
            {checkFileName && (
              <div className="shrink-0 mt-3 text-xs text-[color:var(--text-secondary)]">当前文件：{checkFileName}</div>
            )}
            <textarea
              className="mt-3 min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-relaxed text-[color:var(--text-primary)] outline-none focus:border-indigo-400/50"
              style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
              value={checkDoc}
              onChange={(e) => setCheckDoc(e.target.value)}
              placeholder="粘贴技术分析文档 Markdown 正文，或点击上传文档"
            />
          </GlassCard>

          <GlassCard className="min-h-0 flex flex-col p-4" overflow="hidden">
            <div className="shrink-0 flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <h2 className="text-base font-semibold text-[color:var(--text-primary)]">检查结果</h2>
                <p className="mt-1 text-xs text-[color:var(--text-secondary)]">错误为交付阻断项，建议项用于模板细节对齐。</p>
              </div>
              <ValidationBadge result={checkValidation} />
            </div>
            <div className="shrink-0 mt-4 grid grid-cols-3 gap-2 text-center">
              <MetricCard label="得分" value={`${checkValidation.score}`} />
              <MetricCard label="错误" value={`${checkValidation.summary.errorCount}`} tone="error" />
              <MetricCard label="建议" value={`${checkValidation.summary.warningCount}`} tone="warning" />
            </div>
            <IssueList issues={checkValidation.issues} compact />
          </GlassCard>
        </div>
      )}

      {activeTab === 'template' && (
        <GlassCard className="min-h-0 flex-1 flex flex-col p-4" overflow="hidden">
          <div className="shrink-0 flex flex-col gap-2 border-b border-white/10 pb-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-[color:var(--text-primary)]">PM2502 模板真源</h2>
              <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                生成和检查均以这份模板为格式真源，除非用户显式指定其他模板。
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => copyText(PM2502_TECH_DOC_TEMPLATE, 'PM2502 模板')}>
                <Copy size={14} />
                复制模板
              </Button>
              <Button variant="secondary" size="sm" onClick={() => downloadMarkdown(PM2502_TECH_DOC_TEMPLATE, 'xxx技术分析PM2502.md')}>
                <Download size={14} />
                下载模板
              </Button>
            </div>
          </div>
          <pre
            className="mt-3 min-h-0 flex-1 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-relaxed text-[color:var(--text-primary)]"
            style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {PM2502_TECH_DOC_TEMPLATE}
          </pre>
        </GlassCard>
      )}
    </div>
  );
}

function ValidationBadge({ result }: { result: ReturnType<typeof validateTechDocFormat> }) {
  if (result.passed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
        <CheckCircle2 size={12} />
        已通过
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-100">
      <AlertTriangle size={12} />
      待修复
    </span>
  );
}

function MetricCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'error' | 'warning';
}) {
  const toneClass =
    tone === 'error'
      ? 'text-red-200'
      : tone === 'warning'
        ? 'text-amber-100'
        : 'text-[color:var(--text-primary)]';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-[color:var(--text-secondary)]">{label}</div>
    </div>
  );
}

function IssueList({ issues, compact = false }: { issues: TechDocIssue[]; compact?: boolean }) {
  const visibleIssues = compact ? issues : issues.slice(0, 8);

  if (issues.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
        未发现 PM2502 格式阻断项。
      </div>
    );
  }

  return (
    <div
      className="mt-3 min-h-0 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3"
      style={compact ? { overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}
    >
      {visibleIssues.map((issue) => (
        <div key={issue.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
          <div className="flex items-start gap-2">
            {issue.severity === 'error' ? (
              <XCircle size={14} className="mt-0.5 shrink-0 text-red-300" />
            ) : (
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-200" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-[color:var(--text-primary)]">{issue.title}</span>
                <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-[color:var(--text-secondary)]">
                  {severityLabel(issue.severity)}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)]">{issue.detail}</p>
              <p className="mt-1 text-xs leading-relaxed text-indigo-100">修复建议：{issue.fix}</p>
            </div>
          </div>
        </div>
      ))}
      {!compact && issues.length > visibleIssues.length && (
        <div className="text-center text-xs text-[color:var(--text-secondary)]">
          还有 {issues.length - visibleIssues.length} 条问题，可到“检查文档”页查看完整列表。
        </div>
      )}
    </div>
  );
}
