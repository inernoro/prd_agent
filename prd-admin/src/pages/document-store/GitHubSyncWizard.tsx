import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Github, X, Check, Search, RefreshCw, Copy, ExternalLink,
  Folder, FileText, Lock, ChevronRight, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getGitHubAuthStatus, startGitHubDeviceFlow, pollGitHubDeviceFlow,
  listGitHubRepositories, listGitHubBranches, scanGitHubDocDirectories,
  type GitHubAuthStatus, type GitHubDeviceFlowStart, type GitHubRepository,
  type GitHubBranch, type GitHubDirectoryScan,
} from '@/services/real/githubConnect';
import { addGitHubSubscriptionBatch } from '@/services/real/documentStore';
import {
  buildDirectoryTree, defaultSelection, toggleSelection, setSelection,
  selectionSummary, filterDirectories, directoryLabel,
  type DirectoryTreeNode,
} from './githubDirectorySelection';

/**
 * 知识库 · GitHub 目录同步向导。
 *
 * 四步：连接 GitHub → 选仓库和分支 → 勾目录（所有 doc / docs 默认已勾）→ 开启同步。
 * 用户只需要做「他自己才知道」的那两件事：哪个仓库、要不要改默认勾选；
 * 仓库地址、分支、目录清单、默认该同步哪些，全部由系统查出来
 * （对齐 minimal-user-input：系统查得到的东西不摆输入框）。
 */

const ACCENT = '130,80,223';

type Step = 'connect' | 'repo' | 'directories' | 'done';

interface BatchResult {
  createdCount: number;
  created: Array<{ id: string; title: string; path: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

export function GitHubSyncWizard({ storeId, onClose, onFinished }: {
  storeId: string;
  onClose: () => void;
  /** 成功创建订阅后回调，页面据此刷新条目列表 */
  onFinished: () => void;
}) {
  const [step, setStep] = useState<Step>('connect');
  const [auth, setAuth] = useState<GitHubAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<{ repo: GitHubRepository; branch: string } | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);

  const loadAuth = useCallback(async () => {
    setAuthLoading(true);
    const res = await getGitHubAuthStatus();
    if (res.success) {
      setAuth(res.data);
      // 已连接就直接跳到选仓库，不让用户在一个「已完成」的步骤上多点一次
      setStep((prev) => (prev === 'connect' && res.data.connected ? 'repo' : prev));
    } else {
      setError(res.error?.message ?? '读取 GitHub 连接状态失败');
    }
    setAuthLoading(false);
  }, []);

  useEffect(() => { void loadAuth(); }, [loadAuth]);

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[720px] max-w-[94vw] max-h-[88vh] rounded-[16px] p-6 flex flex-col">
        <Header step={step} onClose={onClose} login={auth?.connected ? auth.login ?? null : null} />

        {error && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-[10px]"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.16)' }}>
            <AlertCircle size={14} style={{ color: 'var(--accent-fg-error)', marginTop: 1 }} />
            <span className="text-[12px]" style={{ color: 'var(--accent-fg-error)' }}>{error}</span>
          </div>
        )}

        {authLoading ? (
          <div className="flex items-center justify-center gap-2 py-16">
            <MapSpinner size={14} />
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取 GitHub 连接状态…</span>
          </div>
        ) : step === 'connect' ? (
          <ConnectStep onConnected={() => { setError(''); void loadAuth(); setStep('repo'); }} onError={setError} />
        ) : step === 'repo' ? (
          <RepoStep
            onSelected={(repo, branch) => { setError(''); setPicked({ repo, branch }); setStep('directories'); }}
            onError={setError}
          />
        ) : step === 'directories' && picked ? (
          <DirectoriesStep
            storeId={storeId}
            repo={picked.repo}
            branch={picked.branch}
            onBack={() => setStep('repo')}
            onError={setError}
            onDone={(batch) => { setResult(batch); setStep('done'); onFinished(); }}
          />
        ) : step === 'done' && result && picked ? (
          <DoneStep result={result} repoFullName={picked.repo.fullName} branch={picked.branch} onClose={onClose} />
        ) : (
          <div className="py-16 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            请先选择一个仓库
          </div>
        )}
      </div>
    </div>
  );
}

