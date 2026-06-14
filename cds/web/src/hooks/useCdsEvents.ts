/*
 * useCdsEvents — 单例 EventSource 全局共享 + 前端状态机
 *
 * 设计目标(对齐目标文档第 3 / 5 / 6 节):
 *   - 整个浏览器 tab 只建立一条 SSE 长连接(GET /api/cds-events),所有
 *     组件订阅同一个 store。GlobalUpdateBadge + MaintenanceTab + 任何其他
 *     需要 self-update 状态的组件共享。
 *   - 提供明确的状态机:idle / connecting / connected / degraded /
 *     refreshing / updating / disconnected / error
 *   - 单次 SSE 断开不显示 "CDS 不可达",连续断开(>= 3 次)才进 disconnected
 *   - 5xx / 网络错误指数退避,最多 3 次后停;4xx 不重试
 *   - degraded 显示黄警告,不清空 lastKnownGood,继续展示
 *
 * 不做的事:
 *   - 不再各组件自行调 /api/self-status?probe=remote(改由本 hook 在需要时
 *     POST /api/self-refresh)
 *   - 不再 setInterval 轮询。心跳由后端 25s 一条 heartbeat 决定健康。
 */

import { useEffect, useSyncExternalStore } from 'react';
import { apiUrl } from '@/lib/api';

// 与后端 cds-events-bus.ts 的 CdsEventType 对应
export type CdsEventType =
  | 'self.status'
  | 'self.refresh.started'
  | 'self.refresh.done'
  | 'self.refresh.failed'
  | 'self.update.started'
  | 'self.update.step'
  | 'self.update.done'
  | 'self.update.failed'
  // 2026-05-28:agent 导入审批 + infra flap 告警
  | 'pending-import.created'
  | 'pending-import.decided'
  | 'pending-import.count'
  // 2026-06-04:被动授权 — agent 授权申请事件(右下角审批盒实时刷新)
  | 'access-request.created'
  | 'access-request.decided'
  | 'access-request.count'
  // 2026-05-29:operator 审批请求事件(审批弹窗实时刷新)
  | 'operator.request.created'
  | 'operator.request.approved'
  | 'operator.request.rejected'
  | 'operator.request.log'
  | 'operator.request.completed'
  | 'operator.request.failed'
  | 'infra.flap.circuit-breaker'
  // 2026-06-11:Agent 请求观测台 — 会话活动事件(创建/状态翻转/收发节点)
  | 'agent-session.activity'
  | 'heartbeat';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'refreshing'
  | 'updating'
  | 'disconnected'
  | 'error';

export interface CdsEventEnvelope<T = unknown> {
  type: CdsEventType;
  ts: string;
  jobId?: string;
  data: T;
}

/** 与后端 SelfStatusSnapshot 对齐(松散类型,允许字段渐进式扩展) */
export interface SelfStatusSnapshot {
  currentBranch: string;
  headSha: string;
  headIso?: string;
  webBuildSha?: string;
  webBuildError?: string;
  runningPid?: number;
  pidStartedAt?: string | null;
  restartStatus?: 'not_required' | 'pending' | 'completed' | 'incomplete';
  activeSelfUpdate?: unknown;
  lastSelfUpdate?: unknown;
  selfUpdateHistory?: unknown[];
  remoteAheadCount?: number;
  localAheadCount?: number;
  remoteAheadSubjects?: unknown[];
  remoteBranches?: Array<{
    name: string;
    committerDate: string;
    commitHash: string;
    subject: string;
    cdsTouched: boolean;
  }>;
  fetchOk?: boolean;
  fetchError?: string;
  bundleStale?: boolean;
  bundleFreshness?: unknown;
  systemdUnitDrift?: unknown;
  daemonReadyAt?: string | null;
  lastRefreshAt?: string | null;
  lastRefreshDurationMs?: number | null;
  lastRefreshTrigger?: string | null;
  lastError?: string | null;
  degraded?: {
    degraded: boolean;
    reason: string;
    message: string;
  } | null;
  cachedAt?: string;
}

