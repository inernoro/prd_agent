import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, GitBranch, Loader2, RefreshCw, RotateCw, ShieldCheck, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, Section } from '../components';

interface BranchMeta {
  name: string;
  committerDate: string;
  commitHash: string;
  subject: string;
  cdsTouched: boolean;
}

interface SelfBranchesResponse {
  current: string;
  commitHash: string;
  currentCommitterDate?: string;
  branches: string[];
  branchDetails?: BranchMeta[];
}

/** GET /api/self-status — CDS 自更新可见性面板用 */
interface SelfUpdateRecord {
  ts: string;
  branch: string;
  fromSha: string;
  toSha: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  status: 'success' | 'failed' | 'aborted';
  durationMs?: number;
  error?: string;
  actor?: string;
  /** 用户反馈 2026-05-06 — 让用户看到走了哪种更新模式。
   *  hot-reload = 跳过 validate(节省 50s)+ systemd 软重启,~15-25s。
   *               改动只涉及应用代码(.ts/.tsx),且未触及依赖/配置/路由 schema。
   *  restart    = 完整 validate + systemd 重启,~70-95s。
   *               改了依赖/Dockerfile/tsconfig/.env/路由表/types schema 等。
   *  noOp       = HEAD 已是 .build-sha 的版本,啥都没做(~3s)
   */
  updateMode?: 'hot-reload' | 'restart' | 'noOp';
  noOp?: boolean;
}

interface SystemdUnitDrift {
  repoHash: string;
  installedHash: string;
  installedAt?: string;
}

/** 用户反馈 2026-05-06:中间面板不知道别 session/webhook 触发的 self-update。
 *  backend 暴露 in-progress 标记,任何 tab 打开都能立刻显示"正在重启"。 */
interface ActiveSelfUpdate {
  startedAt: string;
  branch: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  actor?: string;
  step?: string;
}

interface SelfStatusResponse {
  currentBranch: string;
  headSha: string;
  headIso: string;
  fetchOk: boolean;
  fetchError?: string;
  remoteAheadCount: number;
  localAheadCount: number;
  remoteAheadSubjects: Array<{ sha: string; subject: string; date: string }>;
  /** 非空表示后端正在跑 self-update / self-force-sync(任一 session 触发) */
  activeSelfUpdate?: ActiveSelfUpdate | null;
  /** 仓库里的 systemd unit 文件 vs 已安装的 /etc/systemd/system/cds-master.service
   *  归一化后比对 hash 不一致时填,提示 operator 一行命令重装。 */
  systemdUnitDrift?: SystemdUnitDrift | null;
  lastSelfUpdate: SelfUpdateRecord | null;
  selfUpdateHistory: SelfUpdateRecord[];
}

type SelfStatusState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SelfStatusResponse };

interface DryRunResponse {
  ok: boolean;
  summary?: string;
  durationMs?: number;
  stage?: string;
  error?: string;
  hint?: string;
}

type BranchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SelfBranchesResponse };

type UpdateRunState = 'idle' | 'running' | 'success' | 'error';

function parseSseBlock(raw: string): { event: string; data: unknown } | null {
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!raw.trim()) return null;
  if (!data) return { event, data: null };
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