/** 顶部标题 + 步骤指示（让用户任何时候知道自己在第几步、还剩几步） */
function Header({ step, login, onClose }: { step: Step; login: string | null; onClose: () => void }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: 'connect', label: '连接 GitHub' },
    { key: 'repo', label: '选择仓库' },
    { key: 'directories', label: '勾选目录' },
    { key: 'done', label: '开启同步' },
  ];
  const activeIndex = steps.findIndex((s) => s.key === step);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
            style={{ background: `rgba(${ACCENT},0.08)`, border: `1px solid rgba(${ACCENT},0.12)` }}>
            <Github size={15} style={{ color: 'var(--accent-fg-violet)' }} />
          </div>
          <div>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>从 GitHub 同步文档</div>
            {login && (
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已连接 {login}</div>
            )}
          </div>
        </div>
        <button onClick={onClose} aria-label="关闭"
          className="hover-bg-soft w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer transition-colors duration-200"
          style={{ color: 'var(--text-muted)' }}>
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1.5 flex-1">
            <div className="flex items-center gap-1.5 flex-1 py-1.5 px-2 rounded-[8px] text-[11px] font-semibold transition-all duration-300"
              style={{
                background: i <= activeIndex ? `rgba(${ACCENT},0.1)` : 'var(--bg-nested)',
                border: i <= activeIndex ? `1px solid rgba(${ACCENT},0.2)` : '1px solid var(--border-subtle)',
                color: i <= activeIndex ? 'var(--accent-fg-violet)' : 'var(--text-muted)',
              }}>
              {i < activeIndex ? <Check size={11} /> : <span>{i + 1}</span>}
              <span className="truncate">{s.label}</span>
            </div>
            {i < steps.length - 1 && <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 第一步：Device Flow 授权。全程显示 user code、剩余时间与当前状态，不留静止等待。 */
function ConnectStep({ onConnected, onError }: { onConnected: () => void; onError: (msg: string) => void }) {
  const [flow, setFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'denied' | 'expired'>('idle');
  const pollRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) { window.clearTimeout(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  const start = async () => {
    setStarting(true);
    onError('');
    const res = await startGitHubDeviceFlow();
    setStarting(false);
    if (!res.success) {
      onError(res.error?.message ?? '发起 GitHub 授权失败');
      return;
    }

    setFlow(res.data);
    setPhase('waiting');
    setRemaining(res.data.expiresInSeconds);
    window.open(res.data.verificationUriComplete || res.data.verificationUri, '_blank', 'noopener');

    tickRef.current = window.setInterval(() => {
      setRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    const intervalMs = Math.max(res.data.intervalSeconds, 5) * 1000;
    const poll = async (delay: number) => {
      pollRef.current = window.setTimeout(async () => {
        const p = await pollGitHubDeviceFlow(res.data.flowToken);
        if (!p.success) {
          stopTimers();
          setPhase('idle');
          onError(p.error?.message ?? 'GitHub 授权轮询失败');
          return;
        }
        if (p.data.status === 'done') {
          stopTimers();
          toast.success('GitHub 已连接', p.data.login ? `账号 ${p.data.login}` : undefined);
          onConnected();
          return;
        }
        if (p.data.status === 'denied') { stopTimers(); setPhase('denied'); return; }
        if (p.data.status === 'expired') { stopTimers(); setPhase('expired'); return; }
        void poll(p.data.status === 'slow_down' ? delay + 5000 : delay);
      }, delay);
    };
    void poll(intervalMs);
  };

  const mmss = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;

  return (
    <div className="flex-1 overflow-y-auto">
      <p className="text-[12px] leading-[1.7] mb-4" style={{ color: 'var(--text-muted)' }}>
        连接你自己的 GitHub 账号后，就能同步你有权限的仓库（含私有仓）。授权只对你生效，
        令牌加密保存在你名下，随时可以断开。
      </p>

      {phase === 'waiting' && flow ? (
        <div className="rounded-[12px] p-4" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
            在刚打开的 GitHub 页面粘贴这个配对码：
          </div>
          <div className="flex items-center gap-2 mb-3">
            <code className="text-[20px] font-mono font-bold tracking-[0.2em] px-3 py-2 rounded-[10px]"
              style={{ background: `rgba(${ACCENT},0.08)`, color: 'var(--accent-fg-violet)' }}>
              {flow.userCode}
            </code>
            <Button variant="ghost" size="xs"
              onClick={() => { void navigator.clipboard.writeText(flow.userCode); toast.success('配对码已复制'); }}>
              <Copy size={12} /> 复制
            </Button>
            <Button variant="ghost" size="xs"
              onClick={() => window.open(flow.verificationUriComplete || flow.verificationUri, '_blank', 'noopener')}>
              <ExternalLink size={12} /> 重新打开授权页
            </Button>
          </div>
          <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <MapSpinner size={12} />
            正在等待你在 GitHub 完成授权… 本次配对码 {mmss} 后失效
          </div>
        </div>
      ) : phase === 'denied' || phase === 'expired' ? (
        <div className="rounded-[12px] p-4 mb-3"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.14)' }}>
          <div className="text-[12px] mb-2" style={{ color: 'var(--accent-fg-error)' }}>
            {phase === 'denied' ? '你在 GitHub 页面拒绝了授权。' : '配对码已超时失效。'}
          </div>
          <Button variant="primary" size="xs" onClick={() => { setPhase('idle'); void start(); }}>重新发起授权</Button>
        </div>
      ) : (
        <Button variant="primary" size="sm" onClick={() => void start()} disabled={starting}>
          {starting ? <MapSpinner size={12} /> : <Github size={13} />}
          {starting ? '正在发起授权…' : '连接 GitHub 账号'}
        </Button>
      )}
    </div>
  );
}

/** 第二步：选仓库 + 分支。仓库地址由系统列出来，用户不必去 GitHub 复制 URL。 */
function RepoStep({ onSelected, onError }: {
  onSelected: (repo: GitHubRepository, branch: string) => void;
  onError: (msg: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<GitHubRepository | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [branchLoading, setBranchLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const res = await listGitHubRepositories(query || undefined, 1, 30);
      if (cancelled) return;
      if (res.success) setRepos(res.data.items);
      else onError(res.error?.message ?? '读取仓库列表失败');
      setLoading(false);
    }, query ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, onError]);

  const pick = async (repo: GitHubRepository) => {
    setActive(repo);
    setBranch(repo.defaultBranch ?? 'main');
    setBranchLoading(true);
    const res = await listGitHubBranches(repo.owner, repo.repo);
    setBranchLoading(false);
    if (res.success) setBranches(res.data.items);
    else onError(res.error?.message ?? '读取分支失败');
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索仓库名"
          className="prd-field w-full h-9 pl-8 pr-3 rounded-[10px] text-[13px] outline-none" />
      </div>

      <div className="flex-1 overflow-y-auto min-h-[220px] rounded-[12px]"
        style={{ border: '1px solid var(--border-subtle)' }}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12">
            <MapSpinner size={13} />
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取你的仓库…</span>
          </div>
        ) : repos.length === 0 ? (
          <div className="py-12 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            没有匹配的仓库{query ? '，换个关键词试试' : ''}
          </div>
        ) : (
          repos.map((repo) => (
            <button key={repo.id} onClick={() => void pick(repo)}
              className="hover-bg-soft w-full flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer transition-colors duration-200"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                background: active?.id === repo.id ? `rgba(${ACCENT},0.08)` : undefined,
              }}>
              <Github size={13} style={{ color: 'var(--text-muted)' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {repo.fullName}
                  </span>
                  {repo.isPrivate && <Lock size={10} style={{ color: 'var(--text-muted)' }} />}
                </div>
                {repo.description && (
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{repo.description}</div>
                )}
              </div>
              {active?.id === repo.id && <Check size={13} style={{ color: 'var(--accent-fg-violet)' }} />}
            </button>
          ))
        )}
      </div>

      {active && (
        <div className="mt-3">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>分支</label>
          {branchLoading ? (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <MapSpinner size={12} /> 正在读取分支…
            </div>
          ) : (
            <select value={branch} onChange={(e) => setBranch(e.target.value)}
              className="prd-field w-full h-9 px-3 rounded-[10px] text-[13px] outline-none">
              {(branches.length > 0 ? branches.map((b) => b.name) : [branch]).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="primary" size="xs" disabled={!active || branchLoading}
          onClick={() => active && onSelected(active, branch)}>
          扫描目录
        </Button>
      </div>
    </div>
  );
}

/** 第三步：勾目录。进来就已经按 doc / docs 预勾好，用户只需要改他想改的。 */
function DirectoriesStep({ storeId, repo, branch, onBack, onDone, onError }: {
  storeId: string;
  repo: GitHubRepository;
  branch: string;
  onBack: () => void;
  onDone: (result: BatchResult) => void;
  onError: (msg: string) => void;
}) {
  const [scan, setScan] = useState<GitHubDirectoryScan | null>(null);
  const [scanning, setScanning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const runScan = useCallback(async () => {
    setScanning(true);
    setElapsed(0);
    const res = await scanGitHubDocDirectories(repo.owner, repo.repo, branch);
    setScanning(false);
    if (!res.success) {
      onError(res.error?.message ?? '扫描仓库目录失败');
      return;
    }
    setScan(res.data);
    setSelected(defaultSelection(res.data));
  }, [repo.owner, repo.repo, branch, onError]);

  useEffect(() => { void runScan(); }, [runScan]);

  useEffect(() => {
    if (!scanning) return;
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const visible = useMemo(
    () => (scan ? filterDirectories(scan.directories, keyword) : []),
    [scan, keyword],
  );
  const tree = useMemo(() => buildDirectoryTree(visible), [visible]);
  const summary = useMemo(
    () => selectionSummary(scan?.directories ?? [], selected),
    [scan, selected],
  );

  const submit = async () => {
    if (summary.directoryCount === 0) {
      onError('至少要勾选一个目录');
      return;
    }
    setSubmitting(true);
    onError('');
    const res = await addGitHubSubscriptionBatch(storeId, {
      owner: repo.owner,
      repo: repo.repo,
      branch,
      directories: [...selected].map((path) => ({ path })),
    });
    setSubmitting(false);
    if (!res.success) {
      onError(res.error?.message ?? '开启同步失败');
      return;
    }
    onDone({
      createdCount: res.data.createdCount,
      created: res.data.created,
      skipped: res.data.skipped,
    });
  };

  if (scanning) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
        <MapSpinner size={18} />
        <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
          正在扫描 {repo.fullName}@{branch} 的目录…
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          已用时 {elapsed}s，大仓库通常 3~10 秒；扫完会自动勾上所有 doc / docs 目录
        </div>
      </div>
    );
  }

  if (!scan) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>目录没扫出来</span>
        <Button variant="ghost" size="xs" onClick={() => void runScan()}><RefreshCw size={12} /> 重试</Button>
      </div>
    );
  }

  const visiblePaths = visible.map((d) => d.path);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="过滤目录路径"
            className="prd-field w-full h-8 pl-8 pr-3 rounded-[10px] text-[12px] outline-none" />
        </div>
        <Button variant="ghost" size="xs" onClick={() => setSelected((prev) => setSelection(prev, visiblePaths, true))}>
          全选
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setSelected((prev) => setSelection(prev, visiblePaths, false))}>
          清空
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setSelected(defaultSelection(scan))}>
          恢复默认
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-[240px] rounded-[12px] py-1"
        style={{ border: '1px solid var(--border-subtle)' }}>
        {tree.length === 0 ? (
          <div className="py-12 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配的目录</div>
        ) : (
          tree.map((node) => (
            <DirectoryRow key={node.path} node={node} depth={0} selected={selected}
              onToggle={(path) => setSelected((prev) => toggleSelection(prev, path))} />
          ))
        )}
      </div>

      <div className="flex items-center justify-between mt-3">
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          已勾 <span style={{ color: 'var(--accent-fg-violet)', fontWeight: 600 }}>{summary.directoryCount}</span> 个目录，
          约 <span style={{ color: 'var(--accent-fg-violet)', fontWeight: 600 }}>{summary.markdownCount}</span> 篇 Markdown
          {scan.truncated && <span>（仓库目录过多，只列出了前 {scan.directories.length} 个）</span>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" onClick={onBack}>上一步</Button>
          <Button variant="primary" size="xs" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <MapSpinner size={12} /> : null}
            {submitting ? '正在开启…' : '开启同步'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DirectoryRow({ node, depth, selected, onToggle }: {
  node: DirectoryTreeNode;
  depth: number;
  selected: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const checked = selected.has(node.path);
  return (
    <>
      <button onClick={() => onToggle(node.path)}
        className="hover-bg-soft w-full flex items-center gap-2 py-1.5 pr-3 text-left cursor-pointer transition-colors duration-200"
        style={{ paddingLeft: 12 + depth * 16 }}>
        <span className="w-[14px] h-[14px] rounded-[4px] flex items-center justify-center shrink-0 transition-all duration-200"
          style={{
            background: checked ? `rgba(${ACCENT},0.9)` : 'transparent',
            border: checked ? `1px solid rgba(${ACCENT},0.9)` : '1px solid var(--border-strong)',
          }}>
          {checked && <Check size={10} style={{ color: 'var(--bg-elevated)' }} />}
        </span>
        <Folder size={12} style={{ color: node.recommended ? 'var(--accent-fg-violet)' : 'var(--text-muted)' }} />
        <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
          {directoryLabel(node)}
        </span>
        {node.recommended && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-[6px] shrink-0"
            style={{ background: `rgba(${ACCENT},0.1)`, color: 'var(--accent-fg-violet)' }}>
            默认同步
          </span>
        )}
        {node.markdownCount > 0 && (
          <span className="text-[11px] shrink-0 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            <FileText size={10} /> {node.markdownCount}
          </span>
        )}
      </button>
      {node.children.map((child) => (
        <DirectoryRow key={child.path} node={child} depth={depth + 1} selected={selected} onToggle={onToggle} />
      ))}
    </>
  );
}

/** 第四步：结果。说清建了什么、跳过了什么、接下来会发生什么。 */
function DoneStep({ result, repoFullName, branch, onClose }: {
  result: BatchResult;
  repoFullName: string;
  branch: string;
  onClose: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle2 size={16} style={{ color: 'var(--accent-fg-success)' }} />
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          已为 {repoFullName}@{branch} 开启 {result.createdCount} 个目录的同步
        </span>
      </div>

      <p className="text-[12px] leading-[1.7] mb-3" style={{ color: 'var(--text-muted)' }}>
        后台会在 2 分钟内开始首次拉取，之后每天自动同步一次。
        同步期间条目显示「同步中」，拉完就能在文件树里看到这些文档。
      </p>

      <div className="rounded-[12px] overflow-hidden mb-3" style={{ border: '1px solid var(--border-subtle)' }}>
        {result.created.map((item) => (
          <div key={item.id} className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <Folder size={12} style={{ color: 'var(--accent-fg-violet)' }} />
            <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
              {item.path === '' ? '仓库根目录' : item.path}
            </span>
          </div>
        ))}
      </div>

      {result.skipped.length > 0 && (
        <div className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          跳过 {result.skipped.length} 个目录（此前已订阅过，重复勾选不会建重复条目）
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="primary" size="xs" onClick={onClose}>完成</Button>
      </div>
    </div>
  );
}
