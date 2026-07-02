/*
 * Agent 请求观测台（2026-06-11 用户信任诉求）
 *
 * 「我能看得见一条条最新请求的事件、收发内容、实时状态、历史、按用户/按 app 筛选，
 *  这时候我就相信了——这就是真的强大的远程 CDS agent。」
 *
 * 数据源：
 *   - GET /api/projects/:id/agent-requests（live 内存会话 + 持久历史摘要合并，支持筛选）
 *   - 实时：useCdsEvents 单例 SSE 的 agent-session.activity 信号 → 静默刷新列表
 *   - 行展开：GET .../agent-sessions/:sid/stream?afterSeq=0 一次性回放完整事件流
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react';

import { AppShell, Crumb, TopBar, Workspace } from '@/components/layout/AppShell';
import { apiRequest, apiUrl, ApiError } from '@/lib/api';
import { useCdsEvents } from '@/hooks/useCdsEvents';

interface AgentRequestItem {
  sessionId: string;
  projectId: string;
  title: string | null;
  clientUser: string | null;
  clientApp: string | null;
  runtime: string;
  model: string | null;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number;
  eventCount: number;
  requestPreview: string | null;
  responsePreview: string | null;
  live: boolean;
}

interface AgentRequestsResp {
  items: AgentRequestItem[];
  users: string[];
  apps: string[];
  liveCount: number;
  historyCount: number;
}

interface AgentEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const STATUS_STYLE: Record<string, { label: string; cls: string; pulse?: boolean }> = {
  running: { label: '运行中', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30', pulse: true },
  creating: { label: '创建中', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30', pulse: true },
  idle: { label: '已完成', cls: 'bg-sky-500/12 text-sky-600 dark:text-sky-300 border-sky-500/25' },
  stopping: { label: '停止中', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30' },
  stopped: { label: '已停止', cls: 'bg-foreground/8 text-muted-foreground border-border' },
  failed: { label: '失败', cls: 'bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/30' },
};

function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function AgentRequestsPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [data, setData] = useState<AgentRequestsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fUser, setFUser] = useState('');
  const [fApp, setFApp] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fQ, setFQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[] | 'loading' | 'error'>>({});
  const fetchSeqRef = useRef(0);
  const { lastAgentActivityEvent, effectiveConnection } = useCdsEvents();

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!projectId) return;
    const seq = ++fetchSeqRef.current;
    if (!opts?.silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (fUser) params.set('user', fUser);
      if (fApp) params.set('app', fApp);
      if (fStatus) params.set('status', fStatus);
      if (fQ.trim()) params.set('q', fQ.trim());
      params.set('limit', '200');
      const resp = await apiRequest<AgentRequestsResp>(
        `/api/projects/${encodeURIComponent(projectId)}/agent-requests?${params.toString()}`,
      );
      if (seq !== fetchSeqRef.current) return;
      setData(resp);
      setError(null);
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [projectId, fUser, fApp, fStatus, fQ]);

  useEffect(() => { void load(); }, [load]);

  // 兜底轮询 5s（SSE 丢事件时列表仍然活着）
  useEffect(() => {
    const t = setInterval(() => { void load({ silent: true }); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  // 实时：agent-session.activity 信号到达且属于本项目 → 静默刷新
  const lastTsRef = useRef('');
  useEffect(() => {
    if (!lastAgentActivityEvent) return;
    if (lastAgentActivityEvent.projectId && lastAgentActivityEvent.projectId !== projectId) return;
    if (lastAgentActivityEvent.ts === lastTsRef.current) return;
    lastTsRef.current = lastAgentActivityEvent.ts;
    void load({ silent: true });
  }, [lastAgentActivityEvent, load, projectId]);

  // 行展开：一次性回放完整事件流（终态会话即全量；运行中会话回放到当前）
  const loadEvents = useCallback(async (sessionId: string) => {
    setEventsBySession((prev) => ({ ...prev, [sessionId]: 'loading' }));
    try {
      const url = apiUrl(`/api/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}/stream?afterSeq=0`);
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events: AgentEvent[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as AgentEvent;
            if (typeof evt.type === 'string') events.push(evt);
          } catch { /* keepalive 等非事件帧 */ }
        }
      }
      setEventsBySession((prev) => ({ ...prev, [sessionId]: events }));
    } catch {
      setEventsBySession((prev) => ({ ...prev, [sessionId]: 'error' }));
    }
  }, [projectId]);

  const toggleExpand = useCallback((sessionId: string) => {
    setExpanded((cur) => {
      const next = cur === sessionId ? null : sessionId;
      if (next && eventsBySession[next] === undefined) void loadEvents(next);
      return next;
    });
  }, [eventsBySession, loadEvents]);

  const items = data?.items ?? [];
  const sseLive = effectiveConnection === 'connected';
  const statusOptions = useMemo(() => ['', 'running', 'idle', 'stopped', 'failed'], []);

  return (
    // 2026-07-02 布局归一:本页此前游离于 AppShell 之外(无侧栏无顶栏 + 私有
    // max-w-6xl),是"每页一套秩序"的反例。现接入标准外壳:面包屑进 TopBar,
    // 实时状态进 right 槽,内容走 Workspace 标准宽度。
    <AppShell
      active="projects"
      topbar={
        <TopBar
          left={
            <Crumb
              items={[
                { label: 'CDS' },
                { label: '项目', href: '/project-list' },
                { label: projectId, href: `/branches/${encodeURIComponent(projectId)}` },
                { label: 'Agent 请求观测台' },
              ]}
            />
          }
          right={
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-indicator">
              <span className={['inline-block w-2 h-2 rounded-full', sseLive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'].join(' ')} />
              {sseLive ? '实时已连接（SSE）' : '实时降级（5s 轮询）'}
            </span>
          }
        />
      }
    >
      <Workspace className="flex flex-col gap-4">
      {/* 筛选条：按用户 / 按应用 / 状态 / 关键字 */}
      <div className="flex items-center gap-2 flex-wrap rounded-lg border border-border bg-card px-3 py-2" data-testid="request-filters">
        <select
          value={fApp}
          onChange={(e) => setFApp(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          data-testid="filter-app"
        >
          <option value="">全部应用</option>
          {(data?.apps ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          value={fUser}
          onChange={(e) => setFUser(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          data-testid="filter-user"
        >
          <option value="">全部用户</option>
          {(data?.users ?? []).map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <select
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          {statusOptions.map((st) => (
            <option key={st} value={st}>{st === '' ? '全部状态' : (STATUS_STYLE[st]?.label ?? st)}</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={fQ}
            onChange={(e) => setFQ(e.target.value)}
            placeholder="搜标题 / 模型 / 收发内容..."
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs"
            data-testid="filter-q"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-accent"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          live {data?.liveCount ?? 0} · 历史 {data?.historyCount ?? 0}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-600 dark:text-red-300">{error}</div>
      )}

      {/* 请求列表：一条 = 一次 agent 会话（title/label + 收发预览 + 状态/耗时） */}
      <div className="flex flex-col gap-2" data-testid="request-list">
        {items.length === 0 && !loading && (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            还没有 Agent 请求。MAP 侧发起生成（如 PPT 创作工作台）后，请求会实时出现在这里。
          </div>
        )}
        {items.map((item) => {
          const st = STATUS_STYLE[item.status] ?? { label: item.status, cls: 'bg-foreground/8 text-muted-foreground border-border' };
          const open = expanded === item.sessionId;
          const events = eventsBySession[item.sessionId];
          return (
            <div
              key={item.sessionId}
              className={['rounded-lg border bg-card transition-colors', open ? 'border-emerald-500/40' : 'border-border'].join(' ')}
              data-testid={'request-row-' + item.sessionId}
            >
              <button
                type="button"
                onClick={() => toggleExpand(item.sessionId)}
                className="w-full px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {open ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
                  <span className={['inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium', st.cls].join(' ')}>
                    {st.pulse && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                    {st.label}
                  </span>
                  <span className="text-sm font-medium truncate max-w-[280px]">{item.title || item.sessionId.slice(0, 18)}</span>
                  {item.clientApp && (
                    <span className="rounded bg-sky-500/12 border border-sky-500/25 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-300">{item.clientApp}</span>
                  )}
                  {item.clientUser && (
                    <span className="rounded bg-foreground/6 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground" title={item.clientUser}>
                      {item.clientUser.slice(0, 10)}
                    </span>
                  )}
                  {item.model && <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[170px]">{item.model}</span>}
                  {item.live && <span className="text-[9px] text-emerald-500 font-semibold">LIVE</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {fmtTime(item.createdAt)} · {fmtDuration(item.durationMs)} · {item.eventCount} 事件
                  </span>
                </div>
                <div className="mt-1.5 grid gap-1 md:grid-cols-2 text-[11px]">
                  <div className="truncate text-muted-foreground">
                    <span className="text-sky-600 dark:text-sky-400 font-medium">发 </span>
                    {item.requestPreview ?? '（无请求消息）'}
                  </div>
                  <div className="truncate text-muted-foreground">
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">收 </span>
                    {item.responsePreview ?? '（尚无返回）'}
                  </div>
                </div>
              </button>

              {open && (
                <div className="border-t border-border px-3 py-2.5 flex flex-col gap-2.5" data-testid="request-detail">
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div>
                      <div className="text-[10px] font-semibold text-sky-600 dark:text-sky-400 mb-1">请求内容（messages[0]）</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 text-[11px] leading-relaxed">
                        {item.requestPreview ?? '（无）'}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 mb-1">返回内容（finalText 截断 2000 字）</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 text-[11px] leading-relaxed">
                        {item.responsePreview ?? '（尚无返回）'}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold text-muted-foreground mb-1">
                      完整事件流（{item.live ? '内存实录' : '会话已结束——live 会话才有全量事件，历史仅保留收发摘要'}）
                    </div>
                    {events === 'loading' && <div className="text-[11px] text-muted-foreground">事件流加载中...</div>}
                    {events === 'error' && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400">
                        事件流不可用（会话可能已随 CDS 重启清理，收发摘要见上）
                      </div>
                    )}
                    {Array.isArray(events) && (
                      <div className="max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-2 flex flex-col gap-1">
                        {events.map((ev) => (
                          <div key={ev.seq} className="flex items-start gap-2 text-[11px] leading-relaxed">
                            <span className="shrink-0 w-8 text-right tabular-nums text-muted-foreground">#{ev.seq}</span>
                            <span className="shrink-0 w-20 font-mono text-muted-foreground">{ev.type}</span>
                            <span className="min-w-0 break-all text-foreground/80">
                              {typeof ev.payload.text === 'string'
                                ? (ev.payload.text as string).slice(0, 300)
                                : typeof ev.payload.message === 'string'
                                  ? (ev.payload.message as string).slice(0, 300)
                                  : typeof ev.payload.finalText === 'string'
                                    ? (ev.payload.finalText as string).slice(0, 300)
                                    : JSON.stringify(ev.payload).slice(0, 300)}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtTime(ev.createdAt)}</span>
                          </div>
                        ))}
                        {events.length === 0 && <div className="text-[11px] text-muted-foreground">（空）</div>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      </Workspace>
    </AppShell>
  );
}
