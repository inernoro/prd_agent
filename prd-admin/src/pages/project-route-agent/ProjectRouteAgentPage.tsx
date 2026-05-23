import { useState, useRef, useEffect, useCallback } from 'react';
import { Route, Upload, FileText, X, AlertCircle, Settings2, Sparkles, GitBranch, FolderTree, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  createPlan,
  listMyPlans,
  getActiveSiteSpec,
  upsertSiteSpec,
  getAnalyzeStreamUrl,
  type ProjectRoutePlan,
  type ProjectRouteSiteSpec,
  type ProjectRouteRepoEntry,
  type ProjectRouteResolution,
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

  const [plan, setPlan] = useState<ProjectRoutePlan | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [repos, setRepos] = useState<RepoLiveStatus[]>([]);
  const [resolutions, setResolutions] = useState<ProjectRouteResolution[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);

  const [recent, setRecent] = useState<ProjectRoutePlan[]>([]);
  const [streamUrl, setStreamUrl] = useState<string>('');

  useEffect(() => {
    void refreshRecent();
    void refreshSiteSpec();
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

  const sse = useSseStream({
    url: streamUrl,
    method: 'GET',
    onEvent: {
      apps: (data) => {
        const d = data as { apps: string[]; modules: string[] };
        setApps(d.apps);
        setModules(d.modules);
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
    if (!siteSpec || siteSpec.repos.length === 0) {
      setError('公共站点说明尚未配置，请联系管理员先在「公共站点说明」标签维护一份。');
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
            ) : siteSpec ? (
              <p className="text-[11px] text-white/40">
                公共站点说明：<span className="text-white/70">{siteSpec.title}</span>（{siteSpec.repos.length} 个仓库）
              </p>
            ) : (
              <p className="text-[11px] text-amber-300/80">公共站点说明尚未配置，需管理员先维护。</p>
            )}

            {error && (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={isBusy || !file || !title.trim() || !siteSpec || siteSpec.repos.length === 0}
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

          {/* 2) 仓库克隆状态 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5" /> ② 仓库克隆 / routemap
            </h3>
            {repos.length === 0 ? (
              <p className="text-xs text-white/30">分析时显示每个仓库的克隆状态</p>
            ) : (
              <ul className="space-y-2">
                {repos.map((r) => (
                  <li key={r.repoUrl} className="bg-white/3 rounded-md p-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white truncate flex-1">{r.appName}</span>
                      <RepoBadge status={r.status} />
                    </div>
                    <p className="text-[10px] text-white/40 truncate">{r.repoUrl} · {r.branch}</p>
                    {r.message && <p className="text-[10px] text-amber-200/70 mt-1">{r.message}</p>}
                    {r.fileCount != null && (
                      <p className="text-[10px] text-white/40 mt-1">{r.fileCount} 个 routemap 文件</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 3) 项目路径匹配 */}
          <div className="bg-white/3 border border-white/10 rounded-xl p-4 min-h-[200px]">
            <h3 className="text-xs font-semibold text-white/60 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <FolderTree className="w-3.5 h-3.5" /> ③ routemap 项目路径
            </h3>
            {resolutions.length === 0 ? (
              <p className="text-xs text-white/30">分析完成后展示具体命中的项目路径</p>
            ) : (
              <ul className="space-y-3">
                {resolutions.map((r, i) => (
                  <li key={i} className="bg-white/3 rounded-md p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white truncate flex-1">{r.appOrModule}</span>
                      <ResolutionBadge status={r.status} />
                    </div>
                    {r.repoAppName && (
                      <p className="text-[10px] text-white/50 mt-1">仓库：{r.repoAppName}</p>
                    )}
                    {r.projectPaths.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {r.projectPaths.map((p, j) => (
                          <li key={j} className="text-[11px] text-emerald-200/90 font-mono break-all">{p}</li>
                        ))}
                      </ul>
                    )}
                    {r.reasoning && (
                      <p className="text-[10px] text-white/40 mt-1.5">{r.reasoning}</p>
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
    NotFound: { label: '未找到', cls: 'bg-white/8 text-white/60 border-white/15' },
    Ambiguous: { label: '多候选', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' },
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
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [repos, setRepos] = useState<ProjectRouteRepoEntry[]>([]);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await getActiveSiteSpec();
    if (res.success && res.data!.siteSpec) {
      const s = res.data!.siteSpec;
      setTitle(s.title);
      setMarkdown(s.markdownContent);
      setRepos(s.repos);
    }
    setLoading(false);
  }

  function addRepo() {
    setRepos((prev) => [
      ...prev,
      { appName: '', aliases: [], repoUrl: '', branch: 'main', routemapPath: 'routemap', notes: '' },
    ]);
  }

  function updateRepo(i: number, patch: Partial<ProjectRouteRepoEntry>) {
    setRepos((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  function removeRepo(i: number) {
    setRepos((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    setError(null);
    setOkMsg(null);
    if (!title.trim()) { setError('标题必填'); return; }
    if (!markdown.trim()) { setError('公共站点说明 markdown 必填'); return; }
    const cleanedRepos = repos
      .map((r) => ({
        ...r,
        appName: r.appName.trim(),
        repoUrl: r.repoUrl.trim(),
        branch: r.branch?.trim() || 'main',
        routemapPath: r.routemapPath?.trim() || 'routemap',
        aliases: (r.aliases ?? []).map((a) => a.trim()).filter((a) => a.length > 0),
        notes: r.notes?.trim() || undefined,
      }))
      .filter((r) => r.appName && r.repoUrl);
    if (cleanedRepos.length === 0) { setError('至少登记一个仓库（应用名 + 仓库 URL）'); return; }

    setSaving(true);
    try {
      const res = await upsertSiteSpec({ title: title.trim(), markdownContent: markdown, repos: cleanedRepos });
      if (!res.success) {
        setError(res.error?.message ?? '保存失败');
        return;
      }
      setRepos(res.data!.siteSpec.repos);
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
            <label className="block text-xs font-medium text-white/60 mb-1.5">Markdown 内容（背景知识 / 应用列表 / 业务说明）</label>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              rows={12}
              placeholder="可以把 doc/ 下的 codebase-snapshot 之类整段粘进来"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white font-mono"
            />
          </div>
        </div>
      </section>

      <section className="bg-white/3 border border-white/10 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white">仓库登记表（用于克隆 routemap 目录）</h2>
          <button
            onClick={addRepo}
            className="text-xs text-sky-300 hover:text-sky-200 border border-sky-500/30 hover:border-sky-500/50 px-2.5 py-1 rounded-md"
          >
            + 添加仓库
          </button>
        </div>
        {repos.length === 0 && (
          <p className="text-xs text-white/40">还没有任何仓库登记。AI 在分析阶段会按这张表克隆每个仓库读取 routemap/ 目录。</p>
        )}
        <ul className="space-y-3">
          {repos.map((r, i) => (
            <li key={i} className="bg-white/3 border border-white/10 rounded-lg p-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <Field
                  label="应用名"
                  value={r.appName}
                  onChange={(v) => updateRepo(i, { appName: v })}
                  placeholder="例如：米多 PRD 智能体"
                />
                <Field
                  label="别名（逗号分隔）"
                  value={(r.aliases ?? []).join(', ')}
                  onChange={(v) => updateRepo(i, { aliases: v.split(',').map((s) => s.trim()).filter(Boolean) })}
                  placeholder="PRD, prd-agent, 解读"
                />
                <Field
                  label="仓库 URL"
                  value={r.repoUrl}
                  onChange={(v) => updateRepo(i, { repoUrl: v })}
                  placeholder="https://github.com/owner/repo.git"
                />
                <Field
                  label="分支"
                  value={r.branch}
                  onChange={(v) => updateRepo(i, { branch: v })}
                  placeholder="main"
                />
                <Field
                  label="routemap 路径（仓库内相对路径）"
                  value={r.routemapPath}
                  onChange={(v) => updateRepo(i, { routemapPath: v })}
                  placeholder="routemap"
                />
                <Field
                  label="备注"
                  value={r.notes ?? ''}
                  onChange={(v) => updateRepo(i, { notes: v })}
                  placeholder="（可选）"
                />
              </div>
              <div className="flex justify-end mt-2">
                <button
                  onClick={() => removeRepo(i)}
                  className="text-xs text-red-300/80 hover:text-red-200 border border-red-500/20 hover:border-red-500/40 px-2 py-1 rounded-md"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
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

function Field({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-white/50 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-white/5 border border-white/10 rounded-md px-2.5 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-sky-500/50"
      />
    </div>
  );
}
