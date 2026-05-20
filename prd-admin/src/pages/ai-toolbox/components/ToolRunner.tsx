import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { ArrowLeft, Check, AlertCircle, RotateCcw, Copy, ExternalLink, Terminal, Activity, Square, ShieldCheck, X } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { useEffect, useMemo, useState } from 'react';
import type { ToolboxArtifact } from '@/services';
import {
  approveInfraAgentTool,
  listInfraAgentEvents,
  stopInfraAgentSession,
  streamInfraAgentEvents,
  type InfraAgentEventView,
} from '@/services/real/infraAgentSessions';
import { toast } from '@/lib/toast';

type CdsAgentRunHandle = {
  kind?: string;
  sessionId?: string;
  traceId?: string;
  toolboxRunId?: string;
  toolboxStepId?: string;
  runtime?: string;
  runtimeAdapter?: string | null;
  currentRuntimeRunId?: string | null;
  model?: string | null;
  status?: string;
  workbenchPath?: string;
  eventStreamPath?: string;
  logsPath?: string;
};

function parseCdsAgentRunHandle(artifact: ToolboxArtifact): CdsAgentRunHandle | null {
  if (!artifact.content || artifact.mimeType !== 'application/json') return null;
  try {
    const parsed = JSON.parse(artifact.content) as CdsAgentRunHandle;
    return parsed?.kind === 'cds-agent-run-handle' && parsed.sessionId ? parsed : null;
  } catch {
    return null;
  }
}

function shortValue(value?: string | null, head = 10): string {
  if (!value) return '未上报';
  return value.length > head + 4 ? `${value.slice(0, head)}...${value.slice(-4)}` : value;
}

function parseEventPayload(event: InfraAgentEventView): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.payloadJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eventTitle(event: InfraAgentEventView): string {
  const payload = parseEventPayload(event);
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
  const message = typeof payload.message === 'string' ? payload.message : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (event.type === 'tool_call' && toolName) return `工具调用：${toolName}`;
  if (event.type === 'tool_result' && toolName) return `工具结果：${toolName}`;
  if (message) return message;
  if (text) return text;
  return String(event.type || 'event');
}

function eventMeta(event: InfraAgentEventView): string {
  const payload = parseEventPayload(event);
  const status = typeof payload.status === 'string' ? payload.status : '';
  const risk = typeof payload.risk === 'string' ? payload.risk : '';
  return [event.type, status, risk].filter(Boolean).join(' / ');
}

