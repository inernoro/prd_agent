import { useState, useRef, useEffect, useCallback } from 'react';
import { Route, Upload, FileText, X, AlertCircle, Settings2, Sparkles, GitBranch, FolderTree, Loader2, Github, ExternalLink } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  createPlan,
  listMyPlans,
  getActiveSiteSpec,
  upsertSiteSpec,
  getAnalyzeStreamUrl,
  getProjectRouteGitHubStatus,
  type ProjectRoutePlan,
  type ProjectRouteSiteSpec,
  type ProjectRouteExtractedRepo,
  type ProjectRouteResolution,
  type ProjectRouteGitHubStatus,
} from '@/services/real/projectRouteAgent';
import { useSseStream } from '@/lib/useSseStream';

type Tab = 'analyze' | 'admin';

interface RepoLiveStatus {
  appName: string;
  repoUrl: string;
  branch: string;
  status: 'cloning' | 'ok' | 'missing' | 'error';
  message?: string | null;
  files?: string[];
  fileCount?: number;
}

export function ProjectRouteAgentPage() {
  const perms = useAuthStore((s) => s.permissions); const isRoot = useAuthStore((s) => s.isRoot);
  const canManage = isRoot || perms.includes('project-route-agent.manage') || perms.includes('super');

  const [tab, setTab] = useState<Tab>('analyze');

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 border-b border-white/10 bg-white/3 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center">
            <Route className="w-5 h-5 text-sky-400" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold text-white">项目路由智能体</h1>
            <p className="text-xs text-white/50 mt-0.5">
              上传方案 md，AI 自动识别涉及的应用 / 业务模块，对照公共站点说明定位仓库 routemap 中的项目路径。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 mt-4">
          <TabButton active={tab === 'analyze'} onClick={() => setTab('analyze')}>
            分析方案
          </TabButton>
          {canManage && (
            <TabButton active={tab === 'admin'} onClick={() => setTab('admin')}>
              <span className="inline-flex items-center gap-1.5">
                <Settings2 className="w-3.5 h-3.5" />
                公共站点说明
              </span>
            </TabButton>
          )}
        </div>
      </header>

      <div className="flex-1" style={{ minHeight: 0, overflowY: 'auto' }}>
        {tab === 'analyze' ? <AnalyzeView /> : <AdminView />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-md text-sm transition-colors ${
        active
          ? 'bg-sky-500/15 text-sky-200 border border-sky-500/30'
          : 'text-white/50 hover:text-white/80 hover:bg-white/5 border border-transparent'
      }`}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// 普通用户视图：上传方案 + 流式分析
// ─────────────────────────────────────────────────────────

function AnalyzeView() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [siteSpec, setSiteSpec] = useState<ProjectRouteSiteSpec | null>(null);
  const [siteSpecLoading, setSiteSpecLoading] = useState(true);

  const [ghStatus, setGhStatus] = useState<ProjectRouteGitHubStatus | null>(null);

  const [plan, setPlan] = useState<ProjectRoutePlan | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [extractedRepos, setExtractedRepos] = useState<ProjectRouteExtractedRepo[]>([]);
  const [repos, setRepos] = useState<RepoLiveStatus[]>([]);
  const [resolutions, setResolutions] = useState<ProjectRouteResolution[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);

  const [recent, setRecent] = useState<ProjectRoutePlan[]>([]);
  const [streamUrl, setStreamUrl] = useState<string>('');

  useEffect(() => {
    void refreshRecent();
    void refreshSiteSpec();
    void refreshGhStatus();
  }, []);

  async function refreshRecent() {
    const res = await listMyPlans(1, 10);
    if (res.success) setRecent(res.data!.items);
  }

  async function refreshSiteSpec() {
    setSiteSpecLoading(true);
    const res = await getActiveSiteSpec();
    if (res.success) setSiteSpec(res.data!.siteSpec);
    setSiteSpecLoading(false);
  }

  async function refreshGhStatus() {
    const res = await getProjectRouteGitHubStatus();
    if (res.success) setGhStatus(res.data ?? null);
  }

  const sse = useSseStream({
    url: streamUrl,
    method: 'GET',
    onEvent: {
      apps: (data) => {
        const d = data as { apps: string[]; modules: string[]; repos?: ProjectRouteExtractedRepo[] };
        setApps(d.apps);
        setModules(d.modules);
        if (Array.isArray(d.repos)) setExtractedRepos(d.repos);
      },
      repo: (data) => {
        const d = data as RepoLiveStatus;
        setRepos((prev) => {
          const idx = prev.findIndex((x) => x.repoUrl === d.repoUrl);
          if (idx === -1) return [...prev, d];
          const next = [...prev];
          next[idx] = d;
          return next;
        });
      },
      model: (data) => {
        const d = data as { model: string; platform?: string };
        setModel(d.model);
        setPlatform(d.platform ?? null);
      },
      result: (data) => {
        const d = data as { resolutions: ProjectRouteResolution[] };
        setResolutions(d.resolutions);
      },
    },
    onDone: () => {
      void refreshRecent();
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.md') && f.type !== 'text/markdown' && f.type !== 'text/plain') {
      setError('请上传 .md 格式的 Markdown 方案');
      return;
    }
    setError(null);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.md$/i, ''));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFileChange({ target: { files: [f] } } as unknown as React.ChangeEvent<HTMLInputElement>);
  }

  function resetAnalysisState() {
    setApps([]);
    setModules([]);
    setExtractedRepos([]);
    setRepos([]);
    setResolutions([]);
    setModel(null);
    setPlatform(null);
  }

  const startAnalysis = useCallback(
    (planId: string) => {
      resetAnalysisState();
      const url = getAnalyzeStreamUrl(planId);
      setStreamUrl(url);
      void sse.start({ url });
    },
    [sse],
  );

  async function handleSubmit() {
    if (!siteSpec || !siteSpec.markdownContent?.trim()) {
      setError('公共站点说明尚未配置，请联系管理员先在「公共站点说明」标签上传一份 markdown。');
      return;
    }
    if (!title.trim()) { setError('请填写方案标题'); return; }
    if (!file) { setError('请上传方案 .md 文件'); return; }

    setError(null);
    setUploading(true);
    try {
      const uploadRes = await uploadAttachment(file);
      if (!uploadRes.success) {
        setError(uploadRes.error?.message ?? '文件上传失败');
        return;
      }
      const createRes = await createPlan(title.trim(), uploadRes.data!.attachmentId);
      if (!createRes.success) {
        setError(createRes.error?.message ?? '创建方案失败');
        return;
      }
      const p = createRes.data!.plan;
      setPlan(p);
      startAnalysis(p.id);
      void refreshRecent();
    } catch {
      setError('提交过程发生错误，请重试');
    } finally {
      setUploading(false);
    }
  }

  const isBusy = uploading || sse.phase === 'connecting' || sse.phase === 'streaming';

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)] gap-6">
      {/* 左侧：上传 + 历史 */}
      <aside className="flex flex-col gap-4">
        <section className="bg-white/3 border border-white/10 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Upload className="w-4 h-4 text-sky-400" /> 上传方案
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-white/60 mb-1.5">方案标题</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如：用户中心改版 v2"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-sky-500/50"
                disabled={isBusy}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/60 mb-1.5">方案文件 (.md)</label>
              {file ? (
                <div className="flex items-center gap-2 bg-white/5 border border-sky-500/30 rounded-lg px-3 py-2">
                  <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white truncate">{file.name}</p>
                    <p className="text-[10px] text-white/40">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                  {!isBusy && (
                    <button onClick={() => setFile(null)} className="text-white/40 hover:text-white/70">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ) : (
                <div
                  className="border-2 border-dashed border-white/10 rounded-lg p-5 text-center hover:border-sky-500/40 hover:bg-white/3 transition-colors cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                >
                  <Upload className="w-6 h-6 text-white/30 mx-auto mb-2" />
                  <p className="text-xs text-white/50">拖拽 .md 到此处，或点击选择</p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,text/markdown"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {siteSpecLoading ? (
              <p className="text-[11px] text-white/40">正在读取公共站点说明…</p>
            ) : siteSpec && siteSpec.markdownContent?.trim() ? (
              <p className="text-[11px] text-white/40">
                公共站点说明：<span className="text-white/70">{siteSpec.title}</span>（{(siteSpec.markdownContent?.length ?? 0).toLocaleString()} 字符）
              </p>
            ) : (
              <p className="text-[11px] text-amber-300/80">公共站点说明尚未配置，需管理员先上传一份 markdown。</p>
            )}

            {/* GitHub 授权状态 —— 与 pr-review 共享同一份 OAuth 连接 */}
            <GitHubStatusCard status={ghStatus} onRefresh={() => { void refreshGhStatus(); }} />

            {error && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isBusy || !file || !title.trim() || !siteSpec || !siteSpec.markdownContent?.trim()}
              className="w-full bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-2.5 text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> 分析中…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> 开始分析
                </>
              )}
            </button>
          </div>
        </section>

        <section className="bg-white/3 border border-white/10 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-3">我的最近方案</h2>
          {recent.length === 0 ? (
            <p className="text-xs text-white/40">还没有提交过方案。</p>
          ) : (
            <ul className="space-y-1">
              {recent.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setPlan(p);
                      setApps(p.extractedApps ?? []);
                      setModules(p.extractedModules ?? []);
                      setExtractedRepos(p.extractedRepos ?? []);
                      setResolutions(p.resolutions ?? []);
                      setRepos([]);
                      setModel(p.model ?? null);
                      setPlatform(p.modelPlatform ?? null);
                      if (p.status !== 'Done') startAnalysis(p.id);
                    }}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-white/5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white truncate flex-1">{p.title}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <p className="text-[10px] text-white/40 mt-0.5">{new Date(p.submittedAt).toLocaleString()}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      {/* 右侧：分析结果三栏漏斗 */}
      <section className="flex flex-col gap-4">
        <div className="bg-white/3 border border-white/10 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-300" />
              当前分析 {plan ? `· ${plan.title}` : ''}
            </h2>
            {model && (
              <span className="text-[11px] text-white/40 font-mono">● {model}{platform ? ` · ${platform}` : ''}</span>
            )}
          </div>
          <p className="text-xs text-white/60 mb-2">{sse.phaseMessage || (plan ? '已读取历史结果' : '尚未发起分析')}</p>
          {sse.phase === 'error' && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <p className="text-xs text-red-300">{sse.phaseMessage}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 1) 应用 + 模块 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3">① 应用 / 业务模块</h3>
            <PillList label="应用" items={apps} color="sky" />
            <div className="h-3" />
            <PillList label="业务模块" items={modules} color="emerald" />
          </div>

          {/* 2) AI 抽出的仓库 + 克隆状态 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5" /> ② AI 选中的仓库 / routemap
            </h3>
            {extractedRepos.length === 0 && repos.length === 0 ? (
              <p className="text-xs text-white/30">分析时显示 AI 从公共说明里抽出的仓库 + 克隆状态</p>
            ) : (
              <ul className="space-y-2">
                {(repos.length > 0 ? repos.map((r) => ({
                  appName: r.appName,
                  repoUrl: r.repoUrl,
                  branch: r.branch,
                  reasoning: extractedRepos.find((er) => er.repoUrl === r.repoUrl)?.reasoning,
                  status: r.status,
                  message: r.message,
                  fileCount: r.fileCount,
                })) : extractedRepos.map((er) => ({
                  appName: er.appName,
                  repoUrl: er.repoUrl,
                  branch: er.branch,
                  reasoning: er.reasoning,
                  status: 'cloning' as RepoLiveStatus['status'],
                  message: null as string | null | undefined,
                  fileCount: undefined as number | undefined,
                }))).map((r) => (
                  <li key={r.repoUrl} className="bg-white/3 rounded-md p-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white truncate flex-1">{r.appName}</span>
                      <RepoBadge status={r.status} />
                    </div>
                    <p className="text-[10px] text-white/40 truncate">{r.repoUrl} · {r.branch}</p>
                    {r.reasoning && <p className="text-[10px] text-sky-200/70 mt-1">AI: {r.reasoning}</p>}
                    {r.message && <p className="text-[10px] text-amber-200/70 mt-1">{r.message}</p>}
                    {r.fileCount != null && (
                      <p className="text-[10px] text-white/40 mt-1">{r.fileCount} 个 routemap 文件</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 3) 项目路径 — 按仓库分组 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5" /> ③ 仓库 × 项目路径
            </h3>
            {resolutions.length === 0 ? (
              <p className="text-xs text-white/30">分析完成后按仓库展示命中的项目路径</p>
            ) : (
              <ul className="space-y-3">
                {resolutions.map((r) => (
                  <li key={r.repoUrl} className="bg-white/3 rounded-md p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white truncate flex-1">{r.repoAppName || r.repoUrl}</span>
                      <ResolutionBadge status={r.status} />
                    </div>
                    {r.repoUrl && r.repoUrl !== r.repoAppName && (
                      <p className="text-[10px] text-white/40 truncate mt-0.5">{r.repoUrl}</p>
                    )}
                    {r.matchedAppsOrModules.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {r.matchedAppsOrModules.map((m, j) => (
                          <span key={j} className="px-1.5 py-0.5 rounded-md text-[10px] bg-sky-500/15 border border-sky-500/30 text-sky-200">{m}</span>
                        ))}
                      </div>
                    )}
                    {r.projectPaths.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {r.projectPaths.map((p, j) => (
                          <li key={j} className="text-[11px] text-emerald-200/90 font-mono break-all">{p}</li>
                        ))}
                      </ul>
                    )}
                    {r.reasoning && (
                      <p className="text-[10px] text-white/40 mt-1.5 break-all">{r.reasoning}</p>
                    )}
                    {r.status === 'CloneFailed' && !ghStatus?.connected && (
                      <a
                        href="/pr-review"
                        className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 px-1.5 py-0.5 rounded-md transition-colors"
                      >
                        <Github className="w-3 h-3" /> 去授权 GitHub 后重试
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function GitHubStatusCard({ status, onRefresh }: { status: ProjectRouteGitHubStatus | null; onRefresh: () => void }) {
  if (status == null) return null;
  if (status.connected) {
    return (
      <div className="flex items-center gap-2 bg-emerald-500/8 border border-emerald-500/20 rounded-md px-3 py-2">
        <Github className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-emerald-200">
            已用 GitHub 账号 <span className="font-medium">{status.githubLogin ?? '已授权'}</span> 授权（私有 / 组织仓库 routemap 可拉）
          </p>
        </div>
        <a
          href="/pr-review"
          className="text-[11px] text-emerald-300/80 hover:text-emerald-200 underline-offset-2 hover:underline shrink-0"
        >
          管理
        </a>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-amber-500/8 border border-amber-500/20 rounded-md px-3 py-2">
      <Github className="w-3.5 h-3.5 text-amber-300 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-amber-200">
          尚未授权 GitHub。匿名访问只能拉公共仓库；私有 / 组织仓库会克隆失败。
        </p>
      </div>
      <a
        href="/pr-review"
        onClick={() => setTimeout(onRefresh, 2000)}
        className="inline-flex items-center gap-1 text-[11px] text-amber-200 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 px-2 py-0.5 rounded-md shrink-0 transition-colors"
      >
        去授权 <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

function PillList({ label, items, color }: { label: string; items: string[]; color: 'sky' | 'emerald' }) {
  const cls = color === 'sky'
    ? 'bg-sky-500/15 border-sky-500/30 text-sky-200'
    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200';
  return (
    <div>
      <p className="text-[11px] text-white/50 mb-1.5">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-white/30">—</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((s, i) => (
            <span key={i} className={`px-2 py-0.5 rounded-md text-[11px] border ${cls}`}>{s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const m: Record<string, { label: string; cls: string }> = {
    Done: { label: '已完成', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' },
    Running: { label: '分析中', cls: 'bg-sky-500/15 text-sky-200 border-sky-500/30' },
    Queued: { label: '排队中', cls: 'bg-white/8 text-white/60 border-white/15' },
    Error: { label: '出错', cls: 'bg-red-500/15 text-red-200 border-red-500/30' },
  };
  const info = m[status] ?? m.Queued;
  return <span className={`px-1.5 py-0.5 rounded-md text-[10px] border ${info.cls}`}>{info.label}</span>;
}

function RepoBadge({ status }: { status: RepoLiveStatus['status'] }) {
  const m: Record<string, { label: string; cls: string }> = {
    cloning: { label: '克隆中', cls: 'bg-sky-500/15 text-sky-200 border-sky-500/30' },
    ok: { label: '已就绪', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' },
    missing: { label: '无 routemap', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
    error: { label: '失败', cls: 'bg-red-500/15 text-red-200 border-red-500/30' },
  };
  const info = m[status] ?? m.cloning;
  return <span className={`px-1.5 py-0.5 rounded-md text-[10px] border ${info.cls}`}>{info.label}</span>;
}

function ResolutionBadge({ status }: { status: ProjectRouteResolution['status'] }) {
  const m: Record<string, { label: string; cls: string }> = {
    Hit: { label: '命中', cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30' },
    NotFound: { label: '无路径', cls: 'bg-white/8 text-white/60 border-white/15' },
    Ambiguous: { label: '多候选', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
    CloneFailed: { label: '克隆失败', cls: 'bg-red-500/15 text-red-200 border-red-500/30' },
    NoRoutemap: { label: '无 routemap', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
  };
  const info = m[status] ?? m.NotFound;
  return <span className={`px-1.5 py-0.5 rounded-md text-[10px] border ${info.cls}`}>{info.label}</span>;
}

// ─────────────────────────────────────────────────────────
// 管理员视图：编辑公共站点说明 + 仓库登记
// ─────────────────────────────────────────────────────────

function AdminView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
  }, []);

  async function handleSiteMdUpload(file: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.md') && file.type !== 'text/markdown' && file.type !== 'text/plain') {
      setError('请上传 .md 格式的 Markdown 文件');
      return;
    }
    // 单文件上限 1 MB，避免管理员误传巨大文件撑爆 textarea
    if (file.size > 1024 * 1024) {
      setError(`文件过大（${(file.size / 1024 / 1024).toFixed(2)} MB），上限 1 MB`);
      return;
    }
    setError(null);
    setOkMsg(null);
    setUploading(true);
    try {
      // 公共站点说明只需要 markdown 文本，本地读取即可。无需走 attachment 上传管线 —— 防止 DB 留无关附件记录。
      const text = await file.text();
      setMarkdown(text);
      if (!title) setTitle(file.name.replace(/\.md$/i, ''));
      setOkMsg(`已从 ${file.name} 载入（${(file.size / 1024).toFixed(1)} KB），下方可继续编辑`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取文件失败');
    } finally {
      setUploading(false);
    }
  }

  function handleSiteMdDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) void handleSiteMdUpload(f);
  }

  async function load() {
    setLoading(true);
    const res = await getActiveSiteSpec();
    if (res.success && res.data!.siteSpec) {
      const s = res.data!.siteSpec;
      setTitle(s.title);
      setMarkdown(s.markdownContent);
    }
    setLoading(false);
  }

  async function save() {
    setError(null);
    setOkMsg(null);
    if (!title.trim()) { setError('标题必填'); return; }
    if (!markdown.trim()) { setError('公共站点说明 markdown 必填'); return; }

    setSaving(true);
    try {
      const res = await upsertSiteSpec({ title: title.trim(), markdownContent: markdown });
      if (!res.success) {
        setError(res.error?.message ?? '保存失败');
        return;
      }
      setOkMsg(res.data!.mode === 'created' ? '已创建公共站点说明' : '已更新公共站点说明');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10 text-center text-white/50 text-sm">
        加载中…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <section className="bg-white/3 border border-white/10 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-3">公共站点说明</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-white/60 mb-1.5">标题</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：米多公共站点说明 v1"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-white/60">Markdown 内容（背景知识 / 应用列表 / 业务说明）</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 text-xs text-sky-300 hover:text-sky-200 border border-sky-500/30 hover:border-sky-500/50 disabled:opacity-50 px-2.5 py-1 rounded-md transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {uploading ? '读取中…' : '上传 .md 文件'}
                </button>
                {markdown && (
                  <span className="text-[11px] text-white/40">{markdown.length.toLocaleString()} 字符</span>
                )}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleSiteMdUpload(f);
                // 清空 input 以便用户再次选同一文件可触发 onChange
                e.target.value = '';
              }}
            />
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleSiteMdDrop}
              rows={12}
              placeholder="把 .md 文件拖到这里、点上面的「上传 .md 文件」按钮，或直接粘贴整段（例如 doc/ 下的 codebase-snapshot）"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-500/40"
            />
          </div>
        </div>
      </section>

      <section className="bg-white/3 border border-white/10 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white mb-2">仓库地址登记方式</h2>
        <p className="text-xs text-white/60 leading-relaxed">
          V2 不再单独维护「仓库登记表」。分析方案时，AI 会从上方 Markdown 内容里读取所有出现的 git URL，
          再结合方案上下文挑出真正需要克隆的仓库。所以请在上方 Markdown 里**明确写出**每个应用对应的仓库地址，例如：
        </p>
        <pre className="mt-2 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-[11px] text-emerald-200/90 font-mono leading-relaxed overflow-x-auto">
{`## 仓库索引

- 米多 PRD 智能体: https://github.com/inernoro/prd_agent.git (branch: main, routemap: routemap)
- 视觉创作: https://github.com/inernoro/openvisual.git
- 缺陷管理: https://github.com/example/defect-agent.git`}
        </pre>
        <p className="text-xs text-white/40 mt-2">
          AI 会优先在 markdown 里找类似上面的 URL 列表。分支 / routemapPath 可选，省略时默认为 <code className="text-white/60">main</code> / <code className="text-white/60">routemap</code>。
        </p>
      </section>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}
      {okMsg && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-xs text-emerald-200">
          {okMsg}
        </div>
      )}

      <div>
        <button
          onClick={save}
          disabled={saving}
          className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-lg px-5 py-2 text-sm font-medium text-white transition-colors"
        >
          {saving ? '保存中…' : '保存公共站点说明'}
        </button>
      </div>
    </div>
  );
}
