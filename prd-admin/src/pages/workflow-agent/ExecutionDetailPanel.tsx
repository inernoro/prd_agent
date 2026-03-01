import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, RefreshCw, RotateCcw, Share2, XCircle,
  CheckCircle2, Clock, AlertCircle, Loader2, MinusCircle,
  FileText, Download, ChevronDown, ChevronRight, Eye,
  ScrollText, LayoutList, Terminal, ExternalLink,
} from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { getExecution, getNodeLogs, resumeFromNode, cancelExecution, createShareLink } from '@/services';
import { ExecutionStatusLabels } from '@/services/contracts/workflowAgent';
import type { ExecutionArtifact, WorkflowExecution } from '@/services/contracts/workflowAgent';
import { getCapsuleType } from './capsuleRegistry';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

// ═══════════════════════════════════════════════════════════════
// 日志条目
// ═══════════════════════════════════════════════════════════════

interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'success' | 'error' | 'warn';
  nodeId?: string;
  nodeName?: string;
  nodeType?: string;
  message: string;
  detail?: string;
  /** 完整日志 COS 地址（当日志被截断时可用） */
  logsCosUrl?: string;
}

const nodeStatusIcons: Record<string, React.ReactNode> = {
  pending: <Clock className="w-4 h-4 text-gray-400" />,
  running: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />,
  completed: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  failed: <AlertCircle className="w-4 h-4 text-red-500" />,
  skipped: <MinusCircle className="w-4 h-4 text-gray-400" />,
};

// ═══════════════════════════════════════════════════════════════
// 主面板
// ═══════════════════════════════════════════════════════════════

type TabType = 'nodes' | 'logs';

