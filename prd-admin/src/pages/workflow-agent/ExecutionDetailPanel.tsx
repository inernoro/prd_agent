import { useState, useEffect } from 'react';
import {
  ArrowLeft, RefreshCw, RotateCcw, Share2, XCircle,
  CheckCircle2, Clock, AlertCircle, Loader2, MinusCircle,
  FileText, Download,
} from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import { getNodeLogs, resumeFromNode, cancelExecution, createShareLink } from '@/services';
import { ExecutionStatusLabels, NodeTypeLabels } from '@/services/contracts/workflowAgent';
import type { ExecutionArtifact } from '@/services/contracts/workflowAgent';

const nodeStatusIcons: Record<string, React.ReactNode> = {
  pending: <Clock className="w-4 h-4 text-gray-400" />,
  running: <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />,
  completed: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  failed: <AlertCircle className="w-4 h-4 text-red-500" />,
  skipped: <MinusCircle className="w-4 h-4 text-gray-400" />,
};

export function ExecutionDetailPanel() {
  const { selectedExecution, setViewMode, setSelectedExecution, loadExecution } = useWorkflowStore();
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [nodeLogs, setNodeLogs] = useState<string>('');
  const [nodeArtifacts, setNodeArtifacts] = useState<ExecutionArtifact[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const exec = selectedExecution;
  if (!exec) return null;

  const handleRefresh = async () => {
    await loadExecution(exec.id);
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
      setSelectedExecution(res.data.execution);
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
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

      {/* Node list */}
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
                      {NodeTypeLabels[ne.nodeType] || ne.nodeType}
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
                          <pre className="text-[10px] bg-muted/50 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
                            {nodeLogs}
                          </pre>
                        </div>
                      )}
                      {nodeArtifacts.length > 0 && (
                        <div>
                          <h4 className="text-xs font-medium mb-1">产物</h4>
                          <div className="space-y-1">
                            {nodeArtifacts.map((art) => (
                              <div key={art.artifactId} className="flex items-center gap-2 text-xs">
                                <FileText className="w-3 h-3 text-muted-foreground" />
                                <span>{art.name}</span>
                                <span className="text-muted-foreground">{art.mimeType}</span>
                                <span className="text-muted-foreground">{formatBytes(art.sizeBytes)}</span>
                                {art.cosUrl && (
                                  <a href={art.cosUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                    <Download className="w-3 h-3" />
                                  </a>
                                )}
                              </div>
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

      {/* Final artifacts */}
      {exec.finalArtifacts.length > 0 && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-medium">最终产物</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {exec.finalArtifacts.map((art) => (
              <div key={art.artifactId} className="flex items-center gap-3 rounded-md border border-border p-3">
                <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{art.name}</div>
                  <div className="text-[10px] text-muted-foreground">{art.mimeType} - {formatBytes(art.sizeBytes)}</div>
                </div>
                {art.cosUrl && (
                  <a
                    href={art.cosUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 rounded hover:bg-accent text-primary flex-shrink-0"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
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