/** 格式化相对时间(N 分钟前 / N 小时前 / N 天前)— branch picker 时间列用。 */
function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return '刚才';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/** "1.3s" / "12s" / "1m23s" / "2m05s" — runStartedAt 倒数用 */
function formatElapsed(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  if (totalSec < 60) return `${Math.floor(totalSec)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function eventTitle(event: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.title === 'string') return obj.title;
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.step === 'string') return String(obj.step);
  }
  if (typeof data === 'string') return data;
  return event;
}

/**
 * Self-update 后等新进程起来 + 强制刷新页面。
 *
 * 后端的 /api/self-update 在发完 SSE 'done' 后做 `setTimeout(process.exit, 1000)`;
 * 老进程释放端口大约要 1-3s,新进程 build + 起来大约 5-30s(看是否需要重新 pnpm install)。
 *
 * 我们等 1.5s 让老进程退出,然后开始轮询 /healthz,每 1s 一次。
 * 第一次 200 = 新进程起来了 → window.location.reload() 加载新 bundle。
 * 60s 内还没起来 → toast 警告 + 不强行 reload(避免在死循环重启时反复刷新)。
 *
 * 注意:轮询期间老进程可能仍然在响应(还没真正 process.exit),会导致连续多次
 * 200 都是老的。所以我们对比 /healthz 响应里的 commit hash:必须看到 hash 变了
 * 才算新进程起来。但 /healthz 默认不返 commit hash,这里走 /api/self-status 的
 * commitHash 字段对比(自更新后必然变,因为 git reset 切了 ref)。
 */
async function waitForRestartAndReload(
  onToast: (message: string) => void,
  appendRunLine: (line: string) => void,
): Promise<void> {
  // 1. 在轮询前先记录"当前 commit"(老进程 process.exit 之前能拿到)
  let preRestartCommit = '';
  try {
    const pre = await fetch('/api/self-status', { credentials: 'include' });
    if (pre.ok) {
      const json = await pre.json();
      preRestartCommit = String(json?.headSha || '');
    }
  } catch {
    // 拿不到也没事,fallback 走 healthz 200 计数兜底
  }

  // 2. 等老进程释放端口
  await new Promise((r) => setTimeout(r, 1500));

  // 3. 轮询 /api/self-status 直到看到 commit 变化(或超时)
  const startedAt = Date.now();
  // 2026-05-04 v4(用户反馈"等了一会儿显示重启失败"):
  // 60s → 180s。daemon 启动时 cds_start_background 跑 build_ts(~30-60s) +
  // build_web(~30-60s,即使我们 in-process 已 build 过,daemon 那边可能再跑
  // 一遍 — 因为 .build-sha 我们写的是新的所以应该 skip,但有 race window)
  // + node 起来 + 端口 bind。180s 是 P99 上限。
  const TIMEOUT_MS = 180_000;
  const POLL_INTERVAL_MS = 1500;
  // 2026-05-04 v5 fix(用户反馈"页面迟迟不动 + 没自动刷新"):
  // 旧逻辑只在 commit 变了 OR preRestartCommit 为空时 reload。
  // 但当用户对**同一个 commit** 触发 self-update(GitHub 没新代码),
  // preRestartCommit === nowCommit 永远成立,reload 永远不触发,卡 180s。
  //
  // 新策略:**观察到 downtime 后再回归 reachable** = 重启确实发生过 → reload。
  // 这样:
  //   - commit 变了 → reload(快路径,优先)
  //   - commit 没变但确实重启过 → reload(看 sawDowntime)
  //   - 一直 reachable(从未中断)→ 没真正重启,可能是 abort/no-op → 不 reload
  let firstReachable = 0;
  let sawDowntime = false;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    try {
      const r = await fetch('/api/self-status', { credentials: 'include', cache: 'no-store' });
      if (r.ok) {
        const json = await r.json().catch(() => null);
        const nowCommit = String(json?.headSha || '');
        // 快路径:commit 真的变了 → 立即 reload
        if (preRestartCommit && nowCommit && nowCommit !== preRestartCommit) {
          appendRunLine(`新进程已就绪(${preRestartCommit} → ${nowCommit}),3s 后自动刷新页面`);
          onToast('CDS 已重启完成,即将刷新页面');
          await new Promise((r) => setTimeout(r, 3000));
          window.location.reload();
          return;
        }
        if (!firstReachable) firstReachable = Date.now();
        // 慢路径:commit 没变,但中间确实经历过 downtime(curl 失败过) → 真重启了
        // 等连续 reachable 5s,确保新进程稳了再 reload
        if (sawDowntime && Date.now() - firstReachable > 5000) {
          appendRunLine(`CDS 已重启完成(commit 未变,但确实经历了 downtime),3s 后自动刷新页面`);
          onToast('CDS 已重启完成,即将刷新页面');
          await new Promise((r) => setTimeout(r, 3000));
          window.location.reload();
          return;
        }
        // 兜底:没拿到 preCommit + reachable 5s+ → 假定重启过(老兜底)
        if (Date.now() - firstReachable > 5000 && !preRestartCommit) {
          appendRunLine('CDS 已就绪(commit 对比信息缺失),自动刷新页面');
          onToast('CDS 已就绪,即将刷新页面');
          await new Promise((r) => setTimeout(r, 1500));
          window.location.reload();
          return;
        }
      } else {
        sawDowntime = true;        // 4xx/5xx 也算 downtime(restart 期间常见 502)
        firstReachable = 0;
      }
    } catch {
      sawDowntime = true;          // 网络错误 / 进程没起 = 真 downtime
      firstReachable = 0;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // 超时:可能老进程没退出,或新进程崩了
  appendRunLine(`${TIMEOUT_MS / 1000}s 内未观察到 CDS 重启完成,请手动刷新页面验证`);
  appendRunLine('排查日志:');
  appendRunLine('  · CDS 主日志:cds/cds.log (./exec_cds.sh logs)');
  appendRunLine('  · self-update 子进程错误:cds/.cds/self-update-error.log');
  appendRunLine('  · web build 日志:cds/.cds/web-build.log');
  onToast('重启可能未生效 — 请手动刷新页面 + 检查 ./exec_cds.sh logs');
}

async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${path} -> ${response.status}`);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSseBlock(block);
        if (parsed) onEvent(parsed.event, parsed.data);
        index = buffer.indexOf('\n\n');
      }
    }
    if (done) break;
  }
}