export function ExecutionDetailPanel() {
  const { selectedExecution, setViewMode, setSelectedExecution, loadExecution } = useWorkflowStore();
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [nodeLogs, setNodeLogs] = useState<string>('');
  const [nodeArtifacts, setNodeArtifacts] = useState<ExecutionArtifact[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('logs');
  const [previewArtifact, setPreviewArtifact] = useState<ExecutionArtifact | null>(null);

  // Real-time log entries
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logBottomRef = useRef<HTMLDivElement>(null);
  const sseAbortRef = useRef<AbortController | null>(null);

  const exec = selectedExecution;

  // Auto-scroll logs
  useEffect(() => {
    logBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEntries]);

  // Start SSE for running executions, load logs for completed ones
  useEffect(() => {
    if (!exec) return;
    if (['queued', 'running'].includes(exec.status)) {
      startLogSse(exec.id);
    } else {
      // Load historical logs from all nodes
      loadHistoricalLogs(exec);
    }
    return () => stopLogSse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exec?.id]);

  if (!exec) return null;

  // ── SSE for real-time logs ──

  function startLogSse(execId: string) {
    stopLogSse();
    const ac = new AbortController();
    sseAbortRef.current = ac;
    const token = useAuthStore.getState().token;
    const baseUrl = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_BASE_URL || '';
    const url = `${baseUrl}${api.workflowAgent.executions.stream(execId)}`;

    addLog('info', '开始监听执行事件流...');

    (async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (!res.ok) {
          addLog('warn', `SSE 连接失败 (${res.status})，使用轮询模式`);
          fallbackPolling(execId);
          return;
        }

        await readSseStream(res, (evt) => {
          if (!evt.data || !evt.event) return;
          try {
            const payload = JSON.parse(evt.data) as Record<string, unknown>;
            handleLogSseEvent(evt.event, payload, execId);
          } catch { /* ignore */ }
        }, ac.signal);
      } catch {
        if (!ac.signal.aborted) {
          addLog('warn', 'SSE 连接中断，切换到轮询');
          fallbackPolling(execId);
        }
      }
    })();
  }

  function handleLogSseEvent(eventName: string, payload: Record<string, unknown>, execId: string) {
    const nodeId = payload.nodeId as string;
    const nodeName = payload.nodeName as string;
    const nodeType = payload.nodeType as string;

    if (eventName === 'execution-started') {
      addLog('info', `执行开始，共 ${payload.totalNodes} 个节点`);
    } else if (eventName === 'node-started') {
      const inputCount = payload.inputArtifactCount as number;
      addLog('info', `开始执行`, `接收 ${inputCount ?? 0} 个输入产物`, nodeId, nodeName, nodeType);
    } else if (eventName === 'node-completed') {
      const durationMs = payload.durationMs as number;
      const artifactCount = payload.artifactCount as number;
      const logs = payload.logs as string;

      addLog('success', `完成 (${(durationMs / 1000).toFixed(1)}s)，产出 ${artifactCount} 个产物`,
        logs || undefined, nodeId, nodeName, nodeType);

      // Update node state via store
      const current = useWorkflowStore.getState().selectedExecution;
      if (current) {
        setSelectedExecution({
          ...current,
          nodeExecutions: current.nodeExecutions.map(ne =>
            ne.nodeId === nodeId
              ? { ...ne, status: 'completed', durationMs, completedAt: new Date().toISOString() }
              : ne
          ),
        });
      }
    } else if (eventName === 'node-failed') {
      const errMsg = payload.errorMessage as string;
      const logs = payload.logs as string;
      addLog('error', `执行失败: ${errMsg}`, logs || undefined, nodeId, nodeName, nodeType);

      const current = useWorkflowStore.getState().selectedExecution;
      if (current) {
        setSelectedExecution({
          ...current,
          nodeExecutions: current.nodeExecutions.map(ne =>
            ne.nodeId === nodeId
              ? { ...ne, status: 'failed', errorMessage: errMsg, completedAt: new Date().toISOString() }
              : ne
          ),
        });
      }
    } else if (eventName === 'execution-completed') {
      const status = payload.status as string;
      const completed = payload.completedNodes as number;
      const failed = payload.failedNodes as number;
      const skipped = payload.skippedNodes as number;
      addLog(
        status === 'completed' ? 'success' : 'error',
        `执行${status === 'completed' ? '完成' : '失败'} — 成功: ${completed}, 失败: ${failed}, 跳过: ${skipped}`
      );
      stopLogSse();
      // Refresh full state
      loadExecution(execId);
    }
  }

  function fallbackPolling(execId: string) {
    const iv = setInterval(async () => {
      try {
        const res = await getExecution(execId);
        if (res.success && res.data) {
          setSelectedExecution(res.data.execution);
          if (['completed', 'failed', 'cancelled'].includes(res.data.execution.status)) {
            clearInterval(iv);
            loadHistoricalLogs(res.data.execution);
          }
        }
      } catch { /* ignore */ }
    }, 2000);
    sseAbortRef.current = { abort: () => clearInterval(iv) } as unknown as AbortController;
  }

  function stopLogSse() {
    sseAbortRef.current?.abort();
    sseAbortRef.current = null;
  }

  async function loadHistoricalLogs(execution: typeof exec) {
    if (!execution) return;
    const entries: LogEntry[] = [];
    let id = 0;

    entries.push({
      id: `hist-${id++}`,
      timestamp: new Date(execution.createdAt),
      level: 'info',
      message: `执行创建，共 ${execution.nodeExecutions.length} 个节点`,
    });

    for (const ne of execution.nodeExecutions) {
      if (ne.status === 'pending') continue;

      if (ne.startedAt) {
        entries.push({
          id: `hist-${id++}`,
          timestamp: new Date(ne.startedAt),
          level: 'info',
          nodeId: ne.nodeId,
          nodeName: ne.nodeName,
          nodeType: ne.nodeType,
          message: '开始执行',
        });
      }

      // Fetch detailed logs for this node
      try {
        const res = await getNodeLogs({ executionId: execution.id, nodeId: ne.nodeId });
        if (res.success && res.data) {
          if (ne.status === 'completed') {
            entries.push({
              id: `hist-${id++}`,
              timestamp: new Date(ne.completedAt || ne.startedAt || execution.createdAt),
              level: 'success',
              nodeId: ne.nodeId,
              nodeName: ne.nodeName,
              nodeType: ne.nodeType,
              message: `完成 (${ne.durationMs ? (ne.durationMs / 1000).toFixed(1) + 's' : '-'})，产出 ${res.data.artifacts?.length || 0} 个产物`,
              detail: res.data.logs || undefined,
              logsCosUrl: res.data.logsCosUrl,
            });
          } else if (ne.status === 'failed') {
            entries.push({
              id: `hist-${id++}`,
              timestamp: new Date(ne.completedAt || ne.startedAt || execution.createdAt),
              level: 'error',
              nodeId: ne.nodeId,
              nodeName: ne.nodeName,
              nodeType: ne.nodeType,
              message: `失败: ${ne.errorMessage || '未知错误'}`,
              detail: res.data.logs || undefined,
              logsCosUrl: res.data.logsCosUrl,
            });
          } else if (ne.status === 'skipped') {
            entries.push({
              id: `hist-${id++}`,
              timestamp: new Date(ne.completedAt || execution.createdAt),
              level: 'warn',
              nodeId: ne.nodeId,
              nodeName: ne.nodeName,
              nodeType: ne.nodeType,
              message: `跳过: ${ne.errorMessage || '上游节点失败'}`,
            });
          }
        }
      } catch { /* ignore */ }
    }

    // Final status
    if (['completed', 'failed', 'cancelled'].includes(execution.status)) {
      entries.push({
        id: `hist-${id++}`,
        timestamp: new Date(execution.completedAt || execution.createdAt),
        level: execution.status === 'completed' ? 'success' : 'error',
        message: `执行${execution.status === 'completed' ? '完成' : execution.status === 'failed' ? '失败' : '取消'}${execution.errorMessage ? ': ' + execution.errorMessage : ''}`,
      });
    }

    setLogEntries(entries);
  }

  function addLog(level: LogEntry['level'], message: string, detail?: string, nodeId?: string, nodeName?: string, nodeType?: string) {
    setLogEntries(prev => [...prev, {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date(),
      level,
      nodeId,
      nodeName,
      nodeType,
      message,
      detail,
    }]);
  }

  const handleRefresh = async () => {
    await loadExecution(exec.id);
    if (exec) loadHistoricalLogs(exec);
  };

  const handleExpandNode = async (nodeId: string) => {
    if (expandedNodeId === nodeId) {
      setExpandedNodeId(null);
      return;
    }
    setExpandedNodeId(nodeId);
    setLoadingLogs(true);
    const res = await getNodeLogs({ executionId: exec.id, nodeId });
    if (res.success && res.data) {
      setNodeLogs(res.data.logs || '');
      setNodeArtifacts(res.data.artifacts || []);
    }
    setLoadingLogs(false);
  };

  const handleResume = async (nodeId: string) => {
    if (!confirm('从此节点重新执行？')) return;
    const res = await resumeFromNode({ executionId: exec.id, nodeId });
    if (res.success && res.data) {
      setSelectedExecution(res.data.execution as WorkflowExecution);
      setLogEntries([]);
    }
  };

  const handleCancel = async () => {
    if (!confirm('确定取消执行？')) return;
    await cancelExecution(exec.id);
    await loadExecution(exec.id);
  };

  const handleShare = async () => {
    const res = await createShareLink({ executionId: exec.id });
    if (res.success && res.data) {
      const url = window.location.origin + res.data.url;
      await navigator.clipboard.writeText(url);
      alert(`分享链接已复制: ${url}`);
    }
  };

  const isTerminal = ['completed', 'failed', 'cancelled'].includes(exec.status);
  const isRunning = ['queued', 'running'].includes(exec.status);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setViewMode('execution-list')}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">{exec.workflowName}</h1>
            <p className="text-xs text-muted-foreground font-mono">{exec.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} className="p-1.5 rounded-md hover:bg-accent" title="刷新">
            <RefreshCw className="w-4 h-4" />
          </button>
          {!isTerminal && (
            <button onClick={handleCancel} className="p-1.5 rounded-md hover:bg-destructive/10 text-destructive" title="取消">
              <XCircle className="w-4 h-4" />
            </button>
          )}
          {isTerminal && exec.finalArtifacts.length > 0 && (
            <button
              onClick={handleShare}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent"
            >
              <Share2 className="w-3.5 h-3.5" />
              分享
            </button>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="rounded-lg border border-border p-4 bg-card">
        <div className="flex items-center gap-4 text-sm">
          <span className={`px-2.5 py-1 rounded text-xs font-medium ${
            exec.status === 'completed' ? 'bg-green-500/10 text-green-600' :
            exec.status === 'failed' ? 'bg-red-500/10 text-red-600' :
            exec.status === 'running' ? 'bg-blue-500/10 text-blue-600' :
            exec.status === 'cancelled' ? 'bg-gray-500/10 text-gray-500' :
            'bg-yellow-500/10 text-yellow-600'
          }`}>
            {ExecutionStatusLabels[exec.status] || exec.status}
          </span>
          <span className="text-xs text-muted-foreground">
            触发: {exec.triggerType === 'manual' ? '手动' : exec.triggerType}
          </span>
          {exec.triggeredByName && (
            <span className="text-xs text-muted-foreground">操作人: {exec.triggeredByName}</span>
          )}
          <span className="text-xs text-muted-foreground">
            {new Date(exec.createdAt).toLocaleString('zh-CN')}
          </span>
          {isRunning && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              实时监控中
            </span>
          )}
        </div>
        {exec.errorMessage && (
          <div className="mt-2 text-xs text-red-500 bg-red-500/5 rounded p-2">
            {exec.errorMessage}
          </div>
        )}
      </div>

      {/* Node progress */}
      <div className="flex gap-1">
        {exec.nodeExecutions.map((ne) => {
          const color =
            ne.status === 'completed' ? 'bg-green-500' :
            ne.status === 'running' ? 'bg-blue-500 animate-pulse' :
            ne.status === 'failed' ? 'bg-red-500' :
            'bg-gray-200';
          return (
            <div key={ne.nodeId} className={`h-2 flex-1 rounded-full ${color}`} title={`${ne.nodeName}: ${ne.status}`} />
          );
        })}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }}>
        <button
          onClick={() => setActiveTab('logs')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-all ${
            activeTab === 'logs'
              ? 'bg-white/10 text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          实时日志 {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />}
        </button>
        <button
          onClick={() => setActiveTab('nodes')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium transition-all ${
            activeTab === 'nodes'
              ? 'bg-white/10 text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
          }`}
        >
          <LayoutList className="w-3.5 h-3.5" />
          节点详情
        </button>
      </div>

      {/* ══════ 日志时间线 ══════ */}
      {activeTab === 'logs' && (
        <section
          className="rounded-xl border border-border overflow-hidden"
          style={{ background: 'rgba(0,0,0,0.2)' }}
        >
          <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2">
              <ScrollText className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                执行日志 ({logEntries.length} 条)
              </span>
            </div>
            <button
              onClick={() => setLogEntries([])}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              清空
            </button>
          </div>
          <div className="max-h-[500px] overflow-auto font-mono text-[11px] leading-relaxed">
            {logEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-muted-foreground text-xs">
                {isRunning ? '等待执行事件...' : '暂无日志'}
              </div>
            )}
            {logEntries.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
            <div ref={logBottomRef} />
          </div>
        </section>
      )}

      {/* ══════ 节点列表 ══════ */}
      {activeTab === 'nodes' && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">节点执行详情</h2>
          {exec.nodeExecutions.map((ne) => {
            const isExpanded = expandedNodeId === ne.nodeId;
            return (
              <div key={ne.nodeId} className="rounded-lg border border-border bg-card">
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent/30 transition-colors"
                  onClick={() => handleExpandNode(ne.nodeId)}
                >
                  {nodeStatusIcons[ne.status] || <Clock className="w-4 h-4" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{ne.nodeName}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                        {getCapsuleType(ne.nodeType)?.name || ne.nodeType}
                      </span>
                    </div>
                    {ne.errorMessage && (
                      <p className="text-xs text-red-500 truncate mt-0.5">{ne.errorMessage}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {ne.durationMs != null && <span>{(ne.durationMs / 1000).toFixed(1)}s</span>}
                    {ne.attemptCount > 1 && <span>重试 {ne.attemptCount} 次</span>}
                  </div>
                  {ne.status === 'failed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleResume(ne.nodeId); }}
                      className="p-1.5 rounded hover:bg-accent text-primary"
                      title="从此节点重跑"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Expanded node detail */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-border/50 pt-3 space-y-3">
                    {loadingLogs ? (
                      <div className="text-xs text-muted-foreground">加载日志中...</div>
                    ) : (
                      <>
                        {nodeLogs && (
                          <div>
                            <h4 className="text-xs font-medium mb-1">执行日志</h4>
                            <pre className="text-[10px] bg-muted/50 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
                              {nodeLogs}
                            </pre>
                          </div>
                        )}
                        {nodeArtifacts.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium mb-1">产物</h4>
                            <div className="space-y-1">
                              {nodeArtifacts.map((art) => (
                                <NodeArtifactRow
                                  key={art.artifactId}
                                  artifact={art}
                                  onPreview={() => setPreviewArtifact(art)}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                        {!nodeLogs && nodeArtifacts.length === 0 && (
                          <div className="text-xs text-muted-foreground/50">暂无日志和产物</div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Final artifacts */}
      {exec.finalArtifacts.length > 0 && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-medium">最终产物</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {exec.finalArtifacts.map((art) => (
              <div
                key={art.artifactId}
                className="flex items-center gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/20 transition-colors"
                onClick={() => setPreviewArtifact(art)}
              >
                <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{art.name}</div>
                  <div className="text-[10px] text-muted-foreground">{art.mimeType} - {formatBytes(art.sizeBytes)}</div>
                </div>
                <button
                  className="p-1.5 rounded hover:bg-accent text-primary flex-shrink-0"
                  title="预览"
                >
                  <Eye className="w-4 h-4" />
                </button>
                {art.cosUrl && (
                  <a
                    href={art.cosUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 rounded hover:bg-accent text-primary flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Artifact Preview Modal */}
      {previewArtifact && (
        <ArtifactPreviewModal
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 日志行
// ═══════════════════════════════════════════════════════════════

function LogLine({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const levelColors: Record<string, { dot: string; text: string; bg: string }> = {
    info: { dot: 'bg-blue-400', text: 'text-blue-400', bg: 'rgba(59,130,246,0.05)' },
    success: { dot: 'bg-green-400', text: 'text-green-400', bg: 'rgba(34,197,94,0.05)' },
    error: { dot: 'bg-red-400', text: 'text-red-400', bg: 'rgba(239,68,68,0.06)' },
    warn: { dot: 'bg-yellow-400', text: 'text-yellow-400', bg: 'rgba(234,179,8,0.05)' },
  };

  const colors = levelColors[entry.level] || levelColors.info;
  const time = entry.timestamp.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div
      className="group px-4 py-1.5 flex items-start gap-2 hover:bg-white/[0.02] transition-colors"
      style={{ background: entry.level === 'error' ? colors.bg : undefined }}
    >
      {/* Time */}
      <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5 tabular-nums w-[60px]">
        {time}
      </span>

      {/* Level dot */}
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${colors.dot}`} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {entry.nodeName && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
              style={{
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {entry.nodeName}
            </span>
          )}
          <span className={`text-[11px] ${colors.text}`}>
            {entry.message}
          </span>
        </div>

        {/* Expandable detail */}
        {entry.detail && (
          <>
            <div className="mt-1 flex items-center gap-2">
              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {expanded ? '收起详情' : '展开详情'}
              </button>
              {entry.logsCosUrl && (
                <a
                  href={entry.logsCosUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                >
                  <ExternalLink className="w-3 h-3" />
                  查看完整日志
                </a>
              )}
            </div>
            {expanded && (
              <pre
                className="mt-1.5 text-[10px] rounded-md p-2.5 max-h-48 overflow-auto whitespace-pre-wrap leading-relaxed"
                style={{
                  background: 'rgba(0,0,0,0.2)',
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {entry.detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 节点产物行 (with preview button)
// ═══════════════════════════════════════════════════════════════

function NodeArtifactRow({ artifact, onPreview }: { artifact: ExecutionArtifact; onPreview: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <FileText className="w-3 h-3 text-muted-foreground" />
      <span className="flex-1 truncate">{artifact.name}</span>
      <span className="text-muted-foreground">{artifact.mimeType}</span>
      <span className="text-muted-foreground">{formatBytes(artifact.sizeBytes)}</span>
      {(artifact.inlineContent || artifact.cosUrl) && (
        <button
          onClick={onPreview}
          className="p-1 rounded hover:bg-accent text-primary transition-colors"
          title="预览"
        >
          <Eye className="w-3 h-3" />
        </button>
      )}
      {artifact.cosUrl && (
        <a href={artifact.cosUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
          <Download className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
