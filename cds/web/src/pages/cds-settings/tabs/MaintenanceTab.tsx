import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, GitBranch, Loader2, RefreshCw, RotateCw } from 'lucide-react';

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
import { apiRequest, ApiError, apiUrl } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';
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
interface SelfUpdateTimings {
  totalMs?: number;
  fetchMs?: number;
  checkoutMs?: number;
  pullMs?: number;
  resetMs?: number;
  nginxRenderMs?: number;
  analyzeMs?: number;
  validateMs?: number;
  validateInstallMs?: number;
  validateTscMs?: number;
  cacheMs?: number;
  buildBackendMs?: number;
  webBuildMs?: number;
  webOnlyMs?: number;
  docOnlyMs?: number;
  noOpMs?: number;
  restartMs?: number;
  drainMs?: number;
  validate?: Record<string, number>;
  webBuildSkipped?: boolean;
  webBuildReason?: string;
  [key: string]: number | boolean | string | Record<string, number> | undefined;
}

interface SelfUpdateRecord {
  ts: string;
  branch: string;
  fromSha: string;
  toSha: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  status: 'success' | 'failed' | 'aborted' | 'deferred';
  durationMs?: number;
  /** 2026-05-07 真实总耗时(含 daemon 重启 + SSE 重连)。 */
  totalElapsedMs?: number;
  error?: string;
  actor?: string;
  /** 用户反馈 2026-05-06 — 让用户看到走了哪种更新模式。
   *  hot-reload = 跳过 validate(节省 50s)+ systemd 软重启,~15-25s。
   *               改动只涉及应用代码(.ts/.tsx),且未触及依赖/配置/路由 schema。
   *  restart    = 完整 validate + systemd 重启,~70-95s。
   *               改了依赖/Dockerfile/tsconfig/.env/路由表/types schema 等。
   *  noOp       = HEAD 已是 .build-sha 的版本,啥都没做(~3s)
   */
  updateMode?: 'hot-reload' | 'restart' | 'noOp' | 'web-only' | 'doc-only';
  noOp?: boolean;
  /** 完整 SSE 步骤序列。/api/self-status 默认 slim payload 不带这个字段,
   *  改用 stepsCount 作为前端"是否有日志可展开"的提示;真展开时通过
   *  /api/self-update-history?limit=N 拿完整数据。 */
  steps?: Array<{ ts: string; level: 'info' | 'warning' | 'error'; text: string }>;
  /** /api/self-status slim 模式下返回:本 record 完整 SSE 步骤行数。前端
   *  据此显示「完整步骤(N 行)」按钮 + 用户点开时再 lazy fetch /api/self-update-history。 */
  stepsCount?: number;
  /** 2026-05-28:阶段耗时分解。后端 `SelfUpdateTimingBreakdown`。
   *  历史一直存在,但前端类型漏 → 渲染丢失。用户反馈"可观测性不强"的根因。 */
  timings?: SelfUpdateTimings;
}

interface SystemdUnitDrift {
  repoHash: string;
  installedHash: string;
  installedAt?: string;
}

/** 用户反馈 2026-05-06:中间面板不知道别 session/webhook 触发的 self-update。
 *  backend 暴露 in-progress 标记,任何 tab 打开都能立刻显示"正在重启"。
 *
 *  2026-05-07 字段扩展(Phase 1 — 状态落盘 + 心跳判活):
 *    pid / lastTickAt / logTail / interrupted 让前端能看见
 *    "卡 web-build 2 分钟" 期间到底发生了什么 + sidecar 是否失联。
 *    SSOT 是后端的 .cds/active-update.json,前端只读 + 渲染。 */
interface ActiveSelfUpdateLogLine {
  ts: string;
  level: 'info' | 'warning' | 'error';
  text: string;
}
interface ActiveSelfUpdate {
  startedAt: string;
  branch: string;
  trigger: 'manual' | 'force-sync' | 'auto-poll' | 'webhook';
  actor?: string;
  step?: string;
  pid?: number;
  lastTickAt?: string;
  logTail?: ActiveSelfUpdateLogLine[];
  interrupted?: boolean;
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
  runningPid?: number;
  pidStartedAt?: string | null;
  restartStatus?: 'not_required' | 'pending' | 'completed' | 'incomplete';
  lastSelfUpdate: SelfUpdateRecord | null;
  selfUpdateHistory: SelfUpdateRecord[];
}

type SelfStatusState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SelfStatusResponse };


type BranchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: SelfBranchesResponse };

type UpdateRunState = 'idle' | 'running' | 'success' | 'error';

const ACTIVE_UPDATE_UNLOCK_MS = 120_000;

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