export function MaintenanceTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [branchState, setBranchState] = useState<BranchState>({ status: 'loading' });
  // 2026-05-04 重构(用户反馈):删掉 branchQuery + selectedBranch 双 state,
  // 改为单一 selectedBranch state。combobox input value === selectedBranch,
  // 用户输入即"选择",杜绝"搜了但实际发的还是旧 branch"的核心 bug。
  // 显示 dropdown 只是过滤候选项,不再独立 state。
  const [selectedBranch, setSelectedBranch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [runState, setRunState] = useState<UpdateRunState>('idle');
  const [runTitle, setRunTitle] = useState('');
  const [runLog, setRunLog] = useState<string[]>([]);
  // 2026-05-04 v7(用户:'添加前端计时器,我倒要看看重启了多长时间')
  // runStartedAt:点更新时记 ms 时间戳;runEndedAt:done/error/reload 时记停。
  // tickClock 强制每 250ms 重渲染让 elapsed 实时跳秒。
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  const [, setTickClock] = useState(0);
  useEffect(() => {
    if (runState !== 'running') return;
    const t = window.setInterval(() => setTickClock(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [runState]);
  const elapsedRunMs = runStartedAt
    ? (runEndedAt ?? Date.now()) - runStartedAt
    : 0;
  // 2026-05-04 新增:CDS 自更新可见性面板状态(用户:"我不清楚是否有自动更新")
  const [selfStatus, setSelfStatus] = useState<SelfStatusState>({ status: 'loading' });
  const [historyOpen, setHistoryOpen] = useState(false);

  // ⚠ 2026-05-06 用户反馈"中间没更新左下角在动" — server-authority 同步:
  // 检测到 backend 有 in-progress self-update(可能是别 session/webhook 触发),
  // 自动设 runState='running'。本地 click 也走这条 — useEffect 不会冲突,
  // 因为 activeSelfUpdate 真存在时不会回退到 idle。
  const activeSelfUpdate = selfStatus.status === 'ok' ? selfStatus.data.activeSelfUpdate : null;
  useEffect(() => {
    if (activeSelfUpdate && runState === 'idle') {
      setRunState('running');
      setRunStartedAt(Date.parse(activeSelfUpdate.startedAt) || Date.now());
      const triggerLabel = activeSelfUpdate.trigger === 'webhook' ? 'GitHub webhook'
        : activeSelfUpdate.trigger === 'auto-poll' ? '后台轮询'
        : activeSelfUpdate.trigger === 'force-sync' ? '强制同步'
        : '更新';
      setRunTitle(`${triggerLabel} 进行中${activeSelfUpdate.step ? ` · ${activeSelfUpdate.step}` : ''}`);
      setRunLog([`检测到后端正在跑 ${triggerLabel}(actor: ${activeSelfUpdate.actor || 'unknown'}),本 tab 同步显示进度`]);
    } else if (activeSelfUpdate && runState === 'running' && activeSelfUpdate.step) {
      // 阶段名变了 — 实时同步标题
      setRunTitle((prev) => {
        const triggerLabel = activeSelfUpdate.trigger === 'webhook' ? 'GitHub webhook'
          : activeSelfUpdate.trigger === 'auto-poll' ? '后台轮询'
          : activeSelfUpdate.trigger === 'force-sync' ? '强制同步'
          : '更新';
        const next = `${triggerLabel} 进行中 · ${activeSelfUpdate.step}`;
        return prev === next ? prev : next;
      });
    }
  }, [activeSelfUpdate, runState]);

  const loadBranches = useCallback(async () => {
    setBranchState({ status: 'loading' });
    try {
      const data = await apiRequest<SelfBranchesResponse>('/api/self-branches');
      setBranchState({ status: 'ok', data });
      setSelectedBranch((current) => current || data.current || data.branches?.[0] || '');
    } catch (err) {
      setBranchState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  // self-status 单独拉,fetch 远端比 self-branches 慢(网络),不阻塞 UI 主链路。
  // 自更新历史顶部 chip 在数据回来前显示骨架占位。
  //
  // 2026-05-04 v3 fix(用户反馈"banner 一直显示 400"):
  // 之前 loadSelfStatus 每次都先 setSelfStatus({status:'loading'}),失败后 status='error',
  // useEffect 只在 mount 时跑一次,error 状态永远不自动清除。用户在 self-update
  // 进程切换的 1-3s 窗口里 load 过一次拿到 4xx,banner 就卡死了。
  //
  // 现在:loadSelfStatus 不重置成 'loading'(保留上次的数据);成功 → status='ok'
  // 自动覆盖 error。下方加 30s 轮询 + error 时 5s 快重试,banner 自动消失,
  // 不需要手动按"重试"按钮。
  const loadSelfStatus = useCallback(async () => {
    try {
      // 用户反馈 2026-05-06:面板永远显示 "fetch 失败 / 远端不可达 — top-level
      // lightweight version"。根因:server.ts:1114 顶层 handler 抢答 /api/self-status,
      // 默认走"轻量"分支(不调 git fetch),fetchOk 永远 false,remoteAheadCount 永远 0。
      // 必须 ?probe=remote 才会 next() 流到 branches.ts:8116 的完整版,真实 fetch + 算 ahead。
      const data = await apiRequest<SelfStatusResponse>('/api/self-status?probe=remote');
      setSelfStatus({ status: 'ok', data });
    } catch (err) {
      setSelfStatus((prev) => {
        // 之前已有数据 → 保留,只标记 error(banner 还是显示,但 chip 仍在)
        // 还没数据 → 走 error-only(初次 load 失败)
        const message = err instanceof ApiError ? err.message : String(err);
        if (prev.status === 'ok') {
          return { status: 'ok', data: prev.data };
        }
        return { status: 'error', message };
      });
    }
  }, []);

  useEffect(() => {
    void loadBranches();
    void loadSelfStatus();
    // 30s 轮询 + error 状态下加倍频率(5s)。banner 一旦后端恢复立即自动消失。
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (delay: number): void => {
      if (disposed) return;
      timer = setTimeout(async () => {
        await loadSelfStatus();
        // 用 useState getter 拿最新 status 决定下次 delay
        // 这里用 setSelfStatus 只读不写
        setSelfStatus((prev) => {
          tick(prev.status === 'error' ? 5000 : 30000);
          return prev;
        });
      }, delay);
    };
    tick(30000);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadBranches, loadSelfStatus]);

  // 关闭 dropdown 当用户点外面
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (event: PointerEvent): void => {
      if (!pickerWrapRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [pickerOpen]);

  /** 候选分支列表 — 按 committerDate 倒排,优先用 branchDetails(后端已排好序),
   * fallback 到旧 branches: string[]。当前分支总在最前(便于看到自己在哪)。*/
  const visibleBranches = useMemo<BranchMeta[]>(() => {
    if (branchState.status !== 'ok') return [];
    const query = selectedBranch.trim().toLowerCase();
    const details = branchState.data.branchDetails;
    const list: BranchMeta[] = details && details.length > 0
      ? details
      : (branchState.data.branches || []).map((name) => ({
          name,
          committerDate: '',
          commitHash: '',
          subject: '',
          cdsTouched: false,
        }));
    // query 为空 → 全部;有 query → 过滤
    const filtered = query
      ? list.filter((b) => b.name.toLowerCase().includes(query))
      : list;
    // 当前分支放最前(如果在过滤结果里)
    const current = branchState.data.current;
    const sorted = filtered.slice().sort((a, b) => {
      if (a.name === current) return -1;
      if (b.name === current) return 1;
      return 0;
    });
    return sorted.slice(0, 80);
  }, [selectedBranch, branchState]);

  function appendRunLine(line: string): void {
    if (!line.trim()) return;
    setRunLog((current) => [...current.slice(-160), line]);
  }

  async function runPreflight(): Promise<void> {
    setDryRunning(true);
    setDryRun(null);
    try {
      const result = await apiRequest<DryRunResponse>('/api/self-update-dry-run', { method: 'POST', body: {} });
      setDryRun(result);
      onToast('自更新预检通过');
    } catch (err) {
      if (err instanceof ApiError && typeof err.body === 'object' && err.body !== null) {
        const body = err.body as DryRunResponse;
        setDryRun({ ...body, ok: false });
      } else {
        setDryRun({ ok: false, error: String(err) });
      }
      onToast('自更新预检失败');
    } finally {
      setDryRunning(false);
    }
  }

  async function runSelfUpdate(endpoint: '/api/self-update' | '/api/self-force-sync', label: string): Promise<void> {
    if (runState === 'running') return;

    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setRunEndedAt(null);
    setRunState('running');
    setRunTitle(`${label} 已启动`);
    setRunLog([]);
    setDryRun(null);
    let sawDone = false;
    let sawNoOp = false;
    try {
      await postSse(endpoint, { branch: selectedBranch || undefined }, (event, data) => {
        const title = eventTitle(event, data);
        if (event === 'error') {
          setRunState('error');
          setRunTitle(title);
          setRunEndedAt(Date.now());
        } else if (event === 'done') {
          sawDone = true;
          setRunState('success');
          setRunTitle(title);
          // no-op 路径不会重启 → done 立刻就是终态,停计时
          if (sawNoOp) setRunEndedAt(Date.now());
        } else {
          setRunTitle(title);
          // 检测 no-op step,标记后让 done 时立刻停计时(不进 wait-for-restart)
          if (typeof data === 'object' && data !== null && (data as { step?: unknown }).step === 'no-op') {
            sawNoOp = true;
          }
        }
        appendRunLine(title);
      });
      setRunState((current) => (current === 'error' ? 'error' : 'success'));
      onToast(`${label} 已提交`);
      void loadSelfStatus();
      // 2026-05-04 fix(用户反馈"显示已提交重启,但实际未重启"):
      // SSE 'done' 只代表后端发起了 process.exit + spawn,不代表新进程**真起来了**。
      // 之前 UI 没有任何 verification,用户得手动 refresh 才能知道是否成功。
      // 现在:done 之后开始轮询 /healthz,新进程起来 → window.location.reload() 加载新 bundle;
      // 60s 内还连不上 → toast "重启可能失败,请手动刷新或检查日志"。
      // no-op 路径不会重启,直接停计时返回。
      if (sawDone && !sawNoOp) {
        appendRunLine('正在等待新进程起来…');
        // 计时器 keep ticking — 直到 reload 或超时;reload 触发 → 页面整体重载,自动停计时
        await waitForRestartAndReload(onToast, appendRunLine);
        // 走到这里说明超时未 reload — 也停计时
        setRunEndedAt(Date.now());
      } else if (sawNoOp) {
        setRunEndedAt(Date.now());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRunState('error');
      setRunTitle(message);
      appendRunLine(message);
      onToast(`${label} 失败：${message}`);
      void loadSelfStatus();
      setRunEndedAt(Date.now());
    }
  }

  async function copyRunLog(): Promise<void> {
    const text = runLog.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onToast('更新日志已复制');
    } catch {
      onToast(text || '暂无日志');
    }
  }

  async function factoryReset(): Promise<void> {
    setSubmitting(true);
    try {
      await apiRequest('/api/factory-reset', { method: 'POST' });
      onToast('已恢复出厂设置，正在跳转');
      setOpen(false);
      window.setTimeout(() => {
        window.location.href = '/project-list';
      }, 1500);
    } catch (err) {
      onToast(`失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <Section title="CDS 更新" description="先预检当前代码能否启动，再选择更新或强制同步。真实重启前会再次确认。">
        <div className="space-y-5">
          <SelfUpdateStatusPanel
            state={selfStatus}
            onRefresh={() => void loadSelfStatus()}
            onOpenHistory={() => setHistoryOpen(true)}
          />
          {branchState.status === 'loading' ? <LoadingBlock label="读取 CDS 源码分支" /> : null}
          {branchState.status === 'error' ? <ErrorBlock message={branchState.message} /> : null}
          {branchState.status === 'ok' ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-md border border-border bg-card px-4 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">当前分支</span>
                      <CodePill>{branchState.data.current || '-'}</CodePill>
                      {branchState.data.commitHash ? <CodePill>{branchState.data.commitHash}</CodePill> : null}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      更新会先 fetch，再切到目标分支并对齐 origin，预检通过后重启 CDS。
                    </div>
                  </div>
                  <Button type="button" variant="outline" onClick={() => void loadBranches()}>
                    <RefreshCw />
                    刷新分支
                  </Button>
                </div>

                {/* 2026-05-04 重构:单 input combobox 取代「搜索框 + 经典 select」双控件。
                    用户输入 = selectedBranch(无歧义),回车/点击候选 = 确认选中。
                    候选下拉显示更新时间 + cds-touched 标识(是否动了 cds/ 目录)。 */}
                <div className="mt-4">
                  <label className="block space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">目标分支</span>
                      <span className="text-[11px] text-muted-foreground">
                        {visibleBranches.length} 个候选 · 按更新时间倒序 · ✨ 表示该分支动过 cds/
                      </span>
                    </div>
                    <div ref={pickerWrapRef} className="relative">
                      <input
                        ref={inputRef}
                        type="text"
                        value={selectedBranch}
                        onChange={(event) => {
                          setSelectedBranch(event.target.value);
                          setPickerOpen(true);
                          setHighlightedIndex(0);
                        }}
                        onFocus={() => setPickerOpen(true)}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setPickerOpen(true);
                            setHighlightedIndex((i) => Math.min(i + 1, visibleBranches.length - 1));
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setHighlightedIndex((i) => Math.max(i - 1, 0));
                          } else if (event.key === 'Enter') {
                            event.preventDefault();
                            const pick = visibleBranches[highlightedIndex];
                            if (pick) {
                              setSelectedBranch(pick.name);
                              setPickerOpen(false);
                            }
                          } else if (event.key === 'Escape') {
                            setPickerOpen(false);
                          }
                        }}
                        className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="输入或选择分支(main / release / codex/...)"
                        autoComplete="off"
                        spellCheck={false}
                        role="combobox"
                        aria-expanded={pickerOpen}
                        aria-autocomplete="list"
                      />
                      {pickerOpen && visibleBranches.length > 0 ? (
                        <div
                          role="listbox"
                          className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-[360px] overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
                          style={{ overscrollBehavior: 'contain' }}
                        >
                          {visibleBranches.map((branch, idx) => {
                            const isCurrent = branch.name === branchState.data.current;
                            const isHighlighted = idx === highlightedIndex;
                            return (
                              <button
                                key={branch.name}
                                type="button"
                                role="option"
                                aria-selected={isHighlighted}
                                onMouseEnter={() => setHighlightedIndex(idx)}
                                onClick={() => {
                                  setSelectedBranch(branch.name);
                                  setPickerOpen(false);
                                  inputRef.current?.focus();
                                }}
                                className={`block w-full border-b border-[hsl(var(--hairline))] px-3 py-2 text-left text-xs last:border-b-0 ${
                                  isHighlighted ? 'bg-[hsl(var(--surface-sunken))]' : ''
                                }`}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                                    {branch.name}
                                  </span>
                                  {isCurrent ? (
                                    <span className="shrink-0 rounded border border-emerald-500/50 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                      当前
                                    </span>
                                  ) : null}
                                  {branch.cdsTouched ? (
                                    <span
                                      className="shrink-0 rounded border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                                      title="该分支相对当前 HEAD 改动过 cds/ 目录"
                                    >
                                      <Sparkles className="mr-0.5 inline h-2.5 w-2.5" />
                                      改了 CDS
                                    </span>
                                  ) : null}
                                </div>
                                {branch.committerDate || branch.subject || branch.commitHash ? (
                                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5 text-[10px] text-muted-foreground">
                                    {branch.committerDate ? (
                                      <span title={branch.committerDate}>
                                        {formatRelativeTime(branch.committerDate)}
                                      </span>
                                    ) : null}
                                    {branch.commitHash ? (
                                      <span className="font-mono">{branch.commitHash}</span>
                                    ) : null}
                                    {branch.subject ? (
                                      <span className="min-w-0 truncate">{branch.subject}</span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {pickerOpen && visibleBranches.length === 0 ? (
                        <div className="absolute left-0 right-0 top-full z-[100] mt-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-3 text-xs text-muted-foreground shadow-2xl">
                          没有匹配「{selectedBranch}」的分支。回车将以原值提交(后端会预检 origin/{selectedBranch} 是否存在)。
                        </div>
                      ) : null}
                    </div>
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => void runPreflight()} disabled={dryRunning}>
                    {dryRunning ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                    预检
                  </Button>
                  <ConfirmAction
                    title="更新并重启"
                    description="执行 self-update，完成后会重启 CDS。"
                    confirmLabel="执行"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-update', '更新并重启')}
                    trigger={
                      <Button type="button" disabled={runState === 'running'}>
                        {runState === 'running' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        更新并重启
                      </Button>
                    }
                  />
                  <ConfirmAction
                    title="强制同步"
                    description={`会 git fetch 后 hard reset 到 origin/${selectedBranch || '当前分支'}，丢弃 CDS host 上未推送的本地提交，并重启 CDS。`}
                    confirmLabel="强制同步"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-force-sync', '强制同步')}
                    trigger={
                      <Button type="button" variant="outline" disabled={runState === 'running'}>
                        <AlertTriangle />
                        强制同步
                      </Button>
                    }
                  />
                </div>
              </div>

              <div className="rounded-md border border-border bg-card px-4 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">预检结果</div>
                  {dryRun?.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
                </div>
                {!dryRun ? (
                  <div className="text-sm leading-6 text-muted-foreground">预检会运行 pnpm install --frozen-lockfile 和 tsc --noEmit，不会重启。</div>
                ) : dryRun.ok ? (
                  <div className="space-y-2 text-sm leading-6">
                    <div className="text-emerald-600">通过</div>
                    <div className="text-muted-foreground">{dryRun.summary || '依赖与编译通过'}</div>
                    {dryRun.durationMs ? <CodePill>{Math.round(dryRun.durationMs / 1000)}s</CodePill> : null}
                  </div>
                ) : (
                  <div className="space-y-2 text-sm leading-6">
                    <div className="text-destructive">失败{dryRun.stage ? `：${dryRun.stage}` : ''}</div>
                    <div className="whitespace-pre-wrap text-muted-foreground">{dryRun.error || '未知错误'}</div>
                    {dryRun.hint ? <div className="text-muted-foreground">{dryRun.hint}</div> : null}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <DisclosurePanel
            title={runTitle || '更新日志'}
            subtitle={
              runState === 'idle'
                ? '尚未执行更新。'
                : runState === 'running'
                  ? `执行中 · ${formatElapsed(elapsedRunMs)}`
                  : runState === 'success'
                    ? `已提交重启 · 用时 ${formatElapsed(elapsedRunMs)}`
                    : `执行失败 · 用时 ${formatElapsed(elapsedRunMs)}`
            }
            contentClassName="p-0"
          >
              <div className="flex justify-end px-4 py-3">
                <Button type="button" variant="outline" size="sm" onClick={() => void copyRunLog()} disabled={runLog.length === 0}>
                  <Copy />
                  复制
                </Button>
              </div>
              <pre className="max-h-64 min-h-32 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
                {runLog.length ? runLog.join('\n') : '这里会显示 self-update / force-sync 的 SSE 步骤。'}
              </pre>
          </DisclosurePanel>
        </div>
      </Section>

      <DisclosurePanel title="危险操作" subtitle="影响所有项目的不可逆操作" tone="danger">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="destructive">
              <AlertTriangle className="mr-2 h-4 w-4" />
              恢复出厂设置
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>确认恢复出厂设置</DialogTitle>
              <DialogDescription>
                这会清空所有项目的分支、构建配置、环境变量、基础设施和路由规则。Docker 数据卷会保留。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="button" variant="destructive" onClick={() => void factoryReset()} disabled={submitting}>
                确认清空
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DisclosurePanel>

      {/* 自更新历史抽屉 — 用 shadcn Dialog 自动满足布局 3 硬约束(createPortal /
          inline 高度 / min-h-0),不会被外层 Section 的 overflow 裁切。
          状态栏 chip 点击打开,显示最近 20 条流水。*/}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>CDS 自更新历史</DialogTitle>
            <DialogDescription>
              最近 20 条记录,倒序(最新在前)。每次触发 self-update / force-sync 都会写入。
            </DialogDescription>
          </DialogHeader>
          <SelfUpdateHistoryList state={selfStatus} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 自更新可见性面板(2026-05-04)
//
// 用户反馈:「我不清楚是否有自动更新, 这里需要显示」。这个面板回答 3 个问题:
//   1. GitHub 上当前分支领先本地多少个 commit?(=「我该不该 self-update」)
//   2. 上次系统更新发生在什么时候,谁触发的,成功还是失败?
//   3. 历史:最近 20 次更新流水
// ──────────────────────────────────────────────────────────────────────────

function SelfUpdateStatusPanel({
  state,
  onRefresh,
  onOpenHistory,
}: {
  state: SelfStatusState;
  onRefresh: () => void;
  onOpenHistory: () => void;
}): JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        正在检查 GitHub 远端 + 自更新流水…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>读取自更新状态失败:{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw />
            重试
          </Button>
        </div>
      </div>
    );
  }
  const data = state.data;
  const aheadColor =
    data.remoteAheadCount === 0
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  // 用户反馈 2026-05-06:"现在版本和最新版本差多少 / 差距在哪里"。
  // 一句话总结:本地 SHA · 远端最新 SHA · 落后 N commit。chip 之上,扫一眼定位。
  const remoteHeadSha = data.remoteAheadSubjects[0]?.sha;
  const showVersionSummary = data.fetchOk && (data.headSha || remoteHeadSha);

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      {showVersionSummary ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">本地</span>
          <CodePill>{data.headSha || '-'}</CodePill>
          <span className="text-muted-foreground">→</span>
          <span className="text-muted-foreground">远端最新</span>
          <CodePill>{remoteHeadSha || data.headSha || '-'}</CodePill>
          {data.remoteAheadCount > 0 ? (
            <span className="font-semibold text-amber-700 dark:text-amber-300">
              落后 {data.remoteAheadCount} 个 commit
            </span>
          ) : (
            <span className="font-semibold text-emerald-700 dark:text-emerald-300">已是最新</span>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {/* GitHub 远端状态 chip */}
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${aheadColor}`}>
          <Sparkles className="h-3.5 w-3.5" />
          {data.fetchOk
            ? data.remoteAheadCount === 0
              ? `已与 origin/${data.currentBranch} 同步`
              : `GitHub 领先 ${data.remoteAheadCount} 个 commit`
            : 'fetch 失败 / 远端不可达'}
        </span>
        {data.localAheadCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
            本地领先 {data.localAheadCount} 个 commit(host 上有未推送提交)
          </span>
        ) : null}

        {/* 上次更新 chip */}
        {data.lastSelfUpdate ? (
          <button
            type="button"
            onClick={onOpenHistory}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors hover:bg-[hsl(var(--surface-sunken))] ${selfUpdateStatusClass(data.lastSelfUpdate.status)}`}
            title="点击查看完整历史"
          >
            <RotateCw className="h-3.5 w-3.5" />
            上次更新 · {formatRelativeTime(data.lastSelfUpdate.ts)} · {selfUpdateStatusLabel(data.lastSelfUpdate.status)}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 py-0.5 text-xs text-muted-foreground">
            尚无自更新记录
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onOpenHistory} disabled={(data.selfUpdateHistory || []).length === 0}>
            历史(最近 {Math.min((data.selfUpdateHistory || []).length, 20)} 条)
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCw />
            刷新
          </Button>
        </div>
      </div>

      {/* 远端领先时,展开显示前 5 条新 commit subject 让用户秒判断「值不值得更新」 */}
      {data.fetchOk && data.remoteAheadCount > 0 && data.remoteAheadSubjects.length > 0 ? (
        <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">远端领先的 commit:</div>
          <ul className="mt-1.5 space-y-1 text-xs">
            {data.remoteAheadSubjects.map((c) => (
              <li key={c.sha} className="flex items-start gap-2">
                <CodePill>{c.sha}</CodePill>
                <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
                <span className="shrink-0 text-muted-foreground">{formatRelativeTime(c.date)}</span>
              </li>
            ))}
            {data.remoteAheadCount > data.remoteAheadSubjects.length ? (
              <li className="text-muted-foreground">… 还有 {data.remoteAheadCount - data.remoteAheadSubjects.length} 个</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {!data.fetchOk && data.fetchError ? (
        <div className="mt-2 text-xs text-muted-foreground">
          fetch 错误:{data.fetchError.slice(0, 200)}
        </div>
      ) : null}

      {/* 用户反馈 2026-05-06 — systemd unit 漂移提示。
          重构后 unit 文件极少改,但确实改时 operator 不知道 → 默默用旧 unit。
          这里 backend 检测到漂移,UI 一行命令告诉怎么修。 */}
      {data.systemdUnitDrift ? (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
          <div className="mb-1 flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">systemd unit 文件已更新但未重装</span>
          </div>
          <div className="text-muted-foreground">
            仓库:<CodePill>{data.systemdUnitDrift.repoHash}</CodePill> · 已装:
            <CodePill>{data.systemdUnitDrift.installedHash}</CodePill>
            {data.systemdUnitDrift.installedAt
              ? ` · 上次安装 ${formatRelativeTime(data.systemdUnitDrift.installedAt)}`
              : ''}
          </div>
          <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
            一次性修(SSH 到 host):<br />
            <span className="text-foreground">
              cd {'<repo>'}/cds && ./exec_cds.sh install-systemd && sudo cp /tmp/cds-master.service.* /etc/systemd/system/cds-master.service && sudo systemctl daemon-reload
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SelfUpdateHistoryList({ state }: { state: SelfStatusState }): JSX.Element {
  if (state.status !== 'ok' || (state.data.selfUpdateHistory || []).length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {state.status === 'loading' ? '加载中…' : state.status === 'error' ? state.message : '尚无历史'}
      </div>
    );
  }
  return (
    <div className="max-h-[60vh] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <ul className="divide-y divide-[hsl(var(--hairline))]">
        {state.data.selfUpdateHistory.map((rec, idx) => (
          <li key={`${rec.ts}-${idx}`} className="flex flex-col gap-1 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${selfUpdateStatusClass(rec.status)}`}>
                {selfUpdateStatusLabel(rec.status)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(rec.ts)} · {selfUpdateTriggerLabel(rec.trigger)}
                {rec.actor ? ` · ${rec.actor}` : ''}
              </span>
              {rec.durationMs !== undefined ? (
                <span className="text-xs text-muted-foreground">{(rec.durationMs / 1000).toFixed(1)}s</span>
              ) : null}
              {/* 2026-05-06:让用户一眼看出本次走的是哪条更新路径 */}
              {(() => {
                const mode = rec.updateMode || (rec.noOp ? 'noOp' : undefined);
                if (!mode) return null;
                const tone =
                  mode === 'hot-reload'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : mode === 'noOp'
                      ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
                const label =
                  mode === 'hot-reload'
                    ? '热重载'
                    : mode === 'noOp'
                      ? '已是最新'
                      : '完整重启';
                const tip =
                  mode === 'hot-reload'
                    ? '应用代码改动,跳过 validate(节省 ~50s)走 systemd 软重启'
                    : mode === 'noOp'
                      ? 'HEAD 已与 dist 完全一致,啥都没做'
                      : '改动涉及依赖/配置/路由 schema,走 systemd 完整重启(含 validate)';
                return (
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${tone}`}
                    title={tip}
                  >
                    {label}
                  </span>
                );
              })()}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <CodePill>{rec.branch || '(当前分支)'}</CodePill>
              {rec.fromSha ? (
                <span className="font-mono text-muted-foreground">
                  {rec.fromSha}
                  {rec.toSha && rec.toSha !== rec.fromSha ? ` → ${rec.toSha}` : ''}
                </span>
              ) : null}
            </div>
            {rec.error ? (
              <div className="mt-0.5 text-xs text-destructive/80" title={rec.error}>
                {rec.error.length > 200 ? rec.error.slice(0, 200) + '…' : rec.error}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function selfUpdateStatusClass(status: SelfUpdateRecord['status']): string {
  switch (status) {
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'aborted':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
  }
}

function selfUpdateStatusLabel(status: SelfUpdateRecord['status']): string {
  switch (status) {
    case 'success': return '成功';
    case 'aborted': return '中止(预检未过)';
    case 'failed':  return '失败';
  }
}

function selfUpdateTriggerLabel(trigger: SelfUpdateRecord['trigger']): string {
  switch (trigger) {
    case 'manual':     return '手动';
    case 'force-sync': return '强制同步';
    case 'auto-poll':  return '自动轮询';
    case 'webhook':    return 'GitHub webhook';
  }
}