export function ToolRunner() {
  const { selectedItem, runStatus, runOutput, runArtifacts, runError, backToGrid, setView } = useToolboxStore();
  const [copied, setCopied] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);
  const [approvingKey, setApprovingKey] = useState<string | null>(null);
  const [remoteEventsBySession, setRemoteEventsBySession] = useState<Record<string, InfraAgentEventView[]>>({});
  const [remoteStreamState, setRemoteStreamState] = useState<Record<string, 'connecting' | 'live' | 'polling' | 'error'>>({});
  const cdsRunHandles = useMemo(
    () => runArtifacts
      .map(parseCdsAgentRunHandle)
      .filter((item): item is CdsAgentRunHandle => Boolean(item)),
    [runArtifacts],
  );

  useEffect(() => {
    const handles = cdsRunHandles.filter((item) => item.sessionId);
    if (handles.length === 0) return;

    const controllers = handles.map((handle) => {
      const sessionId = handle.sessionId!;
      const controller = new AbortController();
      setRemoteStreamState((prev) => ({ ...prev, [sessionId]: 'connecting' }));

      const mergeEvents = (items: InfraAgentEventView[]) => {
        setRemoteEventsBySession((prev) => {
          const existing = prev[sessionId] ?? [];
          const bySeq = new Map<number, InfraAgentEventView>();
          for (const item of existing) bySeq.set(item.seq, item);
          for (const item of items) bySeq.set(item.seq, item);
          return {
            ...prev,
            [sessionId]: Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq).slice(-40),
          };
        });
      };

      void (async () => {
        const initial = await listInfraAgentEvents(sessionId, 0, 20);
        if (initial.success) mergeEvents(initial.data.items);

        let cursor = initial.success && initial.data.items.length > 0
          ? Math.max(...initial.data.items.map((item) => item.seq))
          : 0;

        try {
          await streamInfraAgentEvents(
            sessionId,
            cursor,
            100,
            (event) => {
              cursor = Math.max(cursor, event.seq);
              mergeEvents([event]);
            },
            controller.signal,
            () => setRemoteStreamState((prev) => ({ ...prev, [sessionId]: 'live' })),
          );
        } catch {
          if (controller.signal.aborted) return;
          setRemoteStreamState((prev) => ({ ...prev, [sessionId]: 'polling' }));
          while (!controller.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (controller.signal.aborted) break;
            const res = await listInfraAgentEvents(sessionId, cursor, 20);
            if (!res.success) {
              setRemoteStreamState((prev) => ({ ...prev, [sessionId]: 'error' }));
              continue;
            }
            if (res.data.items.length > 0) {
              cursor = Math.max(...res.data.items.map((item) => item.seq));
              mergeEvents(res.data.items);
              setRemoteStreamState((prev) => ({ ...prev, [sessionId]: 'polling' }));
            }
          }
        }
      })();

      return controller;
    });

    return () => {
      controllers.forEach((controller) => controller.abort());
    };
  }, [cdsRunHandles]);

  if (!selectedItem) return null;

  const isRunning = runStatus === 'running';
  const isCompleted = runStatus === 'completed';
  const isFailed = runStatus === 'failed';

  const handleCopy = async () => {
    if (!runOutput) return;
    await navigator.clipboard.writeText(runOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRunAgain = () => {
    setView('detail');
  };

  const openWorkbench = (path?: string) => {
    if (!path) return;
    window.open(path, '_blank', 'noopener,noreferrer');
  };

  const stopRemoteSession = async (sessionId?: string) => {
    if (!sessionId || stoppingSessionId) return;
    setStoppingSessionId(sessionId);
    try {
      const res = await stopInfraAgentSession(sessionId);
      if (!res.success) {
        toast.error('停止远程会话失败', res.error?.message ?? '请到 CDS Agent 工作台查看详情');
        return;
      }
      toast.success('已请求停止远程会话', '底层 runtime cancel 会由 MAP/CDS 控制面继续处理');
    } catch (err) {
      toast.error('停止远程会话失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setStoppingSessionId(null);
    }
  };

  const approveRemoteTool = async (sessionId: string, approvalId: string, decision: 'allow' | 'deny') => {
    const key = `${sessionId}:${approvalId}:${decision}`;
    setApprovingKey(key);
    try {
      const res = await approveInfraAgentTool(sessionId, approvalId, decision);
      if (!res.success) {
        toast.error('审批提交失败', res.error?.message ?? '请到 CDS Agent 工作台查看详情');
        return;
      }
      toast.success(decision === 'allow' ? '已允许工具调用' : '已拒绝工具调用');
    } catch (err) {
      toast.error('审批提交失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setApprovingKey(null);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={selectedItem.name}
        icon={<span className="text-lg">{selectedItem.icon}</span>}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              返回列表
            </Button>
            {(isCompleted || isFailed) && (
              <Button variant="primary" size="sm" onClick={handleRunAgain}>
                <RotateCcw size={14} />
                再次运行
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        {/* Status bar */}
        <GlassCard animated className="p-4 flex items-center gap-3">
          {isRunning && (
            <>
              <MapSpinner size={20} color="var(--accent-primary)" />
              <span style={{ color: 'var(--text-primary)' }}>正在执行...</span>
            </>
          )}
          {isCompleted && (
            <>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: 'var(--status-success)/20' }}
              >
                <Check size={14} style={{ color: 'var(--status-success)' }} />
              </div>
              <span style={{ color: 'var(--status-success)' }}>执行完成</span>
            </>
          )}
          {isFailed && (
            <>
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: 'var(--status-error)/20' }}
              >
                <AlertCircle size={14} style={{ color: 'var(--status-error)' }} />
              </div>
              <span style={{ color: 'var(--status-error)' }}>执行失败</span>
            </>
          )}

          {/* Copy button */}
          {runOutput && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopy}
              className="ml-auto"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制结果'}
            </Button>
          )}
        </GlassCard>

        {/* Output */}
        <GlassCard animated className="flex-1 min-h-0 p-4 overflow-auto">
          {cdsRunHandles.length > 0 && (
            <div className="mb-4 space-y-3">
              {cdsRunHandles.map((handle) => {
                const sessionEvents = handle.sessionId ? (remoteEventsBySession[handle.sessionId] ?? []) : [];
                const recentEvents = sessionEvents.slice(-6).reverse();
                const streamState = handle.sessionId ? remoteStreamState[handle.sessionId] : undefined;
                const waitingEvents = recentEvents.filter((event) => {
                  const payload = parseEventPayload(event);
                  return event.type === 'tool_call'
                    && typeof payload.approvalId === 'string'
                    && payload.status === 'waiting';
                });

                return (
                  <div
                    key={handle.sessionId}
                    className="rounded-lg p-3"
                    style={{
                      background: 'rgba(14, 165, 233, 0.08)',
                      border: '1px solid rgba(125, 211, 252, 0.22)',
                    }}
                  >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        <Terminal size={15} />
                        CDS Agent 远程运行
                      </div>
                      <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        Toolbox 已创建远程会话，真实执行、审批和停止请在 CDS Agent 工作台继续处理。
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={!handle.sessionId || stoppingSessionId === handle.sessionId}
                        onClick={() => void stopRemoteSession(handle.sessionId)}
                      >
                        {stoppingSessionId === handle.sessionId ? <MapSpinner size={13} /> : <Square size={14} />}
                        停止
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => openWorkbench(handle.workbenchPath)}>
                        <ExternalLink size={14} />
                        打开工作台
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      ['Session', shortValue(handle.sessionId)],
                      ['Status', handle.status || 'queued'],
                      ['Adapter', handle.runtimeAdapter || handle.runtime || '未上报'],
                      ['Run ID', shortValue(handle.currentRuntimeRunId)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="min-h-[54px] rounded-md px-3 py-2"
                        style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</div>
                        <div className="mt-1 break-all text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {handle.eventStreamPath && (
                    <div className="mt-3 inline-flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <Activity size={13} />
                      事件流：{streamState === 'live' ? '实时连接' : streamState === 'polling' ? '轮询兜底' : streamState === 'error' ? '连接异常' : '连接中'} · {handle.eventStreamPath}
                    </div>
                  )}
                  {waitingEvents.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {waitingEvents.map((event) => {
                        const payload = parseEventPayload(event);
                        const approvalId = String(payload.approvalId);
                        const allowKey = `${handle.sessionId}:${approvalId}:allow`;
                        const denyKey = `${handle.sessionId}:${approvalId}:deny`;
                        return (
                          <div
                            key={event.seq}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2"
                            style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(251, 191, 36, 0.24)' }}
                          >
                            <div className="min-w-0">
                              <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{eventTitle(event)}</div>
                              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{eventMeta(event) || approvalId}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!handle.sessionId || approvingKey === allowKey || approvingKey === denyKey}
                                onClick={() => void approveRemoteTool(handle.sessionId!, approvalId, 'deny')}
                              >
                                {approvingKey === denyKey ? <MapSpinner size={13} /> : <X size={14} />}
                                拒绝
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={!handle.sessionId || approvingKey === allowKey || approvingKey === denyKey}
                                onClick={() => void approveRemoteTool(handle.sessionId!, approvalId, 'allow')}
                              >
                                {approvingKey === allowKey ? <MapSpinner size={13} /> : <ShieldCheck size={14} />}
                                允许
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {recentEvents.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        最近事件
                      </div>
                      {recentEvents.map((event) => (
                        <div
                          key={event.seq}
                          className="rounded-md px-3 py-2"
                          style={{ background: 'rgba(0,0,0,0.12)', border: '1px solid rgba(255,255,255,0.07)' }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>{eventTitle(event)}</div>
                            <div className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>#{event.seq}</div>
                          </div>
                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{eventMeta(event)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          )}
          {runError ? (
            <div
              className="p-4 rounded-lg"
              style={{ background: 'var(--status-error)/10', color: 'var(--status-error)' }}
            >
              <div className="font-medium mb-2">错误信息</div>
              <div className="text-sm">{runError}</div>
            </div>
          ) : runOutput ? (
            <div className="prose prose-sm max-w-none" style={{ color: 'var(--text-primary)' }}>
              <pre
                className="whitespace-pre-wrap font-sans text-sm leading-relaxed"
                style={{ color: 'var(--text-primary)' }}
              >
                {runOutput}
                {isRunning && (
                  <span
                    className="inline-block w-2 h-4 ml-1 animate-pulse"
                    style={{ background: 'var(--accent-primary)' }}
                  />
                )}
              </pre>
            </div>
          ) : isRunning ? (
            <div className="flex items-center justify-center h-32">
              <MapSectionLoader text="等待响应..." />
            </div>
          ) : null}
        </GlassCard>
      </div>
    </div>
  );
}