function formatAbsoluteTime(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  return new Date(ts).toLocaleString();
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
    const pre = await fetch(apiUrl('/api/self-status'), { credentials: 'include' });
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
      const r = await fetch(apiUrl('/api/self-status'), { credentials: 'include', cache: 'no-store' });
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
  // 选中某个分支后会 inputRef.focus() 把光标放回输入框，但 input 的 onFocus
  // 默认会重新 setPickerOpen(true)，导致下拉"点了不关"。用这个一次性标记在
  // 选中后的那一次 focus 时跳过重开。
  const suppressFocusOpenRef = useRef(false);
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
  // 2026-05-28 删除 historyOpen — 列表常驻显示在面板下方,不再走 Dialog

  // ⚠ 2026-05-06 用户反馈"中间没更新左下角在动" — server-authority 同步:
  // 检测到 backend 有 in-progress self-update(可能是别 session/webhook 触发),
  // 自动设 runState='running'。本地 click 也走这条 — useEffect 不会冲突,
  // 因为 activeSelfUpdate 真存在时不会回退到 idle。
  const activeSelfUpdate = selfStatus.status === 'ok' ? selfStatus.data.activeSelfUpdate : null;
  const lastSelfUpdate = selfStatus.status === 'ok' ? selfStatus.data.lastSelfUpdate : null;

  // 进度条专用 elapsed:必须与 step 同源(都来自后端 activeSelfUpdate)。
  // runStartedAt 是点按钮那一刻的客户端时间,从本 tab 触发时不会回填后端
  // startedAt → 与服务端 step 配错时钟(Bugbot #716)。优先用后端 startedAt
  // 作为锚点,缺失再退回 runStartedAt。
  const liveStartedAtMs = (() => {
    const serverMs = activeSelfUpdate?.startedAt ? Date.parse(activeSelfUpdate.startedAt) : NaN;
    if (Number.isFinite(serverMs)) return serverMs;
    return runStartedAt ?? Date.now();
  })();
  const liveElapsedMs = Math.max(0, (runEndedAt ?? Date.now()) - liveStartedAtMs);

  // 自更新历史:统一数据源,进度条 + 历史列表共用一份(不各自 fetch)。
  const { historyState: selfHistoryState, manualRefresh: refreshSelfHistory } = useSelfUpdateHistory();
  const selfHistoryRecords = selfHistoryState.status === 'ok' ? selfHistoryState.records : [];

  // 2026-05-07 lastTickAt 判活(Phase 1 — 杜绝"timer 跳秒但其实早死"幻觉):
  // 后端每写一步、每条心跳都刷新 lastTickAt。前端用 tickClock 触发
  // 重渲染,实时检测距上次心跳超过 30s → 显示"失联 N 秒"红色态。
  // interrupted=true(启动时扫到 sidecar pid 已死)直接显示"已中断"。
  const lastTickStaleMs = activeSelfUpdate?.lastTickAt
    ? Date.now() - Date.parse(activeSelfUpdate.lastTickAt)
    : 0;
  const isStale = activeSelfUpdate && lastTickStaleMs > 30_000;
  const isInterrupted = !!activeSelfUpdate?.interrupted;

  // 2026-05-07 useRef 拿当前 logTail 长度,只在新行追加时把它们 append 到
  // runLog 里(避免每次重渲染都覆盖整段 — 老的 setRunLog 单行写法会冲掉
  // 用户能看到的滚动历史)。后端 logTail 是 ring buffer(max 50),足够。
  const lastLogTsRef = useRef<string>('');
  useEffect(() => {
    if (!activeSelfUpdate) {
      lastLogTsRef.current = '';
      if (runState === 'running') {
        const graceMs = runStartedAt ? Date.now() - runStartedAt : Number.POSITIVE_INFINITY;
        if (graceMs < 5000) return;
        setRunEndedAt(Date.now());
        if (lastSelfUpdate?.status === 'success') {
          setRunState('success');
          setRunTitle('更新流程已结束');
          setRunLog((prev) => {
            const line = '  · 后端已确认当前没有进行中的更新任务。';
            return prev.includes(line) ? prev : [...prev, line];
          });
        } else {
          setRunState('error');
          const statusText = lastSelfUpdate ? selfUpdateStatusLabel(lastSelfUpdate.status) : '未知';
          setRunTitle(`更新流程已结束 · ${statusText}`);
          setRunLog((prev) => {
            const line = lastSelfUpdate
              ? `  [ERR] 后端已确认当前没有进行中的更新任务,上次更新状态: ${statusText}。`
              : '  [ERR] 后端已确认当前没有进行中的更新任务,已解除按钮锁定。';
            return prev.includes(line) ? prev : [...prev, line];
          });
        }
      }
      return;
    }
    if (
      runState === 'running' &&
      (isInterrupted || lastTickStaleMs > ACTIVE_UPDATE_UNLOCK_MS)
    ) {
      const reason = isInterrupted
        ? '更新进程已中断'
        : `更新进程超过 ${Math.floor(ACTIVE_UPDATE_UNLOCK_MS / 1000)}s 没有心跳`;
      setRunState('error');
      setRunEndedAt(Date.now());
      setRunTitle(reason);
      setRunLog((prev) => {
        const line = `  [ERR] ${reason},已解除按钮锁定。请先点刷新确认当前版本,必要时再点强制更新。`;
        return prev.includes(line) ? prev : [...prev, line];
      });
      return;
    }
    if (runState === 'idle') {
      setRunState('running');
      setRunStartedAt(Date.parse(activeSelfUpdate.startedAt) || Date.now());
      const triggerLabel = activeSelfUpdate.trigger === 'webhook' ? 'GitHub webhook'
        : activeSelfUpdate.trigger === 'auto-poll' ? '后台轮询'
        : activeSelfUpdate.trigger === 'force-sync' ? '强制更新'
        : '更新';
      setRunTitle(`${triggerLabel} 进行中${activeSelfUpdate.step ? ` · ${activeSelfUpdate.step}` : ''}`);
      const initLines = [
        `检测到后端正在跑 ${triggerLabel}(actor: ${activeSelfUpdate.actor || 'unknown'},pid: ${activeSelfUpdate.pid ?? '?'})`,
        ...((activeSelfUpdate.logTail || []).map((l) => `  · ${l.text}`)),
      ];
      setRunLog(initLines);
      lastLogTsRef.current = activeSelfUpdate.logTail?.[activeSelfUpdate.logTail.length - 1]?.ts || '';
    } else if (runState === 'running') {
      // 阶段名变了 — 实时同步标题
      if (activeSelfUpdate.step) {
        setRunTitle((prev) => {
          const triggerLabel = activeSelfUpdate.trigger === 'webhook' ? 'GitHub webhook'
            : activeSelfUpdate.trigger === 'auto-poll' ? '后台轮询'
            : activeSelfUpdate.trigger === 'force-sync' ? '强制更新'
            : '更新';
          const suffix = isInterrupted
            ? ' · 已中断(pid 已死)'
            : isStale
            ? ` · 失联 ${Math.floor(lastTickStaleMs / 1000)}s`
            : '';
          const next = `${triggerLabel} 进行中 · ${activeSelfUpdate.step}${suffix}`;
          return prev === next ? prev : next;
        });
      }
      // 增量追加新日志行(按 ts 去重,避免重复 push)
      const tail = activeSelfUpdate.logTail || [];
      const newLines = tail.filter((l) => l.ts > lastLogTsRef.current);
      if (newLines.length > 0) {
        setRunLog((prev) => [
          ...prev,
          ...newLines.map((l) => {
            const prefix = l.level === 'error' ? '  [ERR] '
              : l.level === 'warning' ? '  [WARN] '
              : '  · ';
            return prefix + l.text;
          }),
        ]);
        lastLogTsRef.current = tail[tail.length - 1]!.ts;
      }
    }
  }, [activeSelfUpdate, runState, isStale, isInterrupted, lastTickStaleMs, lastSelfUpdate, runStartedAt]);

  // 2026-05-28 重构:/api/self-branches 永远返 200 + (可能 degraded)。
  // 即使 degraded 也尽量给 branchDetails/branches/current 等字段。
  const loadBranches = useCallback(async () => {
    setBranchState({ status: 'loading' });
    try {
      const data = await apiRequest<SelfBranchesResponse & {
        ok?: boolean;
        degraded?: boolean;
        reason?: string | null;
        message?: string | null;
      }>('/api/self-branches');
      setBranchState({ status: 'ok', data });
      setSelectedBranch((current) => current || data.current || data.branches?.[0] || '');
    } catch (err) {
      // /api/self-branches 现在永远 200,这里只在网络层失败(断网/CORS)才命中。
      // 2026-05-28 用户反馈"主面板里不能出现红色提示":
      //   即使本端点真失败了,也优先保留上次状态(loading→保持 loading 兜底),
      //   绝不在主区里渲染红色 ErrorBlock。CDN/边缘抖动(transient)更要静默。
      // eslint-disable-next-line no-console
      console.warn('[MaintenanceTab] loadBranches failed:', err);
      if (err instanceof ApiError && err.transient) {
        // 抖动:保留 loading / 上次 ok 状态,不让用户看到红色横幅
        setBranchState((prev) => prev.status === 'ok' ? prev : { status: 'loading' });
        return;
      }
      // 持续真错也不再用 ErrorBlock 占主区,降级为 loading 状态(空 branch 选项)
      setBranchState((prev) => prev.status === 'ok' ? prev : { status: 'loading' });
    }
  }, []);

  // 2026-05-28 重构:不再独立轮询 /api/self-status?probe=remote。改为订阅
  // useCdsEvents store 的 self.status 事件。任何 tab/webhook 触发的自更新都会
  // 经由 cds-events bus 实时推过来,远比 30s 轮询新鲜。窗口事件
  // 'cds:active-self-update' 不再需要(原本就是 GlobalUpdateBadge 转发的,
  // 现在两边读同一个 store)。
  const cdsEvents = useCdsEvents();

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  // snapshot → selfStatus 同步;degraded 时保留旧值显示
  useEffect(() => {
    const snap = cdsEvents.snapshot ?? cdsEvents.lastKnownGood;
    if (!snap) return;
    // 把 useCdsEvents 的 SelfStatusSnapshot 映射回 MaintenanceTab 的 SelfStatusResponse 形状
    const mapped: SelfStatusResponse = {
      currentBranch: snap.currentBranch ?? '',
      headSha: snap.headSha ?? '',
      headIso: snap.headIso ?? '',
      fetchOk: snap.fetchOk ?? true,
      fetchError: snap.fetchError ?? undefined,
      remoteAheadCount: snap.remoteAheadCount ?? 0,
      localAheadCount: snap.localAheadCount ?? 0,
      remoteAheadSubjects: (snap.remoteAheadSubjects ?? []) as Array<{
        sha: string;
        subject: string;
        date: string;
      }>,
      activeSelfUpdate: snap.activeSelfUpdate as ActiveSelfUpdate | null,
      systemdUnitDrift: snap.systemdUnitDrift as SystemdUnitDrift | null,
      runningPid: snap.runningPid,
      pidStartedAt: snap.pidStartedAt ?? null,
      restartStatus: snap.restartStatus,
      lastSelfUpdate: (snap.lastSelfUpdate ?? null) as SelfUpdateRecord | null,
      selfUpdateHistory: (snap.selfUpdateHistory ?? []) as SelfUpdateRecord[],
    };
    setSelfStatus({ status: 'ok', data: mapped });
  }, [cdsEvents.snapshot, cdsEvents.lastKnownGood]);

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

  async function runSelfUpdate(
    endpoint: '/api/self-update' | '/api/self-force-sync',
    label: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (runState === 'running') return;

    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setRunEndedAt(null);
    setRunState('running');
    setRunTitle(`${label} 已启动`);
    setRunLog([]);
    let sawDone = false;
    let sawNoOp = false;
    let doneMode: SelfUpdateRecord['updateMode'] | undefined;
    try {
      // 2026-05-08:force=true 让后端跳过 no-op fast-path,即使 HEAD 没变也走完整
      // 流程。"强制更新"按钮带这个 flag,这样测试人员可以反复点同一 commit。
      await postSse(endpoint, { branch: selectedBranch || undefined, force: opts.force }, (event, data) => {
        const title = eventTitle(event, data);
        if (event === 'error') {
          setRunState('error');
          setRunTitle(title);
          setRunEndedAt(Date.now());
        } else if (event === 'done') {
          sawDone = true;
          if (typeof data === 'object' && data !== null) {
            const mode = (data as { mode?: unknown }).mode;
            if (
              mode === 'web-only' ||
              mode === 'doc-only' ||
              mode === 'noOp' ||
              mode === 'hot-reload' ||
              mode === 'restart'
            ) {
              doneMode = mode;
            }
          }
          setRunState('success');
          setRunTitle(title);
          // no-op 路径不会重启 → done 立刻就是终态,停计时
          if (sawNoOp || doneMode === 'doc-only' || doneMode === 'noOp') setRunEndedAt(Date.now());
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
      onToast(`${label} 已提交，正在等待 CDS 验证`);
      // 2026-05-28: 旧的 loadSelfStatus() 已删,改为触发后端 refresh job。
      // 状态变化通过 useCdsEvents 的 self.status / self.refresh.* 事件自动推送。
      void cdsEvents.requestRefresh('manual').catch(() => { /* silent */ });
      // 2026-05-04 fix(用户反馈"显示已提交重启,但实际未重启"):
      // SSE 'done' 只代表后端发起了 process.exit + spawn,不代表新进程**真起来了**。
      // 之前 UI 没有任何 verification,用户得手动 refresh 才能知道是否成功。
      // 现在:done 之后开始轮询 /healthz,新进程起来 → window.location.reload() 加载新 bundle;
      // 60s 内还连不上 → toast "重启可能失败,请手动刷新或检查日志"。
      // no-op / doc-only 路径不会重启,直接停计时返回。web-only 不重启但
      // bundle 已换,需要刷新当前页面才能让用户看到真实新前端。
      if (sawDone && doneMode === 'web-only') {
        appendRunLine('前端 bundle 已更新完成,3s 后自动刷新页面加载新版 UI');
        onToast('前端更新完成,即将刷新页面');
        setRunEndedAt(Date.now());
        await new Promise((r) => setTimeout(r, 3000));
        window.location.reload();
        return;
      }
      if (sawDone && !sawNoOp && doneMode !== 'doc-only' && doneMode !== 'noOp') {
        appendRunLine('正在等待新进程起来…');
        // 计时器 keep ticking — 直到 reload 或超时;reload 触发 → 页面整体重载,自动停计时
        await waitForRestartAndReload(onToast, appendRunLine);
        // 走到这里说明超时未 reload — 也停计时
        setRunEndedAt(Date.now());
      } else if (sawNoOp || doneMode === 'doc-only' || doneMode === 'noOp') {
        setRunEndedAt(Date.now());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRunState('error');
      setRunTitle(message);
      appendRunLine(message);
      onToast(`${label} 失败：${message}`);
      // 2026-05-28: 旧的 loadSelfStatus() 已删,改为触发后端 refresh job。
      // 状态变化通过 useCdsEvents 的 self.status / self.refresh.* 事件自动推送。
      void cdsEvents.requestRefresh('manual').catch(() => { /* silent */ });
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
      <Section title="CDS 更新" description="拉取最新代码,自动校验依赖与编译,通过后重启 CDS。失败时旧版本继续运行,不会让服务下线。">
        <div className="space-y-5">
          <SelfUpdateStatusPanel
            state={selfStatus}
            onRefresh={() => void cdsEvents.requestRefresh('manual').catch(() => { /* silent */ })}
          />
          {branchState.status === 'loading' ? <LoadingBlock label="读取 CDS 源码分支" /> : null}
          {branchState.status === 'error' ? <ErrorBlock message={branchState.message} /> : null}
          {branchState.status === 'ok' ? (
            <div className="grid gap-4">
              <div className="rounded-md border border-border bg-card px-4 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">当前分支</span>
                      <CodePill>{branchState.data.current || '-'}</CodePill>
                    </div>
                    <div className="mt-2 text-sm leading-6 text-muted-foreground">
                      选择目标分支后更新；默认使用当前分支。
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
                      {visibleBranches.length > 1 ? (
                        <span className="text-[11px] text-muted-foreground">
                          {visibleBranches.length} 个候选 · 按更新时间倒序
                        </span>
                      ) : null}
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
                        onFocus={() => {
                          if (suppressFocusOpenRef.current) {
                            suppressFocusOpenRef.current = false;
                            return;
                          }
                          setPickerOpen(true);
                        }}
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
                                  suppressFocusOpenRef.current = true;
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
                                      <GitBranch className="mr-0.5 inline h-2.5 w-2.5" />
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
                          没有匹配「{selectedBranch}」的分支。回车将以原值提交(后端会校验 origin/{selectedBranch} 是否存在)。
                        </div>
                      ) : null}
                    </div>
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <ConfirmAction
                    title="更新并重启"
                    description="拉取最新代码,自动校验依赖与编译,通过后重启 CDS。失败时旧版本继续运行。"
                    confirmLabel="执行"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-update', '更新')}
                    trigger={
                      <Button type="button" disabled={runState === 'running'}>
                        {runState === 'running' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                        更新
                      </Button>
                    }
                  />
                  <ConfirmAction
                    title="强制更新"
                    description={`会 git fetch 后 hard reset 到 origin/${selectedBranch || '当前分支'},丢弃本地未推送的提交,并重新编译重启 CDS。即使 HEAD 没变也会走完整流程(force=true,跳过 no-op 短路),便于测试人员重复触发同一版本验证更新链路。`}
                    confirmLabel="强制更新"
                    pending={runState === 'running'}
                    onConfirm={() => runSelfUpdate('/api/self-force-sync', '强制更新', { force: true })}
                    trigger={
                      <Button type="button" variant="outline" disabled={runState === 'running'}>
                        <AlertTriangle />
                        强制更新
                      </Button>
                    }
                  />
                </div>
              </div>
            </div>
          ) : null}

          <DisclosurePanel
            title={runTitle || '更新日志'}
            subtitle={
              runState === 'idle'
                ? '尚未执行更新。'
                : runState === 'running'
                  ? `执行中 · ${formatElapsed(liveElapsedMs)}`
                  : runState === 'success'
                    ? `已提交重启 · 用时 ${formatElapsed(elapsedRunMs)}`
                    : `执行失败 · 用时 ${formatElapsed(elapsedRunMs)}`
            }
            contentClassName="p-0"
          >
              {runState === 'running' ? (
                <SelfUpdateLiveProgress elapsedMs={liveElapsedMs} currentStep={activeSelfUpdate?.step} records={selfHistoryRecords} />
              ) : null}
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

      {/* 2026-05-28 改:历史列表常驻显示在面板下方,不再藏到 Dialog 后面。
          用户反馈"按钮不够明显 + 弹窗内看一眼被闪掉"。 */}
      <Section title="自更新历史" description="最近 20 条记录,倒序(最新在前)。每次触发 self-update / force-sync 都会写入。">
        <SelfUpdateHistoryList historyState={selfHistoryState} onManualRefresh={refreshSelfHistory} />
      </Section>
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
}: {
  state: SelfStatusState;
  onRefresh: () => void;
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
  const remoteAheadSubjects = Array.isArray(data.remoteAheadSubjects) ? data.remoteAheadSubjects : [];
  const selfUpdateHistory = Array.isArray(data.selfUpdateHistory) ? data.selfUpdateHistory : [];
  const remoteAheadCount = Number.isFinite(data.remoteAheadCount) ? data.remoteAheadCount : 0;
  const localAheadCount = Number.isFinite(data.localAheadCount) ? data.localAheadCount : 0;
  const headSha = data.headSha || '';
  const aheadColor =
    remoteAheadCount === 0
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm text-muted-foreground">当前版本</span>
        <CodePill>{headSha || '-'}</CodePill>
        {data.headIso ? (
          <span className="text-xs text-muted-foreground" title={formatAbsoluteTime(data.headIso)}>
            代码更新于 {formatRelativeTime(data.headIso)}
          </span>
        ) : null}
        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${aheadColor}`}>
          <GitBranch className="h-3.5 w-3.5" />
          {data.fetchOk
            ? remoteAheadCount === 0
              ? `已与 origin/${data.currentBranch} 同步`
              : `GitHub 领先 ${remoteAheadCount} 个 commit`
            : 'fetch 失败 / 远端不可达'}
        </span>
        {localAheadCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
            本地领先 {localAheadCount} 个 commit
          </span>
        ) : null}

        {data.lastSelfUpdate ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${selfUpdateStatusClass(data.lastSelfUpdate.status)}`}
            title="完整历史见下方"
          >
            <RotateCw className="h-3.5 w-3.5" />
            上次更新 · {formatRelativeTime(data.lastSelfUpdate.ts)} · {selfUpdateStatusLabel(data.lastSelfUpdate.status)}
          </span>
        ) : null}

        {data.restartStatus && data.restartStatus !== 'not_required' ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
              data.restartStatus === 'completed'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : data.restartStatus === 'pending'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
            }`}
            title={`PID ${data.runningPid || '-'} · 启动于 ${data.pidStartedAt ? formatAbsoluteTime(data.pidStartedAt) : '-'}`}
          >
            PID {data.runningPid || '-'} · 重启{data.restartStatus === 'completed' ? '已确认' : data.restartStatus === 'pending' ? '进行中' : '未确认'}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {selfUpdateHistory.length > 0 ? (
            <span className="text-xs text-muted-foreground">下方有最近 {Math.min(selfUpdateHistory.length, 20)} 条历史</span>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCw />
            刷新
          </Button>
        </div>
      </div>

      {/* 远端领先时,展开显示前 5 条新 commit subject 让用户秒判断「值不值得更新」 */}
      {data.fetchOk && remoteAheadCount > 0 && remoteAheadSubjects.length > 0 ? (
        <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">远端领先的 commit:</div>
          <ul className="mt-1.5 space-y-1 text-xs">
            {remoteAheadSubjects.map((c) => (
              <li key={c.sha} className="flex items-start gap-2">
                <CodePill>{c.sha}</CodePill>
                <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
                <span className="shrink-0 text-muted-foreground">{formatRelativeTime(c.date)}</span>
              </li>
            ))}
            {remoteAheadCount > remoteAheadSubjects.length ? (
              <li className="text-muted-foreground">… 还有 {remoteAheadCount - remoteAheadSubjects.length} 个</li>
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

function StepLevelPrefix({ level }: { level: 'info' | 'warning' | 'error' }): JSX.Element {
  // 用纯文本 prefix 避免 emoji(规则 #0),颜色靠 className 表达级别。
  if (level === 'error') return <span className="text-destructive">[ERR] </span>;
  if (level === 'warning') return <span className="text-amber-600 dark:text-amber-400">[WARN] </span>;
  return <span className="text-muted-foreground">· </span>;
}

type HistoryFetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; records: SelfUpdateRecord[] };

// 数据源上移到父组件 useSelfUpdateHistory(与进度条共用,不再自己 fetch)。
function SelfUpdateHistoryList({ historyState, onManualRefresh }: {
  historyState: HistoryFetchState;
  onManualRefresh: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string): void => setExpanded((cur) => ({ ...cur, [key]: !cur[key] }));
  const manualRefresh = onManualRefresh;

  if (historyState.status === 'loading') {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
    );
  }
  if (historyState.status === 'error') {
    return (
      <div className="py-8 text-center text-sm text-destructive">{historyState.message}</div>
    );
  }
  if (historyState.records.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">尚无历史</div>
    );
  }
  const stats = summariseHistory(historyState.records);
  return (
    <div className="max-h-[70vh] overflow-y-auto" style={{ overscrollBehavior: 'contain', minHeight: 0 }}>
      <div className="flex items-center justify-end pb-2">
        <Button type="button" variant="ghost" size="sm" onClick={manualRefresh}>
          <RefreshCw className="h-3 w-3" /> 刷新
        </Button>
      </div>
      <SelfUpdateHistoryStats stats={stats} />
      <ul className="divide-y divide-[hsl(var(--hairline))]">
        {historyState.records.map((rec, idx) => (
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
                /* 2026-05-07 timing 审视:durationMs = 后端流程,totalElapsedMs = 真实总耗时
                 * (含 daemon 重启 + SSE 重连)。两者都显示让用户看清楚体感差异。
                 * report.cds.self-update-timing-audit.md */
                <span className="text-xs text-muted-foreground" title={
                  rec.totalElapsedMs
                    ? `后端流程: ${(rec.durationMs / 1000).toFixed(1)}s · 重启 + SSE 恢复: ${((rec.totalElapsedMs - rec.durationMs) / 1000).toFixed(1)}s`
                    : '后端流程时间(不含 daemon 重启等待)'
                }>
                  {(rec.durationMs / 1000).toFixed(1)}s 流程
                  {rec.totalElapsedMs && rec.totalElapsedMs > rec.durationMs ? (
                    <span className="ml-1 text-foreground/70">
                      + {((rec.totalElapsedMs - rec.durationMs) / 1000).toFixed(1)}s 重启
                    </span>
                  ) : null}
                </span>
              ) : null}
              {(() => {
                const mode = rec.updateMode || (rec.noOp ? 'noOp' : undefined);
                if (!mode) return null;
                const tone =
                  mode === 'hot-reload'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : mode === 'web-only'
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
                      : mode === 'doc-only'
                        ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                        : mode === 'noOp'
                          ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
                const label =
                  mode === 'hot-reload'
                    ? '热重载'
                    : mode === 'web-only'
                      ? '零停机·前端'
                      : mode === 'doc-only'
                        ? '零停机·文档'
                        : mode === 'noOp'
                          ? '已是最新'
                          : '完整重启';
                const tip =
                  mode === 'hot-reload'
                    ? '应用代码改动,跳过 validate(节省 ~50s)走 systemd 软重启'
                    : mode === 'web-only'
                      ? '改动全部落在 cds/web/src/**:只重 web/dist + atomic rename,daemon 持续在线,刷新页面即生效(用户体感 0 停机)'
                      : mode === 'doc-only'
                        ? '改动全是文档 / changelogs:只更新 .build-sha 标记,不重 build 不重启'
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
            {rec.timings ? <SelfUpdateStageBar timings={rec.timings} totalMs={rec.durationMs} /> : null}
            {rec.error ? (
              <div className="mt-0.5 text-xs text-destructive/80" title={rec.error}>
                {rec.error.length > 200 ? rec.error.slice(0, 200) + '…' : rec.error}
              </div>
            ) : null}
            {(() => {
              const stepsLen = Array.isArray(rec.steps)
                ? rec.steps.length
                : (rec.stepsCount ?? 0);
              if (stepsLen === 0) return null;
              const hasFullSteps = Array.isArray(rec.steps) && rec.steps.length > 0;
              return (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => toggle(`${rec.ts}-${idx}`)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    disabled={!hasFullSteps}
                  >
                    {expanded[`${rec.ts}-${idx}`] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    完整步骤({stepsLen} 行)
                    {!hasFullSteps ? <span className="ml-1 text-muted-foreground/60">(仅元数据,打开「历史」抽屉看完整日志)</span> : null}
                  </button>
                  {expanded[`${rec.ts}-${idx}`] && hasFullSteps ? (
                    <pre
                      className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-[11px] leading-5"
                      style={{ overscrollBehavior: 'contain' }}
                    >
                      {rec.steps!.map((step, sIdx) => (
                        <div key={sIdx}>
                          <span className="text-muted-foreground/60">{step.ts.slice(11, 19)} </span>
                          <StepLevelPrefix level={step.level} />
                          {step.text}
                        </div>
                      ))}
                    </pre>
                  ) : null}
                </div>
              );
            })()}
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
    case 'deferred':
      return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
  }
}

function selfUpdateStatusLabel(status: SelfUpdateRecord['status']): string {
  switch (status) {
    case 'success': return '成功';
    case 'aborted': return '中止(校验未过)';
    case 'deferred': return '已延后';
    case 'failed':  return '失败';
  }
}

function selfUpdateTriggerLabel(trigger: SelfUpdateRecord['trigger']): string {
  switch (trigger) {
    case 'manual':     return '手动';
    case 'force-sync': return '强制更新';
    case 'auto-poll':  return '自动轮询';
    case 'webhook':    return 'GitHub webhook';
  }
}

// ─────────────────────────────────────────────────────────────
// 2026-05-28 自更新可观测性加强
// 用户反馈:"返回日志不正确" — 根因是前端类型缺 timings 字段,
// 后端 SelfUpdateTimingBreakdown 数据全在但 UI 没渲染。下面三件:
//   1. 聚合统计:成功率 / 平均/中位/p95 耗时 / 最长一条 + 阶段
//   2. 单条阶段耗时条:fetch / install / tsc / build / web-build 各占多少
//   3. 上述都按"实际有数据的字段"做,缺失字段不假装(以前没有就标 -)
// ─────────────────────────────────────────────────────────────

interface SelfUpdateHistoryStatsData {
  total: number;
  success: number;
  failed: number;
  deferred: number;
  aborted: number;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  fastestMs: number | null;
  slowestRec: SelfUpdateRecord | null;
}

function summariseHistory(records: SelfUpdateRecord[]): SelfUpdateHistoryStatsData {
  const total = records.length;
  let success = 0, failed = 0, deferred = 0, aborted = 0;
  const durations: number[] = [];
  let slowestRec: SelfUpdateRecord | null = null;
  for (const r of records) {
    if (r.status === 'success') success += 1;
    else if (r.status === 'failed') failed += 1;
    else if (r.status === 'deferred') deferred += 1;
    else if (r.status === 'aborted') aborted += 1;
    if (typeof r.durationMs === 'number' && r.durationMs > 0) {
      durations.push(r.durationMs);
      if (!slowestRec || (r.durationMs > (slowestRec.durationMs || 0))) slowestRec = r;
    }
  }
  durations.sort((a, b) => a - b);
  const sum = durations.reduce((s, v) => s + v, 0);
  const avgMs = durations.length > 0 ? Math.round(sum / durations.length) : null;
  const medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null;
  const p95Idx = Math.max(0, Math.floor(durations.length * 0.95) - 1);
  const p95Ms = durations.length > 0 ? durations[Math.min(p95Idx, durations.length - 1)] : null;
  const fastestMs = durations.length > 0 ? durations[0] : null;
  return { total, success, failed, deferred, aborted, avgMs, medianMs, p95Ms, fastestMs, slowestRec };
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function SelfUpdateHistoryStats({ stats }: { stats: SelfUpdateHistoryStatsData }): JSX.Element {
  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
  return (
    <div className="sticky top-0 z-10 mb-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-semibold">最近 {stats.total} 次:</span>
        <span className="rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-2 py-0.5">
          成功 {stats.success}
        </span>
        {stats.failed > 0 ? (
          <span className="rounded bg-red-500/10 text-red-700 dark:text-red-300 px-2 py-0.5">
            失败 {stats.failed}
          </span>
        ) : null}
        {stats.deferred > 0 ? (
          <span className="rounded bg-sky-500/10 text-sky-700 dark:text-sky-300 px-2 py-0.5">
            延后 {stats.deferred}
          </span>
        ) : null}
        {stats.aborted > 0 ? (
          <span className="rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-0.5">
            中止 {stats.aborted}
          </span>
        ) : null}
        <span className="text-muted-foreground">成功率 {successRate}%</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <div className="text-muted-foreground">最快</div>
          <div className="font-mono">{fmtMs(stats.fastestMs)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">中位</div>
          <div className="font-mono">{fmtMs(stats.medianMs)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">平均</div>
          <div className="font-mono">{fmtMs(stats.avgMs)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">P95</div>
          <div className="font-mono">{fmtMs(stats.p95Ms)}</div>
        </div>
      </div>
      {stats.slowestRec ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          最长一次:{fmtMs(stats.slowestRec.durationMs)} ·{' '}
          {selfUpdateStatusLabel(stats.slowestRec.status)} · {formatRelativeTime(stats.slowestRec.ts)}
          {stats.slowestRec.timings?.webBuildMs && stats.slowestRec.timings.webBuildMs > 60_000
            ? ` · web build 占 ${fmtMs(stats.slowestRec.timings.webBuildMs)}`
            : null}
        </div>
      ) : null}
    </div>
  );
}

// 自更新历史的统一数据源(进度条 + 历史列表共用,Bugbot #716:避免两处各自
// fetch 同一 endpoint)。只在三个时刻 re-fetch:首次 mount、一次更新真正结束
// (events.updating true→false)、用户点刷新。中间的 status/heartbeat/step 不刷。
function useSelfUpdateHistory(): { historyState: HistoryFetchState; manualRefresh: () => void } {
  const [historyState, setHistoryState] = useState<HistoryFetchState>({ status: 'loading' });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const events = useCdsEvents();
  const updatingPrev = useRef<typeof events.updating>(null);
  useEffect(() => {
    const wasUpdating = !!updatingPrev.current;
    const isUpdating = !!events.updating;
    updatingPrev.current = events.updating;
    if (wasUpdating && !isUpdating) setRefreshNonce((n) => n + 1);
  }, [events.updating]);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/self-update-history?limit=20'), { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { records: SelfUpdateRecord[] };
      })
      .then((data) => { if (!cancelled) setHistoryState({ status: 'ok', records: data.records || [] }); })
      .catch((err: Error) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[self-update-history] 拉取失败:', err.message);
        // 保留当前状态不变(避免刷成空);仅首次 loading 失败才落 error 态。
        setHistoryState((cur) => (cur.status === 'loading' ? { status: 'error', message: err.message } : cur));
      });
    return () => { cancelled = true; };
  }, [refreshNonce]);
  const manualRefresh = (): void => setRefreshNonce((n) => n + 1);
  return { historyState, manualRefresh };
}

// ──────────────────────────────────────────────────────────────────────────
// 进行中的更新「预计进度条」(2026-06-03 用户:"当前更新也用这个进度条,
// 让用户有大致预期")。原理:历史成功记录的各阶段耗时取中位数当"预期时间线",
// 进行中时按当前阶段(activeSelfUpdate.step)+ 已用时长把对应段填实,未到的段
// 淡显。给用户一个"还要多久"的体感,而不是只盯着秒表空等。
// ──────────────────────────────────────────────────────────────────────────
interface LiveStageDef {
  key: string;
  label: string;
  color: string;
  fields: Array<keyof SelfUpdateTimings>;
}
// 顺序必须与后端自更新流程一致(fetch → checkout → 依赖/类型校验 → 编译 → 重启)。
const LIVE_STAGE_DEFS: LiveStageDef[] = [
  { key: 'fetch',    label: '拉取',      color: 'bg-sky-500',     fields: ['fetchMs', 'pullMs'] },
  { key: 'checkout', label: '切分支',    color: 'bg-cyan-500',    fields: ['checkoutMs', 'resetMs'] },
  { key: 'install',  label: '依赖校验',  color: 'bg-indigo-500',  fields: ['validateInstallMs'] },
  { key: 'tsc',      label: '类型校验',  color: 'bg-amber-500',   fields: ['validateTscMs'] },
  { key: 'backend',  label: '后端编译',  color: 'bg-emerald-500', fields: ['buildBackendMs'] },
  { key: 'web',      label: 'web 重建',  color: 'bg-rose-500',    fields: ['webBuildMs', 'webOnlyMs'] },
  { key: 'restart',  label: '排空+重启', color: 'bg-fuchsia-500', fields: ['drainMs', 'restartMs'] },
];
// 后端 send(step,...) 的原始 step key → 展示段 key 的精确映射(Bugbot #716)。
// 只登记"能明确归到某个可见段"的步骤;过渡 / 收尾步骤(nginx-render / analyze /
// cache / validate-done / validate-timings 等)故意不登记 → 走 elapsed 兜底,
// 避免错误地跳到末尾(重启段)或回跳到类型校验。drain = 后端排空等待阶段。
const STEP_TO_STAGE_KEY: Record<string, string> = {
  fetch: 'fetch', pull: 'fetch',
  checkout: 'checkout', reset: 'checkout',
  // 注意:后端整段校验只发一个 'validate' step(install + tsc 合一,见
  // branches.ts send('validate',...)),没有独立的 validate-install / validate-tsc
  // step 事件。若把 'validate' 钉死到 install 段,tsc 期间(校验里最久的一段)
  // 进度条会卡在 install 不动(Codex #716)。所以 'validate' 故意不登记 → 走
  // elapsed 兜底,随时间从 install 平滑推进到 tsc。下面两条留作未来后端拆分
  // 子步骤时的精确映射(当前不会触发)。
  'validate-install': 'install',
  'validate-tsc': 'tsc',
  'build-backend': 'backend',
  'web-build': 'web', 'web-only': 'web',
  drain: 'restart', restart: 'restart',
};
// 无历史可估算时的兜底基线(ms,秒级),保证条至少能画出来。
const LIVE_FALLBACK_MS: Record<string, number> = {
  fetch: 1000, checkout: 200, install: 8000, tsc: 16000, backend: 1000, web: 14000, restart: 3000,
};

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// records 由父组件统一从 useSelfUpdateHistory 拿(与下方历史列表共用同一份,
// 不再各自 fetch —— 避免本进度条挂载时空 fetch、医到一半还显示"暂无历史"。Bugbot #716)。
function SelfUpdateLiveProgress({ elapsedMs, currentStep, records }: { elapsedMs: number; currentStep?: string; records: SelfUpdateRecord[] }): JSX.Element {
  const successSamples = records.filter((r) => r.status === 'success' && r.timings);
  const expected = useMemo(() => {
    return LIVE_STAGE_DEFS.map((def) => {
      const samples: number[] = [];
      for (const r of successSamples) {
        const t = r.timings!;
        let sum = 0; let has = false;
        for (const f of def.fields) {
          const v = t[f];
          if (typeof v === 'number' && v > 0) { sum += v; has = true; }
        }
        if (has) samples.push(sum);
      }
      return { ...def, ms: median(samples) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records]);

  // 逐段兜底(Codex #716):某段在历史里没有样本(如旧历史缺 drainMs、或 hot /
  // web-only 模式跑出来的记录缺后端/web 段)时,用基线值补上,而不是留 0 宽。
  // 否则新加的排空+重启段会零宽、ETA 也排除掉那段最长可达 180s 的等待 —— 恰恰
  // 是这条进度条最该解释的时间。只有当所有段都没样本时才整体走基线。
  const stages = expected.map((d) => (d.ms > 0 ? d : { ...d, ms: LIVE_FALLBACK_MS[d.key] ?? 1000 }));
  const etaMs = Math.max(stages.reduce((s, v) => s + v.ms, 0), 1);

  // 按已用时长落到对应段(用于过渡/收尾步骤的兜底,既不跳末尾也不回跳)。
  const idxByElapsed = (): number => {
    let acc = 0;
    for (let i = 0; i < stages.length; i++) { acc += stages[i].ms; if (elapsedMs < acc) return i; }
    return stages.length - 1;
  };
  // 当前阶段索引:先用精确映射;映射不到的过渡/收尾步骤(nginx-render / analyze /
  // cache / validate-done / validate-timings 等)走 elapsed 兜底。
  const curIdx = (() => {
    const mappedKey = currentStep ? STEP_TO_STAGE_KEY[currentStep] : undefined;
    if (mappedKey) {
      const i = stages.findIndex((s) => s.key === mappedKey);
      if (i >= 0) return i;
    }
    return idxByElapsed();
  })();

  const beforeMs = stages.slice(0, curIdx).reduce((s, v) => s + v.ms, 0);
  const curMs = stages[curIdx]?.ms || 1;
  const stageEndMs = beforeMs + curMs;
  const cap = etaMs * 0.99;
  // 单一进度时钟(Bugbot #716):step 给下限(已确认进入当前阶段 → 至少推进到该段
  // 起点),其余跟随真实 elapsed,但在收到下一个 step 前不冲过当前阶段末尾;
  // 超过总预期则顶到 ETA。percent / 段填充 / 「预计还需」全部由这一个 progressedMs
  // 派生,三者永远一致(避免"早期阶段比中位数快 → 百分比冲顶但预计还需还很大")。
  let progressedMs = Math.max(beforeMs, Math.min(elapsedMs, stageEndMs));
  if (elapsedMs >= etaMs) progressedMs = etaMs;
  progressedMs = Math.min(progressedMs, cap);
  const overEta = elapsedMs > etaMs;
  const remainMs = Math.max(0, etaMs - progressedMs);
  const pct = Math.min(99, Math.round((progressedMs / etaMs) * 100));
  // 每段起点(累加),用于按 progressedMs 统一计算填充比例。
  let accStart = 0;
  const segStarts = stages.map((s) => { const start = accStart; accStart += s.ms; return start; });

  return (
    <div className="space-y-2 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          <span className="font-mono font-medium text-foreground/80">{pct}%</span>
          {' · '}
          {successSamples.length > 0
            ? `基于近 ${successSamples.length} 次成功更新的中位数`
            : '暂无历史 · 粗略估算'}
        </span>
        <span className={overEta ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-foreground/80'}>
          已用 {fmtMs(elapsedMs)} · {overEta ? '预计已到点,收尾中' : `预计还需 ~${fmtMs(remainMs)}`}
          <span className="ml-1 font-normal text-muted-foreground">/ 预计约 {fmtMs(etaMs)}</span>
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-sm bg-[hsl(var(--surface-sunken))]">
        {stages.map((seg, i) => {
          const widthPct = (seg.ms / etaMs) * 100;
          const isCur = i === curIdx;
          // 填充比例统一由 progressedMs 派生:已过段→100%、当前段→部分、未到→0%。
          const fillPct = Math.max(0, Math.min(1, (progressedMs - segStarts[i]) / (seg.ms || 1))) * 100;
          return (
            <div
              key={seg.key}
              className="relative h-full"
              style={{ width: `${widthPct}%` }}
              title={`${seg.label}: 预计 ${fmtMs(seg.ms)}`}
            >
              {/* 计划层(淡显)+ 实际填充层(实色,当前段脉冲) */}
              <div className={`absolute inset-0 ${seg.color} opacity-20`} />
              <div
                className={`absolute inset-y-0 left-0 ${seg.color} ${isCur ? 'animate-pulse' : ''}`}
                style={{ width: `${fillPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {stages.map((seg, i) => (
          <span key={seg.key} className={i === curIdx ? 'font-medium text-foreground' : ''}>
            <span className={`inline-block h-2 w-2 align-middle ${seg.color} ${i <= curIdx ? '' : 'opacity-30'}`} />{' '}
            {seg.label} {fmtMs(seg.ms)}
          </span>
        ))}
      </div>
    </div>
  );
}

// 阶段耗时条:把 timings 里的各阶段按比例横向铺出来,鼠标悬停看每段名字 + 数值。
// 之前用户看的只是 "X.Xs 流程" 一个数字,完全看不出 25s 是 tsc 还是 web build 占的。
interface StageSeg { key: string; label: string; ms: number; color: string }
function SelfUpdateStageBar({ timings, totalMs }: { timings: SelfUpdateTimings; totalMs?: number }): JSX.Element | null {
  const segments: StageSeg[] = [];
  const push = (key: string, label: string, ms: number | undefined, color: string): void => {
    if (typeof ms === 'number' && ms > 0) segments.push({ key, label, ms, color });
  };
  push('fetch', '拉取', (timings.fetchMs ?? 0) + (timings.pullMs ?? 0), 'bg-sky-500/70');
  push('checkout', '切分支', (timings.checkoutMs ?? 0) + (timings.resetMs ?? 0), 'bg-cyan-500/70');
  push('nginx', 'nginx 渲染', timings.nginxRenderMs, 'bg-violet-500/70');
  push('install', 'pnpm install', timings.validateInstallMs, 'bg-indigo-500/70');
  push('tsc', '类型校验', timings.validateTscMs, 'bg-amber-500/70');
  push('cache', '清缓存', timings.cacheMs, 'bg-stone-500/70');
  push('backend', '后端 esbuild', timings.buildBackendMs, 'bg-emerald-500/70');
  push('web', 'web 重建', timings.webBuildMs, 'bg-rose-500/70');
  push('drain', '等待排空', timings.drainMs, 'bg-fuchsia-600/70');
  push('restart', '重启', timings.restartMs, 'bg-fuchsia-500/70');

  if (segments.length === 0) return null;

  const totalSeg = segments.reduce((s, v) => s + v.ms, 0);
  const total = Math.max(totalSeg, timings.totalMs ?? 0, totalMs ?? 0);
  if (total === 0) return null;

  // 2026-06-03 用户反馈:进度条大片黢黑 + 看不到"总计"。根因是各 step 之和
  // (totalSeg)远小于 total(含排空等待 / 进程退出后才发生的重启)。把差额补成
  // 一段中性灰"其他",让进度条铺满;再单列"总计"chip,让用户对得上账。
  const otherMs = Math.max(0, total - totalSeg);
  // 阈值 1.5s 以下视作测量噪音(step 之间的零碎间隙),不单列,避免一堆碎段。
  const OTHER_THRESHOLD_MS = 1500;
  const barSegments: StageSeg[] =
    otherMs > OTHER_THRESHOLD_MS
      ? [...segments, { key: 'other', label: '其他', ms: otherMs, color: 'bg-muted-foreground/30' }]
      : segments;

  return (
    <div className="mt-1 space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-[hsl(var(--surface-sunken))]">
        {barSegments.map((seg) => (
          <div
            key={seg.key}
            className={seg.color}
            style={{ width: `${(seg.ms / total) * 100}%` }}
            title={`${seg.label}: ${fmtMs(seg.ms)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {barSegments.map((seg) => (
          <span key={seg.key}>
            <span className={`inline-block h-2 w-2 align-middle ${seg.color}`} />{' '}
            {seg.label} {fmtMs(seg.ms)}
          </span>
        ))}
        <span className="font-medium text-foreground/80" title="各阶段实测总和(含排空等待 / 未计量的进程退出后重启)">
          总计 {fmtMs(total)}
        </span>
        {timings.webBuildSkipped ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            (web 命中缓存 · {timings.webBuildReason})
          </span>
        ) : null}
      </div>
    </div>
  );
}