interface StoreState {
  /** 当前 EventSource 连接状态(基础态:idle/connecting/connected/disconnected/error) */
  connection: ConnectionState;
  /** snapshot — 永远是后端权威数据。degraded 不清空它,UI 用 degraded 标志决定渲染色 */
  snapshot: SelfStatusSnapshot | null;
  /** 最近一次成功 snapshot(degraded 时回退展示) */
  lastKnownGood: SelfStatusSnapshot | null;
  /** 当前正在跑的 refresh job(null = 没在跑) */
  refreshing: { jobId: string; trigger: string; startedAt: string } | null;
  /** 当前正在跑的 self-update job(null = 没在跑) */
  updating: { startedAt: string; branch?: string; step?: string } | null;
  /** 最近收到 heartbeat 的时间(检测连接是否真的活着) */
  lastHeartbeatAt: string | null;
  /** 2026-05-28:agent 导入审批事件的最新 envelope(组件用 ts 触发刷新) */
  lastPendingImportEvent: { type: 'created' | 'decided' | 'count'; ts: string; pendingCount?: number; importId?: string } | null;
  /** 2026-05-28:infra flap 熔断告警(组件展示右下角 toast) */
  lastFlapEvent: { containerName: string; restartCount: number; message: string; ts: string } | null;
  /** 2026-06-04:被动授权 — agent 授权申请事件的最新 envelope(右下角审批盒据此刷新) */
  lastAccessRequestEvent: { type: 'created' | 'decided' | 'count'; ts: string; pendingCount?: number; requestId?: string } | null;
  /** 2026-05-29:operator 审批请求事件(审批弹窗据此实时刷新,不再等 25s heartbeat) */
  lastOperatorRequestEvent: {
    type: 'created' | 'approved' | 'rejected' | 'log' | 'completed' | 'failed';
    ts: string;
    requestId?: string;
  } | null;
  /** 2026-06-11:Agent 请求活动事件的最新 envelope(观测台据此静默刷新列表) */
  lastAgentActivityEvent: {
    ts: string;
    projectId?: string;
    sessionId?: string;
    eventType?: string;
    status?: string;
  } | null;
  /** 连续失败次数(用于退避 + 是否进 disconnected) */
  consecutiveErrors: number;
  /** 最近一次错误 */
  lastError: string | null;
}

const INITIAL_STATE: StoreState = {
  connection: 'idle',
  snapshot: null,
  lastKnownGood: null,
  refreshing: null,
  updating: null,
  lastHeartbeatAt: null,
  lastPendingImportEvent: null,
  lastFlapEvent: null,
  lastAccessRequestEvent: null,
  lastOperatorRequestEvent: null,
  lastAgentActivityEvent: null,
  consecutiveErrors: 0,
  lastError: null,
};

// ── 单例 store ──────────────────────────────────────────────────────
let state: StoreState = INITIAL_STATE;
const listeners = new Set<() => void>();
let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let connectAttempt = 0;
let stopped = false; // 用户调用 stop() 后置 true,不再自动重连

function emit(): void {
  for (const l of listeners) l();
}

function setState(partial: Partial<StoreState>): void {
  state = { ...state, ...partial };
  emit();
}

function derivedConnection(): ConnectionState {
  if (stopped) return 'idle';
  // 优先 updating / refreshing(代表"正在做事")
  if (state.updating) return 'updating';
  if (state.refreshing) return 'refreshing';
  if (state.connection === 'disconnected' || state.connection === 'error') return state.connection;
  // degraded 优先级低于 connecting/error,但高于 connected
  if (state.snapshot?.degraded && state.connection === 'connected') return 'degraded';
  return state.connection;
}

// ── 连接管理 ─────────────────────────────────────────────────────────
function openConnection(): void {
  if (typeof window === 'undefined') return;
  if (eventSource) return;
  if (stopped) return;

  setState({ connection: 'connecting', lastError: null });

  const url = apiUrl('/api/cds-events');
  let es: EventSource;
  try {
    es = new EventSource(url, { withCredentials: true });
  } catch (err) {
    handleFatalError(err as Error);
    return;
  }
  eventSource = es;

  const onOpen = (): void => {
    connectAttempt = 0;
    setState({ connection: 'connected', consecutiveErrors: 0, lastError: null });
  };

  const handleEvent = (type: CdsEventType, raw: MessageEvent): void => {
    let envelope: CdsEventEnvelope;
    try {
      envelope = JSON.parse(raw.data) as CdsEventEnvelope;
    } catch {
      return;
    }
    routeEvent(type, envelope);
  };

  es.onopen = onOpen;
  es.onerror = onError;

  // 注册所有事件类型
  const types: CdsEventType[] = [
    'self.status',
    'self.refresh.started',
    'self.refresh.done',
    'self.refresh.failed',
    'self.update.started',
    'self.update.step',
    'self.update.done',
    'self.update.failed',
    'pending-import.created',
    'pending-import.decided',
    'pending-import.count',
    'access-request.created',
    'access-request.decided',
    'access-request.count',
    // Codex review(PR #684, P2):后端发 operator.request.* 时审批弹窗要实时反应,
    // 此前只注册到 heartbeat → 审批请求最多隐身 25s。
    'operator.request.created',
    'operator.request.approved',
    'operator.request.rejected',
    'operator.request.log',
    'operator.request.completed',
    'operator.request.failed',
    'infra.flap.circuit-breaker',
    // 2026-06-11:Agent 请求观测台实时行内更新
    'agent-session.activity',
    'heartbeat',
  ];
  for (const type of types) {
    es.addEventListener(type, (evt) => handleEvent(type, evt as MessageEvent));
  }
}

