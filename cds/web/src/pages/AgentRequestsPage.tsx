import { AGENT_REQUEST_FILTERS_CLASS, AGENT_REQUEST_FILTER_CLASS, AGENT_REQUEST_ROW_BODY_CLASS, AGENT_REQUEST_ROW_CLASS, AGENT_REQUEST_ROW_META_CLASS, AGENT_REQUEST_ROW_PREVIEW_CLASS, AGENT_REQUEST_SEARCH_CLASS, AgentRequestCardsSkeleton, AgentRequestsSkeleton } from '@/components/skeletons/WorkspaceSkeletons';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
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
  running: { label: '运行中', cls: 'bg-ok-soft text-ok border-ok/30', pulse: true },
  creating: { label: '创建中', cls: 'bg-info-soft text-info border-info/30', pulse: true },
  idle: { label: '已完成', cls: 'bg-info-soft text-info border-info/25' },
  stopping: { label: '停止中', cls: 'bg-warn-soft text-warn border-warn/30' },
  stopped: { label: '已停止', cls: 'bg-foreground/8 text-muted-foreground border-border' },
  failed: { label: '失败', cls: 'bg-bad-soft text-bad border-bad/30' },
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
  return <ProjectAgentRequests key={projectId} projectId={projectId} />;
}

function ProjectAgentRequests({ projectId }: { projectId: string }): JSX.Element {
  const [data, setData] = useState<AgentRequestsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fUser, setFUser] = useState('');
  const [fApp, setFApp] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fQ, setFQ] = useState('');
  const [dataScope, setDataScope] = useState('');
  const queryScope = JSON.stringify([fUser, fApp, fStatus, fQ.trim()]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentEvent[] | 'loading' | 'error'>>({});
  const fetchSeqRef = useRef(0);
  const [eventsUpdatedAt, setEventsUpdatedAt] = useState<Record<string, string>>({});
  const [eventsReading, setEventsReading] = useState<Record<string, boolean>>({});
  const [eventsErrors, setEventsErrors] = useState<Record<string, string>>({});
  const eventReaders = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const controller of eventReaders.current.values()) controller.abort(); eventReaders.current.clear(); }, []);
  const { lastAgentActivityEvent, effectiveConnection } = useCdsEvents();

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!projectId) return;
    const seq = ++fetchSeqRef.current;
    if (!opts?.silent) { setLoading(true); setError(null); }
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
      setDataScope(JSON.stringify([fUser, fApp, fStatus, fQ.trim()]));
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
    if (eventReaders.current.has(sessionId)) return;
    const controller = new AbortController();
    eventReaders.current.set(sessionId, controller);
    setEventsReading(current => ({ ...current, [sessionId]: true }));
    setEventsErrors(current => ({ ...current, [sessionId]: '' }));
    setEventsBySession(prev => Array.isArray(prev[sessionId]) ? prev : ({ ...prev, [sessionId]: 'loading' }));
    try {
      const url = apiUrl(`/api/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}/stream?afterSeq=0`);
      const response = await fetch(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(response.status === 403 ? '没有权限读取这条会话的事件，请联系系统所有者。' : response.status === 404 ? '这条会话的事件已不可用；仍可查看上方保留的收发摘要。' : '暂时无法读取事件，请稍后重试。');
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
      if (controller.signal.aborted) return;
      setEventsBySession((prev) => ({ ...prev, [sessionId]: events }));
      setEventsUpdatedAt(current => ({ ...current, [sessionId]: new Date().toISOString() }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setEventsErrors(current => ({ ...current, [sessionId]: error instanceof Error ? error.message : '暂时无法读取事件，请重试。' }));
      setEventsBySession(prev => Array.isArray(prev[sessionId]) ? prev : ({ ...prev, [sessionId]: 'error' }));
    } finally {
      eventReaders.current.delete(sessionId);
      if (!controller.signal.aborted) setEventsReading(current => ({ ...current, [sessionId]: false }));
    }
  }, [projectId]);

  const toggleExpand = useCallback((sessionId: string) => {
    setExpanded((cur) => {
      const next = cur === sessionId ? null : sessionId;
      if (next && (eventsBySession[next] === undefined || eventsBySession[next] === 'error')) void loadEvents(next);
      return next;
    });
  }, [eventsBySession, loadEvents]);

  const filtered = !!(fUser || fApp || fStatus || fQ.trim());
  const clearFilters = (): void => { setFUser(''); setFApp(''); setFStatus(''); setFQ(''); };
  const currentData = dataScope === queryScope ? data : null;
  const items = currentData?.items ?? [];
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
              <span className={['inline-block w-2 h-2 rounded-full', sseLive ? 'bg-ok animate-pulse' : 'bg-warn'].join(' ')} />
              {sseLive ? '列表实时已连接（SSE）' : '列表实时降级（5s 轮询）'}
            </span>
          }
        />
      }
    >
      <Workspace fluid className="flex flex-col gap-4">
      {loading && !data && !error ? <AgentRequestsSkeleton /> : <>
      {/* 筛选条：按用户 / 按应用 / 状态 / 关键字 */}
      <div className={AGENT_REQUEST_FILTERS_CLASS} data-testid="request-filters">
        <select
          aria-label="按应用筛选"
          value={fApp}
          onChange={(e) => setFApp(e.target.value)}
          className={AGENT_REQUEST_FILTER_CLASS}
          data-testid="filter-app"
        >
          <option value="">全部应用</option>
          {(data?.apps ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          aria-label="按用户筛选"
          value={fUser}
          onChange={(e) => setFUser(e.target.value)}
          className={AGENT_REQUEST_FILTER_CLASS}
          data-testid="filter-user"
        >
          <option value="">全部用户</option>
          {(data?.users ?? []).map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <select
          aria-label="按状态筛选"
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value)}
          className={AGENT_REQUEST_FILTER_CLASS}
        >
          {statusOptions.map((st) => (
            <option key={st} value={st}>{st === '' ? '全部状态' : (STATUS_STYLE[st]?.label ?? st)}</option>
          ))}
        </select>
        <div className={AGENT_REQUEST_SEARCH_CLASS}>
          <Search size="0.8125rem" className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="搜索 Agent 请求"
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
          <RefreshCw size="0.75rem" className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
        <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
          实时 {currentData?.liveCount ?? '—'} · 历史 {currentData?.historyCount ?? '—'}
        </span>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">
          请求读取失败：{error}{currentData ? '；当前显示本次筛选上次成功读取的记录。' : '；尚未确认当前筛选是否有记录。'}
          <button type="button" className="ml-3 underline" onClick={() => void load()}>重试读取</button>
        </div>
      )}

      {/* 请求列表：一条 = 一次 agent 会话（title/label + 收发预览 + 状态/耗时） */}
      <div className="flex flex-col gap-2" data-testid="request-list">
        {loading && items.length === 0 ? <AgentRequestCardsSkeleton /> : null}
        {items.length === 0 && !loading && !error && (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {filtered ? <><p>没有符合当前筛选的请求。</p><button type="button" className="mt-3 text-primary underline" onClick={clearFilters}>清除筛选</button></> : '还没有 Agent 请求。应用发起生成后，请求会实时出现在这里。'}
          </div>
        )}
        {items.map((item) => {
          const st = STATUS_STYLE[item.status] ?? { label: item.status, cls: 'bg-foreground/8 text-muted-foreground border-border' };
          const open = expanded === item.sessionId;
          const events = eventsBySession[item.sessionId];
          return (
            <div
              key={item.sessionId}
              className={`${AGENT_REQUEST_ROW_CLASS} transition-colors ${open ? 'border-ok/40' : 'border-border'}`}
              data-testid={'request-row-' + item.sessionId}
            >
              <button
                type="button"
                onClick={() => toggleExpand(item.sessionId)}
                className={AGENT_REQUEST_ROW_BODY_CLASS}
              >
                <div className={AGENT_REQUEST_ROW_META_CLASS}>
                  {open ? <ChevronDown size="0.8125rem" className="shrink-0 text-muted-foreground" /> : <ChevronRight size="0.8125rem" className="shrink-0 text-muted-foreground" />}
                  <span className={['inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.625rem] font-medium', st.cls].join(' ')}>
                    {st.pulse && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                    {st.label}
                  </span>
                  <span className="text-sm font-medium truncate max-w-[17.5rem]">{item.title || item.sessionId.slice(0, 18)}</span>
                  {item.clientApp && (
                    <span className="rounded bg-info-soft border border-info/25 px-1.5 py-0.5 text-[0.625rem] text-info">{item.clientApp}</span>
                  )}
                  {item.clientUser && (
                    <span className="rounded bg-foreground/6 border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground" title={item.clientUser}>
                      {item.clientUser.slice(0, 10)}
                    </span>
                  )}
                  {item.model && <span className="text-[0.625rem] font-mono text-muted-foreground truncate max-w-[10.625rem]">{item.model}</span>}
                  {item.live && <span className="text-[0.5625rem] text-ok font-semibold">LIVE</span>}
                  <span className="col-start-3 row-start-1 text-xs text-muted-foreground tabular-nums sm:col-start-4">
                    {fmtTime(item.createdAt)} · {fmtDuration(item.durationMs)} · {item.eventCount} 事件
                  </span>
                </div>
                <div className={AGENT_REQUEST_ROW_PREVIEW_CLASS}>
                  <div className="truncate text-muted-foreground">
                    <span className="text-info font-medium">发 </span>
                    {item.requestPreview ?? '（无请求消息）'}
                  </div>
                  <div className="truncate text-muted-foreground">
                    <span className="text-ok font-medium">收 </span>
                    {item.responsePreview ?? '（尚无返回）'}
                  </div>
                </div>
              </button>

              {open && (
                <div className="border-t border-border px-3 py-2.5 flex flex-col gap-2.5" data-testid="request-detail">
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div>
                      <div className="text-[0.625rem] font-semibold text-info mb-1">请求内容（messages[0]）</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 text-[0.6875rem] leading-relaxed">
                        {item.requestPreview ?? '（无）'}
                      </pre>
                    </div>
                    <div>
                      <div className="text-[0.625rem] font-semibold text-ok mb-1">返回内容（finalText 截断 2000 字）</div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 text-[0.6875rem] leading-relaxed">
                        {item.responsePreview ?? '（尚无返回）'}
                      </pre>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>事件快照{eventsUpdatedAt[item.sessionId] ? ` · 读取于 ${fmtTime(eventsUpdatedAt[item.sessionId])}` : ''}{Array.isArray(events) && item.eventCount > events.length ? <span className="ml-2 font-medium text-primary">有更新待刷新</span> : null}</span>
                      <button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-md border border-border px-2 text-xs disabled:opacity-50" disabled={!!eventsReading[item.sessionId]} onClick={() => void loadEvents(item.sessionId)}><RefreshCw className={eventsReading[item.sessionId] ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />{eventsReading[item.sessionId] ? '读取中' : '刷新事件'}</button>
                    </div>
                    <p className="mb-2 text-xs text-muted-foreground">{item.live ? '显示截至本次读取的事件；运行中的新事件请刷新。' : '历史会话可能仅保留收发摘要；下方只展示本次实际读到的事件。'}</p>
                    {events === 'loading' && <ContentLoading label="加载事件流" variant="rows" />}
                    {eventsErrors[item.sessionId] && (
                      <div className="text-[0.6875rem] text-warn">
                        {eventsErrors[item.sessionId]}{Array.isArray(events) ? ' 下方保留上次成功读取的快照。' : ''}
                        <button type="button" className="ml-2 underline disabled:opacity-50" disabled={!!eventsReading[item.sessionId]} onClick={() => void loadEvents(item.sessionId)}>重试事件流</button>
                      </div>
                    )}
                    {Array.isArray(events) && (
                      <div role="region" aria-label="本次事件快照" tabIndex={0} className="max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-2 flex flex-col gap-1">
                        {events.map((ev) => (
                          <div key={ev.seq} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 text-sm leading-relaxed sm:grid-cols-[2rem_5rem_minmax(0,1fr)_auto]">
                            <span className="col-start-1 row-start-1 text-right tabular-nums text-muted-foreground">#{ev.seq}</span>
                            <span className="col-start-2 row-start-1 min-w-0 break-all font-mono text-muted-foreground">{ev.type}</span>
                            <span className="col-span-3 row-start-2 min-w-0 break-all text-foreground/80 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                              {(() => {
                                const text = typeof ev.payload.text === 'string' ? ev.payload.text
                                  : typeof ev.payload.message === 'string' ? ev.payload.message
                                    : typeof ev.payload.finalText === 'string' ? ev.payload.finalText : JSON.stringify(ev.payload);
                                return text.length > 300 ? <details><summary className="cursor-pointer">{text.slice(0, 300)}… <span className="text-primary">展开完整事件</span></summary><pre className="mt-2 whitespace-pre-wrap break-all font-mono">{text}</pre></details> : text;
                              })()}
                            </span>
                            <span className="col-start-3 row-start-1 text-xs text-muted-foreground tabular-nums sm:col-start-4">{fmtTime(ev.createdAt)}</span>
                          </div>
                        ))}
                        {events.length === 0 && <div className="text-[0.6875rem] text-muted-foreground">（空）</div>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>}
      </Workspace>
    </AppShell>
  );
}
