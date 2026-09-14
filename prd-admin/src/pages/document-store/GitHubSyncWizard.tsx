import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Github, X, Check, Search, RefreshCw, Copy, ExternalLink,
  Folder, FileText, Lock, ChevronRight, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getGitHubAuthStatus, startGitHubDeviceFlow, pollGitHubDeviceFlow, disconnectGitHub,
  listGitHubRepositories, listGitHubBranches, scanGitHubDocDirectories,
  type GitHubAuthStatus, type GitHubDeviceFlowStart, type GitHubRepository,
  type GitHubBranch, type GitHubDirectoryScan,
} from '@/services/real/githubConnect';
import { addGitHubSubscriptionBatch } from '@/services/real/documentStore';
import {
  buildDirectoryTree, defaultSelection, defaultExpanded, toggleSelection, setSelection,
  selectionSummary, filterDirectories, directoryLabel, chunkDirectories,
  type DirectoryTreeNode,
} from './githubDirectorySelection';
import { isGitHubConnectionBroken, connectionBrokenHint } from './githubConnectionState';

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
  /** 出错时的后端错误码——据此判断这条错误是不是「连接本身坏了」，要不要给重连出口 */
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  /** 「换个账号 / 重新连接」按下之后：留在第一步重新授权，期间不把旧连接删掉 */
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [picked, setPicked] = useState<{ repo: GitHubRepository; branch: string } | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);

  /** 步骤里出错统一走这里：文案给用户看，错误码留给下面判断要不要给重连出口 */
  const reportError = useCallback((message: string, code?: string) => {
    setError(message);
    setErrorCode(code);
  }, []);

  /**
   * 存着的 token 已经失效时（换了账号、撤销了授权、token 过期），
   * 状态接口仍然报「已连接」，向导会直接跳到选仓库然后一路报错——用户在这里是死路，
   * 既退不回第一步也没法重新授权。所以凡是连接类错误都给一个出口：断开 + 回到第一步重连。
   */
  const reconnect = useCallback(() => {
    // 不先断开：Device Flow 成功后是按 userId upsert 落库（同一用户覆盖旧连接），
    // 所以「换个账号」只需要退回第一步重新授权。先删再授权的话，用户中途关掉向导
    // 就把连接弄没了——而已建的目录订阅（盖着 github_connection_user_id）和其它
    // GitHub 功能共用这一条记录，会一起变成未连接，且没有任何东西提示他这件事。
    setSwitchingAccount(true);
    setError('');
    setErrorCode(undefined);
    setStep('connect');
  }, []);

  /**
   * 真正断开：把存着的连接（含 token 密文）删掉。
   * 这是这一屏承诺的「令牌加密保存在你名下，随时可以断开」的兑现处——
   * 「换个账号」不做删除（授权成功才替换），所以断开必须另有入口，否则那句话是空头支票。
   * 破坏性动作，由调用处做二次确认。
   */
  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    const res = await disconnectGitHub();
    setDisconnecting(false);
    if (!res.success) {
      reportError(res.error?.message ?? '断开 GitHub 连接失败', res.error?.code);
      return;
    }
    setAuth(null);
    setSwitchingAccount(false);
    setError('');
    setErrorCode(undefined);
    setStep('connect');
    toast.success('已断开 GitHub 连接', '已存的访问令牌一并删除；已建的目录订阅会同步失败，直到重新连接。');
  }, [reportError]);

  const loadAuth = useCallback(async () => {
    setAuthLoading(true);
    const res = await getGitHubAuthStatus();
    if (res.success) {
      setAuth(res.data);
      // 已连接就直接跳到选仓库，不让用户在一个「已完成」的步骤上多点一次
      setStep((prev) => (prev === 'connect' && res.data.connected ? 'repo' : prev));
    } else {
      reportError(res.error?.message ?? '读取 GitHub 连接状态失败', res.error?.code);
    }
    setAuthLoading(false);
  }, [reportError]);

  useEffect(() => { void loadAuth(); }, [loadAuth]);

  // ESC 关闭（frontend-modal 的硬性清单之一）。只用键盘的人否则没有退出这个全屏向导的办法——
  // 现有出口只有标题栏的关闭按钮和点蒙版，两者都要鼠标。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // frontend-modal.md 三条物理约束：尺寸走 inline style、createPortal 挂 body、滚动容器 minHeight:0
  const wizard = (
    // z-[200]：移动端 MobileTabBar 是 fixed z-100，z-50 会被它压在下面，
    // 底部那排「上一步 / 开启同步」正好落在 tab bar 的位置上，点不到。
    <div className="surface-backdrop fixed inset-0 z-[200] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover rounded-[16px] p-6 flex flex-col"
        style={{ width: 720, maxWidth: '94vw', maxHeight: '88vh', minHeight: 0 }}>
        <Header step={step} onClose={onClose} login={auth?.connected ? auth.login ?? null : null}
          onSwitchAccount={reconnect} switching={switchingAccount}
          onDisconnect={() => void disconnect()} disconnecting={disconnecting} />

        {error && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-[10px]"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.16)' }}>
            <AlertCircle size={14} style={{ color: 'var(--accent-fg-error)', marginTop: 1 }} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px]" style={{ color: 'var(--accent-fg-error)' }}>{error}</div>
              {isGitHubConnectionBroken(errorCode) && (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {connectionBrokenHint(errorCode)}
                  </span>
                  <Button variant="ghost" size="xs" disabled={switchingAccount} onClick={reconnect}>
                    <Github size={11} />
                    {switchingAccount ? '请在第一步重新授权' : '重新连接 GitHub'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {authLoading ? (
          <div className="flex items-center justify-center gap-2 py-16">
            <MapSpinner size={14} />
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取 GitHub 连接状态…</span>
          </div>
        ) : step === 'connect' ? (
          <ConnectStep
            oauthConfigured={auth?.oauthConfigured !== false}
            replacingLogin={switchingAccount && auth?.connected ? auth.login ?? null : null}
            onConnected={() => { setError(''); setErrorCode(undefined); setSwitchingAccount(false); void loadAuth(); setStep('repo'); }}
            onError={reportError} />
        ) : step === 'repo' ? (
          <RepoStep
            onSelected={(repo, branch) => { setError(''); setErrorCode(undefined); setPicked({ repo, branch }); setStep('directories'); }}
            onError={reportError}
          />
        ) : step === 'directories' && picked ? (
          <DirectoriesStep
            storeId={storeId}
            repo={picked.repo}
            branch={picked.branch}
            onBack={() => setStep('repo')}
            onCommitted={onFinished}
            onError={reportError}
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

  return createPortal(wizard, document.body);
}

/** 顶部标题 + 步骤指示（让用户任何时候知道自己在第几步、还剩几步） */
function Header({ step, login, onClose, onSwitchAccount, switching, onDisconnect, disconnecting }: {
  step: Step; login: string | null; onClose: () => void;
  onSwitchAccount: () => void; switching: boolean;
  onDisconnect: () => void; disconnecting: boolean;
}) {
  /** 断开是破坏性的（token 密文直接删掉），点一次先要个确认，再点才真断 */
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
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
              <div className="flex items-center gap-1.5">
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已连接 {login}</span>
                <button onClick={onSwitchAccount} disabled={switching || disconnecting}
                  className="text-[11px] underline cursor-pointer bg-transparent border-0 p-0"
                  style={{ color: 'var(--text-muted)' }}>
                  {switching ? '正在重新授权' : '换个账号'}
                </button>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>·</span>
                <button
                  onClick={() => { if (confirmDisconnect) onDisconnect(); else setConfirmDisconnect(true); }}
                  onBlur={() => setConfirmDisconnect(false)}
                  disabled={disconnecting}
                  className="text-[11px] underline cursor-pointer bg-transparent border-0 p-0"
                  style={{ color: confirmDisconnect ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>
                  {disconnecting ? '正在断开…' : confirmDisconnect ? '确认断开？已建订阅会同步失败' : '断开连接'}
                </button>
              </div>
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
function ConnectStep({ oauthConfigured, replacingLogin, onConnected, onError }: {
  /** 管理员配没配 GitHub 应用。没配时点「连接」只会失败，得当场说清而不是让用户空点 */
  oauthConfigured: boolean;
  /** 「换个账号」进来时当前还连着谁——要让用户知道旧连接此刻仍然有效，授权成功才会被替换 */
  replacingLogin?: string | null;
  onConnected: () => void;
  onError: (msg: string, code?: string) => void;
}) {
  const [flow, setFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'denied' | 'expired'>('idle');
  const pollRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  /** 卸载标记：向导被关掉时，在途的那一发轮询回来后不许再排下一发 */
  const abandonedRef = useRef(false);

  const stopTimers = useCallback(() => {
    if (pollRef.current) { window.clearTimeout(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  useEffect(() => () => { abandonedRef.current = true; stopTimers(); }, [stopTimers]);

  const start = async () => {
    setStarting(true);
    onError('');
    // 先同步开一个空白页再去发请求：浏览器只在「这次点击」的用户激活窗口内允许开新标签页，
    // 等请求回来再 open 通常会被拦截——而界面上写着「在刚打开的 GitHub 页面粘贴配对码」，
    // 用户看着一句不存在的事实发愣。被拦截（返回 null）也不影响主流程：配对码和
    // 「重新打开授权页」按钮都在界面上。
    // 注意不能带 noopener：带了 window.open 按规范返回 null，就拿不到这个页签去导航了。
    // 改为拿到句柄后立刻断开 opener，隔离效果相同。
    const authTab = window.open('about:blank', '_blank');
    if (authTab) authTab.opener = null;
    const res = await startGitHubDeviceFlow();
    // 发起请求在路上时向导被关掉：清理函数比这两个定时器先跑，之后再建就没人清了，
    // 计时器会连同整个闭包一直留着。轮询那侧的守卫只在第一次请求回来后才生效，够不到这一段。
    if (abandonedRef.current) { authTab?.close(); return; }
    setStarting(false);
    if (!res.success) {
      authTab?.close(); // 发起就失败了，别给用户留一个空白页
      onError(res.error?.message ?? '发起 GitHub 授权失败', res.error?.code);
      return;
    }

    setFlow(res.data);
    setPhase('waiting');
    setRemaining(res.data.expiresInSeconds);
    const authUrl = res.data.verificationUriComplete || res.data.verificationUri;
    if (authTab && !authTab.closed) authTab.location.href = authUrl;
    else window.open(authUrl, '_blank', 'noopener'); // 没开成（被拦或被关）就再试一次，失败也有手动按钮兜底

    tickRef.current = window.setInterval(() => {
      setRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    const intervalMs = Math.max(res.data.intervalSeconds, 5) * 1000;
    const poll = async (delay: number) => {
      pollRef.current = window.setTimeout(async () => {
        const p = await pollGitHubDeviceFlow(res.data.flowToken);
        // 关掉向导时清的是「已经排好的那一发」；这一发正在路上，回来时组件可能已经没了。
        // 不拦住的话，它会继续排下一发，直到配对码过期——期间还可能在用户已经离开之后
        // 把连接落库并弹一个成功提示。
        if (abandonedRef.current) return;
        if (!p.success) {
          stopTimers();
          setPhase('idle');
          onError(p.error?.message ?? 'GitHub 授权轮询失败', p.error?.code);
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
    <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
      <p className="text-[12px] leading-[1.7] mb-4" style={{ color: 'var(--text-muted)' }}>
        连接你自己的 GitHub 账号后，就能同步你有权限的仓库（含私有仓）。授权只对你生效，
        令牌加密保存在你名下，随时可以断开。
      </p>

      {phase === 'waiting' && flow ? (
        <div className="rounded-[12px] p-4" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-subtle)' }}>
          <div className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
            在打开的 GitHub 页面粘贴这个配对码（没自动打开就点下面的「重新打开授权页」）：
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
      ) : !oauthConfigured ? (
        <div className="rounded-[12px] p-4"
          style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
            <AlertCircle size={13} style={{ color: 'var(--accent-fg-warning)' }} />
            管理员尚未配置 GitHub 应用
          </div>
          <div className="text-[11.5px] leading-[1.7]" style={{ color: 'var(--text-muted)' }}>
            连接 GitHub 需要管理员先在服务端配置 GitHub 应用的 Client ID 与密钥。
            在此之前这一步无法完成——请联系管理员配置后再来。
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          {replacingLogin && (
            <div className="text-[11.5px] text-center leading-[1.7]" style={{ color: 'var(--text-muted)' }}>
              当前连接的是 {replacingLogin}，它现在仍然有效。
              新账号授权成功后才会替换它；直接关掉向导不会断开现有连接。
            </div>
          )}
          <Button variant="primary" size="sm" onClick={() => void start()} disabled={starting}>
            {starting ? <MapSpinner size={12} /> : <Github size={13} />}
            {starting ? '正在发起授权…' : replacingLogin ? '用另一个账号授权' : '连接 GitHub 账号'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 第二步：选仓库 + 分支。仓库地址由系统列出来，用户不必去 GitHub 复制 URL。 */
function RepoStep({ onSelected, onError }: {
  onSelected: (repo: GitHubRepository, branch: string) => void;
  onError: (msg: string, code?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  // 后端按 GitHub 分页返回（默认每页 30），搜索也只在已取回的这些里过滤。
  // 仓库多于一页的用户，光靠第一页找不到目标仓库，主流程就断在这里，所以要能继续加载。
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [active, setActive] = useState<GitHubRepository | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [branchLoading, setBranchLoading] = useState(false);
  /** 分支请求发号器：只认最新一发的结果（轮询/并发请求的 stale-response 守卫） */
  const branchSeqRef = useRef(0);
  /** 当前搜索词的镜像：在途的「加载更多」用它判断自己是不是已经过期 */
  const queryRef = useRef(query);
  useEffect(() => { queryRef.current = query; }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const res = await listGitHubRepositories(query || undefined, 1, 30);
      if (cancelled) return;
      if (res.success) {
        // 这一发成功就把上一次的失败收掉：否则用户改个搜索词重试成功了，
        // 头顶那条红色错误条还挂着，他不知道到底好没好（下面两处同理）。
        onError('');
        setRepos(res.data.items);
        setPage(1);
        setHasMore(res.data.hasMore);
      } else {
        onError(res.error?.message ?? '读取仓库列表失败', res.error?.code);
      }
      setLoading(false);
    }, query ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, onError]);

  const loadMore = async () => {
    setLoadingMore(true);
    const next = page + 1;
    // 记住这一发是给哪个关键词取的：用户在等待期间改了搜索词，这一发就作废。
    // 否则 A 的第二页会被追加到 B 的第一页后面（列表里混进不匹配的仓库），
    // 页码也被推到 2，B 的第二页从此被跳过。
    const forQuery = query;
    const res = await listGitHubRepositories(query || undefined, next, 30);
    setLoadingMore(false); // 先收掉加载态，作废的那一发也不能让按钮一直转
    if (forQuery !== queryRef.current) return; // 搜索词已改，这一发作废
    if (!res.success) {
      onError(res.error?.message ?? '读取更多仓库失败', res.error?.code);
      return;
    }
    onError('');
    // 按 id 去重：GitHub 分页期间仓库排序可能变动，避免出现重复行
    setRepos((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [...prev, ...res.data.items.filter((r) => !seen.has(r.id))];
    });
    setPage(next);
    setHasMore(res.data.hasMore);
  };

  const pick = async (repo: GitHubRepository) => {
    setActive(repo);
    setBranch(repo.defaultBranch ?? 'main');
    // 先清空：连点两个仓库时，慢的那一发回来会把上一个仓库的分支灌进选择器，
    // 用户挑一个「看起来存在」的分支去扫，扫的却是另一个仓库里根本没有的分支。
    setBranches([]);
    branchSeqRef.current += 1;
    const my = branchSeqRef.current;
    setBranchLoading(true);
    const res = await listGitHubBranches(repo.owner, repo.repo);
    if (my !== branchSeqRef.current) return; // 已经换了仓库，这一发过期，丢弃
    setBranchLoading(false);
    if (res.success) {
      onError('');
      setBranches(res.data.items);
    } else {
      onError(res.error?.message ?? '读取分支失败', res.error?.code);
    }
  };

  return (
    <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索仓库名"
          className="prd-field w-full h-9 pl-8 pr-3 rounded-[10px] text-[13px] outline-none" />
      </div>

      <div className="flex-1 overflow-y-auto rounded-[12px]"
        style={{ border: '1px solid var(--border-subtle)', minHeight: 0, maxHeight: '46vh' }}>
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
        {!loading && hasMore && (
          <button onClick={() => void loadMore()} disabled={loadingMore}
            className="hover-bg-soft w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] cursor-pointer"
            style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
            {loadingMore ? <MapSpinner size={12} /> : null}
            {loadingMore ? '正在加载…' : '加载更多仓库'}
          </button>
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
function DirectoriesStep({ storeId, repo, branch, onBack, onDone, onCommitted, onError }: {
  storeId: string;
  repo: GitHubRepository;
  branch: string;
  onBack: () => void;
  onDone: (result: BatchResult) => void;
  /** 有批次已落库（哪怕整体失败）就调一次，让页面把新条目拉出来 */
  onCommitted: () => void;
  onError: (msg: string, code?: string) => void;
}) {
  const [scan, setScan] = useState<GitHubDirectoryScan | null>(null);
  const [scanning, setScanning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** 展开的目录（默认只展开通往已勾选目录的那几条链，几百个目录不全摊开） */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['']));
  const [keyword, setKeyword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** 分批提交时的进度（只有超过一批才显示，免得一批也弹个「1/1」） */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * 这一步已经离开：在途的分批提交回来后不许再改向导的步骤。
   * 否则用户在提交期间退回上一步、换了个仓库，旧的那一发完成时会把向导推到完成页，
   * 而完成页上写的是新仓库的名字——用旧结果配新标题。
   */
  const leftStepRef = useRef(false);
  useEffect(() => () => { leftStepRef.current = true; }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    setElapsed(0);
    // 重试前先把上一次的错误条收掉：不清的话，重试成功后目录树是好的，
    // 头上却仍挂着一条红色「扫描失败」，甚至还带着一个此刻毫无意义的「重新连接 GitHub」。
    onError('');
    const res = await scanGitHubDocDirectories(repo.owner, repo.repo, branch);
    setScanning(false);
    if (!res.success) {
      onError(res.error?.message ?? '扫描仓库目录失败', res.error?.code);
      return;
    }
    setScan(res.data);
    const initial = defaultSelection(res.data);
    setSelected(initial);
    setExpanded(defaultExpanded(res.data.directories, initial));
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
  // 搜索时把命中结果全展开——否则用户搜到了却看不见（结果藏在折叠的父目录里）
  const effectiveExpanded = useMemo(
    () => (keyword.trim() ? new Set(visible.map((d) => d.path)) : expanded),
    [keyword, visible, expanded],
  );
  const summary = useMemo(
    () => selectionSummary(scan?.directories ?? [], selected),
    [scan, selected],
  );

  const submit = async () => {
    if (summary.directoryCount === 0) {
      onError('至少要勾选一个目录');
      return;
    }
    // 后端一次最多收 50 个目录，超过就分批提交——否则 monorepo 勾完默认项直接被 400 挡下，
    // 而界面上并没有「分批」这个操作可给用户做。重复提交是幂等的（已订阅的走 skipped）。
    const chunks = chunkDirectories([...selected]);
    setSubmitting(true);
    setProgress(chunks.length > 1 ? { done: 0, total: chunks.length } : null);
    onError('');

    const merged: BatchResult = { createdCount: 0, created: [], skipped: [] };
    for (let i = 0; i < chunks.length; i++) {
      const res = await addGitHubSubscriptionBatch(storeId, {
        owner: repo.owner,
        repo: repo.repo,
        branch,
        directories: chunks[i].map((path) => ({ path })),
      });
      if (!res.success) {
        setSubmitting(false);
        setProgress(null);
        // 已落库的那部分仍要让页面知道（条目是真建了），但不再往向导里写任何错误或步骤
        onCommitted();
        if (leftStepRef.current) return;
        const base = res.error?.message ?? '开启同步失败';
        // 前面几批可能已经建好了，必须说清楚——否则用户以为一个都没成
        onError(
          merged.createdCount > 0
            ? `${base}（已开启 ${merged.createdCount} 个目录，其余未开启；再点一次会跳过已开启的继续）`
            : base,
          res.error?.code,
        );
        return;
      }
      merged.createdCount += res.data.createdCount;
      merged.created.push(...res.data.created);
      merged.skipped.push(...res.data.skipped);
      setProgress(chunks.length > 1 ? { done: i + 1, total: chunks.length } : null);
    }

    setSubmitting(false);
    setProgress(null);
    // 用户在提交期间退回上一步（甚至换了仓库）：条目已经建好，让页面刷新，
    // 但不把向导推回完成页——那一屏会用当前选中的仓库名去标旧结果。
    if (leftStepRef.current) { onCommitted(); return; }
    onDone(merged);
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
        <div className="flex items-center gap-2">
          {/* 分支被删/改名这类原因，重试多少次都是同一个结果——必须能退回去换仓库或分支 */}
          <Button variant="ghost" size="xs" onClick={onBack}>上一步（换仓库或分支）</Button>
          <Button variant="ghost" size="xs" onClick={() => void runScan()}><RefreshCw size={12} /> 重试</Button>
        </div>
      </div>
    );
  }

  const visiblePaths = visible.map((d) => d.path);

  return (
    <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
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

      <div className="flex-1 overflow-y-auto rounded-[12px] py-1"
        style={{ border: '1px solid var(--border-subtle)', minHeight: 0, maxHeight: '46vh' }}>
        {tree.length === 0 ? (
          <div className="py-12 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配的目录</div>
        ) : (
          tree.map((node) => (
            <DirectoryRow key={node.path} node={node} depth={0} selected={selected}
              expanded={effectiveExpanded}
              onToggle={(path) => setSelected((prev) => toggleSelection(prev, path))}
              onExpand={(path) => setExpanded((prev) => toggleSelection(prev, path))} />
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
          {/* 提交期间禁掉返回：在途的批次还在建条目，这时换仓库会让两边对不上 */}
          <Button variant="ghost" size="xs" onClick={onBack} disabled={submitting}>上一步</Button>
          <Button variant="primary" size="xs" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <MapSpinner size={12} /> : null}
            {submitting
              ? (progress ? `正在开启… 第 ${progress.done + 1}/${progress.total} 批` : '正在开启…')
              : '开启同步'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DirectoryRow({ node, depth, selected, expanded, onToggle, onExpand }: {
  node: DirectoryTreeNode;
  depth: number;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
}) {
  const checked = selected.has(node.path);
  const isOpen = expanded.has(node.path);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div className="hover-bg-soft w-full flex items-center gap-1 pr-3 transition-colors duration-200"
        style={{ paddingLeft: 6 + depth * 16 }}>
        <button
          onClick={() => hasChildren && onExpand(node.path)}
          aria-label={hasChildren ? (isOpen ? '折叠' : '展开') : undefined}
          className="w-4 h-4 flex items-center justify-center shrink-0"
          style={{ cursor: hasChildren ? 'pointer' : 'default', color: 'var(--text-muted)' }}>
          {hasChildren && (
            <ChevronRight size={12} style={{
              transform: isOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 160ms ease',
            }} />
          )}
        </button>
      <button onClick={() => onToggle(node.path)}
        className="flex-1 min-w-0 flex items-center gap-2 py-1.5 text-left cursor-pointer">
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
      </div>
      {isOpen && node.children.map((child) => (
        <DirectoryRow key={child.path} node={child} depth={depth + 1} selected={selected}
          expanded={expanded} onToggle={onToggle} onExpand={onExpand} />
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
    <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
      <div className="flex items-center gap-2 mb-3">
        <CheckCircle2 size={16} style={{ color: 'var(--accent-fg-success)' }} />
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          已为 {repoFullName}@{branch} 开启 {result.createdCount} 个目录的同步
        </span>
      </div>

      <p className="text-[12px] leading-[1.7] mb-3" style={{ color: 'var(--text-muted)' }}>
        后台每隔两分钟扫一批待同步的条目，每批最多 20 个——目录勾得多时会排队分几批陆续开始，
        之后每天自动同步一次。
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>页面不会自动刷新</span>
        ：过一会儿手动刷新一下，就能看到条目从「同步中」变成拉好的文档。
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
