import { useState, useRef, useEffect, useCallback } from 'react';
import { Route, Upload, FileText, X, AlertCircle, Settings2, Sparkles, GitBranch, FolderTree, Loader2, Github, ChevronDown, ChevronRight, History, RefreshCw, Trash2, Check, Copy } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { createPortal } from 'react-dom';
import {
  createPlan,
  deletePlan,
  listMyPlans,
  getActiveSiteSpec,
  upsertSiteSpec,
  getAnalyzeStreamUrl,
  getProjectRouteGitHubStatus,
  startProjectRouteGitHubDevice,
  pollProjectRouteGitHubDevice,
  disconnectProjectRouteGitHub,
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
  /** 找到的 routemap 目录（相对仓库根，monorepo 可能多个） */
  foundLocations?: string[];
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
  const [ghAuthOpen, setGhAuthOpen] = useState(false);

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
    // 初次加载：拉最近方案 + 公共站点说明 + GitHub 状态；
    // 然后把最新一条方案自动选中展示到右侧（避免进页面一片空白）。
    void (async () => {
      const res = await listMyPlans(1, 10);
      if (res.success) {
        const items = res.data!.items;
        setRecent(items);
        if (items.length > 0) {
          const top = items[0];
          setPlan(top);
          setApps(top.extractedApps ?? []);
          setModules(top.extractedModules ?? []);
          setExtractedRepos(top.extractedRepos ?? []);
          setResolutions(top.resolutions ?? []);
          setRepos([]);
          setModel(top.model ?? null);
          setPlatform(top.modelPlatform ?? null);
        }
      }
    })();
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

  async function handleDeletePlan(p: ProjectRoutePlan) {
    const ok = window.confirm(`删除方案「${p.title}」？`);
    if (!ok) return;
    const res = await deletePlan(p.id);
    if (!res.success) {
      setError(res.error?.message ?? '删除失败');
      return;
    }
    // 如果删除的是当前选中的方案，清空右侧分析视图
    if (plan?.id === p.id) {
      setPlan(null);
      resetAnalysisState();
    }
    await refreshRecent();
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

            {/* GitHub 授权状态 —— 内联 Device Flow，不跳转其他智能体 */}
            <GitHubStatusCard
              status={ghStatus}
              onOpenAuth={() => setGhAuthOpen(true)}
              onRefresh={() => { void refreshGhStatus(); }}
            />

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
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <History className="w-4 h-4 text-white/40" />我的最近方案
            </h2>
            <button
              onClick={() => { void refreshRecent(); }}
              className="text-[10px] text-white/40 hover:text-white/70 transition-colors"
              title="刷新列表"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          {recent.length === 0 ? (
            <p className="text-xs text-white/40">还没有提交过方案。</p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((p) => {
                const isActive = plan?.id === p.id;
                const repoCount = (p.extractedRepos ?? []).length;
                const moduleCount = (p.extractedModules ?? []).length;
                const projectCount = (p.resolutions ?? []).reduce((s, r) => s + (r.projectPaths?.length ?? 0), 0);
                return (
                  <li key={p.id}>
                    <div className={`group rounded-md transition-colors ${isActive ? 'bg-sky-500/10 border border-sky-500/30' : 'hover:bg-white/5 border border-transparent'}`}>
                      <div className="relative">
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
                            // 历史方案：Done / Error 都只回放，不自动重跑；只有 Queued / Running 才接着跑
                            if (p.status === 'Queued' || p.status === 'Running') startAnalysis(p.id);
                          }}
                          className="w-full text-left px-3 py-2 pr-8"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-white truncate flex-1">{p.title}</span>
                            <StatusBadge status={p.status} />
                          </div>
                          <p className="text-[10px] text-white/40 mt-0.5">{new Date(p.submittedAt).toLocaleString()}</p>
                          {(repoCount > 0 || moduleCount > 0 || projectCount > 0) && (
                            <div className="flex items-center gap-2 mt-1 text-[10px] text-white/40">
                              {moduleCount > 0 && <span>{moduleCount} 模块</span>}
                              {repoCount > 0 && <span>· {repoCount} 仓库</span>}
                              {projectCount > 0 && <span>· {projectCount} 路径</span>}
                            </div>
                          )}
                        </button>
                        {/* 删除按钮始终常驻显示，任何状态的方案都可删 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); void handleDeletePlan(p); }}
                          className="absolute top-2 right-2 p-1 rounded text-white/50 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                          title="删除此方案"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {isActive && (
                        <div className="px-3 pb-2 flex items-center justify-end">
                          <button
                            onClick={(e) => { e.stopPropagation(); startAnalysis(p.id); }}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 text-[10px] text-sky-200 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-50 border border-sky-500/30 px-2 py-0.5 rounded-md transition-colors"
                            title="忽略已存结果，重新分析一次"
                          >
                            <RefreshCw className="w-3 h-3" /> 重新分析
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
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

          {plan && plan.status === 'Done' && sse.phase === 'idle' && (
            <div className="flex items-center gap-2 bg-amber-500/8 border border-amber-500/20 rounded-md px-3 py-1.5 mb-2">
              <History className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              <p className="text-[11px] text-amber-200/90 flex-1">
                正在查看历史记录 · 提交于 {new Date(plan.submittedAt).toLocaleString()}
                {plan.completedAt && ` · 完成于 ${new Date(plan.completedAt).toLocaleString()}`}
              </p>
              <button
                onClick={() => startAnalysis(plan.id)}
                disabled={isBusy}
                className="inline-flex items-center gap-1 text-[10px] text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-50 border border-amber-500/30 px-2 py-0.5 rounded-md transition-colors shrink-0"
              >
                <RefreshCw className="w-3 h-3" /> 重新分析
              </button>
            </div>
          )}

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

          {/* 2) 当前方案关联仓库地址 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5" /> ② 当前方案关联仓库地址
            </h3>
            {extractedRepos.length === 0 && repos.length === 0 ? (
              <p className="text-xs text-white/30">分析时显示 AI 从公共说明里抽出的仓库 + 克隆状态</p>
            ) : (
              <ul className="space-y-2">
                {(repos.length > 0 ? repos.map((r) => ({
                  appName: r.appName,
                  repoUrl: r.repoUrl,
                  branch: r.branch,
                  reasoning: extractedRepos.find((er) => er.repoUrl === r.repoUrl)?.reasoning ?? null,
                  sourceContext: extractedRepos.find((er) => er.repoUrl === r.repoUrl)?.sourceContext ?? null,
                  routemapPath: extractedRepos.find((er) => er.repoUrl === r.repoUrl)?.routemapPath ?? 'routemap',
                  status: r.status,
                  message: r.message ?? null,
                  fileCount: r.fileCount,
                  foundLocations: r.foundLocations,
                })) : extractedRepos.map((er) => ({
                  appName: er.appName,
                  repoUrl: er.repoUrl,
                  branch: er.branch,
                  reasoning: er.reasoning ?? null,
                  sourceContext: er.sourceContext ?? null,
                  routemapPath: er.routemapPath,
                  status: 'cloning' as RepoLiveStatus['status'],
                  message: null as string | null | undefined,
                  fileCount: undefined as number | undefined,
                  foundLocations: undefined as string[] | undefined,
                }))).map((r) => (
                  <RepoCard key={r.repoUrl} r={r} />
                ))}
              </ul>
            )}
          </div>

          {/* 3) 仓库 × 关联项目路径 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5" /> ③ 仓库 × 关联项目路径
            </h3>
            {resolutions.length === 0 ? (
              <p className="text-xs text-white/30">分析完成后按仓库展示命中的项目路径 + 第三方仓库</p>
            ) : (
              <ul className="space-y-3">
                {resolutions.map((r) => (
                  <ResolutionCard
                    key={r.repoUrl}
                    r={r}
                    ghConnected={!!ghStatus?.connected}
                    onOpenAuth={() => setGhAuthOpen(true)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {ghAuthOpen && (
        <GitHubAuthModal
          onClose={() => setGhAuthOpen(false)}
          onSuccess={() => { setGhAuthOpen(false); void refreshGhStatus(); }}
        />
      )}
    </div>
  );
}

function GitHubStatusCard({
  status,
  onOpenAuth,
  onRefresh,
}: {
  status: ProjectRouteGitHubStatus | null;
  onOpenAuth: () => void;
  onRefresh: () => void;
}) {
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
        <button
          onClick={async () => {
            const ok = window.confirm(`断开 GitHub 账号「${status.githubLogin ?? '当前账号'}」？\n断开后私有 / 组织仓库将无法拉取。`);
            if (!ok) return;
            const res = await disconnectProjectRouteGitHub();
            if (res.success) onRefresh();
          }}
          className="text-[11px] text-emerald-300/80 hover:text-emerald-200 hover:underline shrink-0"
        >
          断开授权
        </button>
      </div>
    );
  }
  if (!status.oauthConfigured) {
    return (
      <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-md px-3 py-2">
        <Github className="w-3.5 h-3.5 text-white/40 shrink-0" />
        <p className="text-[11px] text-white/50">
          后端未配置 GitHub OAuth ClientId/Secret，无法授权 —— 仅可拉公共仓库。
        </p>
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
      <button
        onClick={onOpenAuth}
        className="inline-flex items-center gap-1 text-[11px] text-amber-200 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 px-2 py-0.5 rounded-md shrink-0 transition-colors"
      >
        授权 GitHub
      </button>
    </div>
  );
}

/**
 * GitHub Device Flow 内联授权弹窗 —— 全程在项目路由智能体页面内完成，不跳 /pr-review。
 * 流程：start → 显示 user_code + 跳 GitHub 输入页 → 后端轮询 → done。
 */
function GitHubAuthModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'success' | 'expired' | 'denied' | 'error'>('idle');
  const [data, setData] = useState<{
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    intervalSeconds: number;
    expiresInSeconds: number;
    flowToken: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void start();
    return () => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function start() {
    setPhase('starting');
    setErrorMsg(null);
    const res = await startProjectRouteGitHubDevice();
    if (!res.success || !res.data) {
      setPhase('error');
      setErrorMsg(res.error?.message ?? '发起 Device Flow 失败');
      return;
    }
    setData(res.data);
    setPhase('waiting');
    // 等用户去 GitHub 输入码后开始轮询
    schedulePoll(res.data.flowToken, res.data.intervalSeconds);
  }

  function schedulePoll(flowToken: string, intervalSec: number) {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => { void pollOnce(flowToken); }, intervalSec * 1000);
  }

  async function pollOnce(flowToken: string) {
    const res = await pollProjectRouteGitHubDevice(flowToken);
    if (!res.success) {
      setPhase('error');
      setErrorMsg(res.error?.message ?? '轮询失败');
      return;
    }
    const status = res.data?.status ?? 'pending';
    if (status === 'done') {
      setPhase('success');
      // 让用户看到 success 状态 1.2s 后再关弹窗
      window.setTimeout(onSuccess, 1200);
      return;
    }
    if (status === 'expired') { setPhase('expired'); return; }
    if (status === 'denied') { setPhase('denied'); return; }
    // pending / slow_down → 继续轮询；slow_down 时把间隔翻倍
    const nextInterval = status === 'slow_down' ? (data?.intervalSeconds ?? 5) * 2 : (data?.intervalSeconds ?? 5);
    schedulePoll(flowToken, nextInterval);
  }

  async function copyCode() {
    if (!data?.userCode) return;
    try {
      await navigator.clipboard.writeText(data.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // best effort
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="relative rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl"
        style={{ width: '480px', maxWidth: '94vw', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Github className="w-4 h-4" /> 授权 GitHub（项目路由智能体）
          </h3>
          <button onClick={onClose} className="text-white/40 hover:text-white/80">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className="px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', maxHeight: 'calc(90vh - 60px)' }}
        >
          {(phase === 'starting' || phase === 'idle') && (
            <div className="flex items-center justify-center py-10 text-white/60 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在发起授权…
            </div>
          )}

          {phase === 'waiting' && data && (
            <div className="space-y-4">
              <p className="text-xs text-white/70 leading-relaxed">
                1. 点击下方按钮跳转 GitHub 授权页（新窗口）<br />
                2. GitHub 会要求你输入下面这个验证码<br />
                3. 授权完成后本页面会自动检测，无需手动回来
              </p>

              <div className="bg-black/40 border border-white/10 rounded-lg p-4 text-center">
                <p className="text-[10px] text-white/50 mb-1.5 uppercase tracking-wider">用户验证码</p>
                <p className="text-[28px] font-mono text-emerald-200 tracking-[0.3em] select-all">
                  {data.userCode}
                </p>
                <button
                  onClick={copyCode}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-white/60 hover:text-white/90"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                  {copied ? '已复制' : '复制验证码'}
                </button>
              </div>

              <a
                href={data.verificationUriComplete || data.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-sky-600 hover:bg-sky-500 rounded-lg py-2.5 text-sm font-medium text-white transition-colors"
              >
                打开 GitHub 输入验证码 →
              </a>

              <div className="flex items-center justify-center gap-2 text-[11px] text-white/40">
                <Loader2 className="w-3 h-3 animate-spin" /> 等待 GitHub 那边完成授权…
              </div>

              <p className="text-[10px] text-white/30 text-center">
                验证码 {Math.floor(data.expiresInSeconds / 60)} 分钟内有效
              </p>
            </div>
          )}

          {phase === 'success' && (
            <div className="flex flex-col items-center justify-center py-8 text-emerald-200">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mb-3">
                <Check className="w-6 h-6 text-emerald-300" />
              </div>
              <p className="text-sm">授权成功，正在返回…</p>
            </div>
          )}

          {phase === 'expired' && (
            <div className="text-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-amber-300 mx-auto" />
              <p className="text-sm text-amber-200">验证码已过期</p>
              <button
                onClick={start}
                className="text-xs text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline"
              >
                重新获取
              </button>
            </div>
          )}

          {phase === 'denied' && (
            <div className="text-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-red-300 mx-auto" />
              <p className="text-sm text-red-200">用户拒绝了授权</p>
              <button
                onClick={onClose}
                className="text-xs text-white/60 hover:text-white/90 underline-offset-2 hover:underline"
              >
                关闭
              </button>
            </div>
          )}

          {phase === 'error' && (
            <div className="text-center py-6 space-y-3">
              <AlertCircle className="w-8 h-8 text-red-300 mx-auto" />
              <p className="text-sm text-red-200">{errorMsg ?? '授权过程出错'}</p>
              <button
                onClick={start}
                className="text-xs text-sky-300 hover:text-sky-200 underline-offset-2 hover:underline"
              >
                重试
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
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

/** 第二栏单条仓库卡：默认折叠简要，点开看完整 reasoning / sourceContext / 全部 routemap 子目录 */
function RepoCard({ r }: {
  r: {
    appName: string;
    repoUrl: string;
    branch: string;
    reasoning: string | null;
    sourceContext: string | null;
    routemapPath: string;
    status: RepoLiveStatus['status'];
    message: string | null | undefined;
    fileCount?: number;
    foundLocations?: string[];
  };
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="bg-white/3 rounded-md p-2 border border-white/5">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="text-white/40 hover:text-white/70 shrink-0">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <span className="text-xs text-white truncate flex-1">{r.appName}</span>
        <RepoBadge status={r.status} />
      </div>
      <p className="text-[10px] text-white/40 break-all mt-0.5">
        <a href={r.repoUrl} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300">
          {r.repoUrl}
        </a>
        <span className="text-white/30"> · {r.branch}</span>
      </p>
      {!open && r.reasoning && (
        <p className="text-[10px] text-sky-200/70 mt-1 line-clamp-2">AI: {r.reasoning}</p>
      )}
      {r.message && (
        <p className="text-[10px] text-amber-200/70 mt-1 break-all">{r.message}</p>
      )}
      {!open && r.foundLocations && r.foundLocations.length > 0 && (
        <p className="text-[10px] text-emerald-200/70 mt-1">{r.foundLocations.length} 个 routemap 子目录</p>
      )}
      {r.fileCount != null && !open && (
        <p className="text-[10px] text-white/40 mt-1">{r.fileCount} 个 routemap 文件</p>
      )}

      {open && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-2 text-[11px]">
          <DetailRow label="routemapPath" value={r.routemapPath} mono />
          {r.reasoning && (
            <DetailRow label="AI 选中理由" value={r.reasoning} preserveWhitespace />
          )}
          {r.sourceContext && (
            <DetailRow label="公共说明原文片段" value={r.sourceContext} preserveWhitespace mono />
          )}
          {r.foundLocations && r.foundLocations.length > 0 && (
            <div>
              <p className="text-white/40 mb-1">routemap 子目录（{r.foundLocations.length}）</p>
              <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                {r.foundLocations.map((loc, idx) => (
                  <li key={idx} className="text-emerald-200/90 font-mono text-[11px] break-all">{loc}/</li>
                ))}
              </ul>
            </div>
          )}
          {r.fileCount != null && (
            <DetailRow label="routemap 文件数" value={String(r.fileCount)} />
          )}
        </div>
      )}
    </li>
  );
}

/** 第三栏单条 Resolution 卡：默认显示项目路径 + 第三方仓库；点开看 .md 文件全文 */
function ResolutionCard({ r, ghConnected, onOpenAuth }: { r: ProjectRouteResolution; ghConnected: boolean; onOpenAuth?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="bg-white/3 rounded-md p-2.5 border border-white/5">
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="text-white/40 hover:text-white/70 shrink-0">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <span className="text-xs text-white truncate flex-1">{r.repoAppName || r.repoUrl}</span>
        <ResolutionBadge status={r.status} />
      </div>
      {r.repoUrl && r.repoUrl !== r.repoAppName && (
        <p className="text-[10px] text-white/40 break-all mt-0.5">{r.repoUrl}</p>
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
      {r.linkedThirdPartyRepos.length > 0 && (
        <div className="mt-2 bg-emerald-500/5 border border-emerald-500/15 rounded p-1.5">
          <p className="text-[10px] text-emerald-300/80 mb-1">关联第三方仓库（{r.linkedThirdPartyRepos.length}）</p>
          <ul className="space-y-0.5">
            {r.linkedThirdPartyRepos.map((url, j) => (
              <li key={j} className="text-[11px]">
                <a href={url} target="_blank" rel="noopener noreferrer" className="text-emerald-200/90 font-mono break-all hover:text-emerald-100 hover:underline">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.reasoning && (
        <p className="text-[10px] text-white/40 mt-1.5 break-all">{r.reasoning}</p>
      )}
      {r.status === 'CloneFailed' && !ghConnected && onOpenAuth && (
        <button
          onClick={onOpenAuth}
          className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 px-1.5 py-0.5 rounded-md transition-colors"
        >
          <Github className="w-3 h-3" /> 授权 GitHub 后重试
        </button>
      )}

      {open && r.routemapFiles.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
          <p className="text-[11px] text-white/60">routemap *.md 文件全文（{r.routemapFiles.length}）</p>
          {r.routemapFiles.map((f, idx) => (
            <details key={idx} className="bg-black/20 border border-white/5 rounded">
              <summary className="px-2 py-1 cursor-pointer text-[11px] text-emerald-200/90 font-mono">
                {f.path} <span className="text-white/30">· {(f.sizeBytes / 1024).toFixed(1)} KB</span>
              </summary>
              <pre
                className="px-2 py-1.5 text-[11px] text-white/80 font-mono whitespace-pre-wrap break-all"
                style={{ maxHeight: '320px', overflowY: 'auto' }}
              >
                {f.content || '(空 / 无法读取)'}
              </pre>
            </details>
          ))}
        </div>
      )}
      {open && r.routemapFiles.length === 0 && (
        <p className="text-[10px] text-white/40 mt-2 pt-2 border-t border-white/5">该仓库未命中任何 routemap *.md 文件。</p>
      )}
    </li>
  );
}

/** 详情行：label + value，可保留换行 / 字体 mono */
function DetailRow({ label, value, mono, preserveWhitespace }: {
  label: string;
  value: string;
  mono?: boolean;
  preserveWhitespace?: boolean;
}) {
  return (
    <div>
      <p className="text-white/40 mb-0.5">{label}</p>
      <p
        className={`text-white/80 break-all ${mono ? 'font-mono' : ''}`}
        style={preserveWhitespace ? { whiteSpace: 'pre-wrap' } : undefined}
      >
        {value}
      </p>
    </div>
  );
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