function routeEvent(type: CdsEventType, envelope: CdsEventEnvelope): void {
  switch (type) {
    case 'self.status': {
      const snapshot = envelope.data as SelfStatusSnapshot;
      const next: Partial<StoreState> = { snapshot };
      if (snapshot && !snapshot.degraded) {
        next.lastKnownGood = snapshot;
      }
      setState(next);
      break;
    }
    case 'self.refresh.started': {
      const data = envelope.data as { jobId?: string; trigger?: string };
      setState({
        refreshing: {
          jobId: envelope.jobId ?? data.jobId ?? '',
          trigger: data.trigger ?? 'manual',
          startedAt: envelope.ts,
        },
      });
      break;
    }
    case 'self.refresh.done':
    case 'self.refresh.failed': {
      setState({ refreshing: null });
      if (type === 'self.refresh.failed') {
        const data = envelope.data as { error?: string };
        setState({ lastError: data.error ?? 'refresh failed' });
      }
      break;
    }
    case 'self.update.started': {
      const data = envelope.data as { startedAt?: string; branch?: string; step?: string };
      setState({
        updating: {
          startedAt: data.startedAt ?? envelope.ts,
          branch: data.branch,
          step: data.step,
        },
      });
      break;
    }
    case 'self.update.step': {
      const data = envelope.data as { step?: string };
      if (state.updating) {
        setState({ updating: { ...state.updating, step: data.step } });
      }
      break;
    }
    case 'self.update.done':
    case 'self.update.failed': {
      setState({ updating: null });
      if (type === 'self.update.failed') {
        const data = envelope.data as { status?: string };
        setState({ lastError: `self-update ${data.status ?? 'failed'}` });
      }
      break;
    }
    case 'pending-import.created':
    case 'pending-import.decided':
    case 'pending-import.count': {
      const data = (envelope.data || {}) as { pendingCount?: number; importId?: string };
      const evtType = type === 'pending-import.created' ? 'created'
        : type === 'pending-import.decided' ? 'decided' : 'count';
      setState({
        lastPendingImportEvent: {
          type: evtType,
          ts: envelope.ts,
          pendingCount: data.pendingCount,
          importId: data.importId,
        },
      });
      break;
    }
    case 'access-request.created':
    case 'access-request.decided':
    case 'access-request.count': {
      const data = (envelope.data || {}) as { pendingCount?: number; requestId?: string };
      const evtType = type === 'access-request.created' ? 'created'
        : type === 'access-request.decided' ? 'decided' : 'count';
      setState({
        lastAccessRequestEvent: {
          type: evtType,
          ts: envelope.ts,
          pendingCount: data.pendingCount,
          requestId: data.requestId,
        },
      });
      break;
    }
    case 'operator.request.created':
    case 'operator.request.approved':
    case 'operator.request.rejected':
    case 'operator.request.log':
    case 'operator.request.completed':
    case 'operator.request.failed': {
      const data = (envelope.data || {}) as { requestId?: string; id?: string };
      const evtType = type.slice('operator.request.'.length) as
        'created' | 'approved' | 'rejected' | 'log' | 'completed' | 'failed';
      setState({
        lastOperatorRequestEvent: {
          type: evtType,
          ts: envelope.ts,
          requestId: data.requestId ?? data.id,
        },
      });
      break;
    }
    case 'agent-session.activity': {
      const data = (envelope.data || {}) as {
        projectId?: string; sessionId?: string; eventType?: string; status?: string;
      };
      setState({
        lastAgentActivityEvent: {
          ts: envelope.ts,
          projectId: data.projectId,
          sessionId: data.sessionId,
          eventType: data.eventType,
          status: data.status,
        },
      });
      break;
    }
    case 'infra.flap.circuit-breaker': {
      const data = (envelope.data || {}) as { containerName?: string; restartCount?: number; message?: string };
      setState({
        lastFlapEvent: {
          containerName: String(data.containerName || ''),
          restartCount: Number(data.restartCount || 0),
          message: String(data.message || ''),
          ts: envelope.ts,
        },
      });
      break;
    }
    case 'heartbeat': {
      setState({ lastHeartbeatAt: envelope.ts });
      break;
    }
  }
}

function onError(): void {
  // EventSource 的 error 事件不带 HTTP 状态码,只能凭 readyState 区分。
  // 关键:浏览器内置在收到非 2xx(包括 Cloudflare 400)后会**自动**每 ~3s
  // 重连。如果不主动 close,浏览器会无限重试,DevTools 中堆出大量 400 红条。
  // 用户反馈 2026-05-28:快速切换左侧 Projects/Settings 时 cds-events 出现
  // 大量 400 — 根因就是这条浏览器原生重试。修复:第一次 onerror 就 close,
  // 切到我们自己控制的 exponential backoff。
  if (!eventSource) return;
  const next = state.consecutiveErrors + 1;
  setState({ consecutiveErrors: next });
  maybeFlagDisconnected();
  // 立刻 close 阻止浏览器内置重试 — 后续是否再连由 scheduleReconnect 决定。
  // CLOSED 表示浏览器已经主动关了,这种情况也跟着清理 + 重连。
  closeConnection();
  scheduleReconnect();
}

function handleFatalError(err: Error): void {
  setState({
    connection: 'error',
    lastError: err.message,
    consecutiveErrors: state.consecutiveErrors + 1,
  });
}

function closeConnection(): void {
  if (eventSource) {
    try { eventSource.close(); } catch { /* tolerate */ }
    eventSource = null;
  }
}

function maybeFlagDisconnected(): void {
  // 连续断开 >= 3 次才显示 "CDS 不可达",对应目标文档第 5 节
  if (state.consecutiveErrors >= 3 && state.connection !== 'disconnected') {
    setState({ connection: 'disconnected' });
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer != null) return;
  connectAttempt += 1;
  // 5xx / 网络:指数退避 5s, 10s, 20s,最多 3 次后停。
  // 比之前的 1/2/4s 更长 — 因为 Cloudflare 偶发 400 + 浏览器内置 ~3s 重试时,
  // 短退避会让 retry 风暴叠加,DevTools 堆 10+ 红条。给后端足够喘息时间。
  if (connectAttempt > 3) {
    setState({ connection: 'disconnected' });
    return;
  }
  const delay = Math.min(20_000, 5_000 * Math.pow(2, connectAttempt - 1));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    openConnection();
  }, delay);
}

// ── 公开 API ────────────────────────────────────────────────────────
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 首个订阅者出现时打开连接
  if (listeners.size === 1) {
    stopped = false;
    connectAttempt = 0;
    openConnection();
  }
  return () => {
    listeners.delete(listener);
    // 最后一个订阅者离开时不立即关闭;留给 page unload 清理。
    // 主因:React Strict Mode dev 期间会瞬间 unsub→sub,关再开成本高 + 触发后端
    // 重复 startup refresh。生产环境 SPA 内组件挂载/卸载也不应频繁重启 SSE。
    // 真正的关闭由 stop() 显式调用(目前没人调,SPA tab 关闭时浏览器自动 GC)。
  };
}

function getSnapshot(): StoreState {
  return state;
}

/** 触发一次 refresh(POST /api/self-refresh,202 + jobId)。重复点击同时间窗口内复用同一 job。
 * 副作用:若当前 SSE 已 disconnected/error,顺手强制重连一次(用户点击 = 明确意图)。*/
export async function requestRefresh(trigger: 'manual' | 'webhook' = 'manual'): Promise<void> {
  // 如果 SSE 已挂了,趁用户点击的机会重置 backoff 计数器并重连
  if (state.connection === 'disconnected' || state.connection === 'error') {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectAttempt = 0;
    setState({ consecutiveErrors: 0, lastError: null });
    closeConnection();
    openConnection();
  }
  try {
    const res = await fetch(apiUrl('/api/self-refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger }),
    });
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`self-refresh ${res.status}: ${text.slice(0, 200)}`);
    }
    // refreshing 状态由 SSE 的 self.refresh.started 事件接管
  } catch (err) {
    setState({ lastError: (err as Error).message });
    throw err;
  }
}

/** 兼容老组件:返回派生的 connection 状态(含 refreshing/updating/degraded) */
export interface UseCdsEventsResult extends StoreState {
  effectiveConnection: ConnectionState;
  requestRefresh: typeof requestRefresh;
}

export function useCdsEvents(): UseCdsEventsResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // 当组件卸载/挂载时确保连接存在
  useEffect(() => {
    if (!eventSource && !stopped && listeners.size > 0) {
      openConnection();
    }
  }, []);
  return {
    ...snapshot,
    effectiveConnection: derivedConnection(),
    requestRefresh,
  };
}

// 测试用 — 仅 dev 调用
export function _resetForTests(): void {
  closeConnection();
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connectAttempt = 0;
  stopped = false;
  state = INITIAL_STATE;
  listeners.clear();
}
