import { useEffect, useRef, useState } from 'react';
import {
  Play, History, CheckCircle2, AlertCircle,
  ArrowDown, Download, ChevronDown, ChevronRight, FileText,
  ExternalLink, Settings2, XCircle, RefreshCw, HelpCircle, Zap,
  FlaskConical, Box, PenLine, Eye, Terminal, Trash2,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { useWorkflowStore } from '@/stores/workflowStore';
import {
  createWorkflow, executeWorkflow, getExecution, getNodeLogs,
  listWorkflows, listExecutions, cancelExecution, testRunCapsule,
  listCapsuleTypes,
} from '@/services';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { ExecutionListPanel } from './ExecutionListPanel';
import { ExecutionDetailPanel } from './ExecutionDetailPanel';
import { SharePanel } from './SharePanel';
import { WorkflowCanvas } from './WorkflowCanvas';
import type {
  Workflow, WorkflowExecution, ExecutionArtifact, NodeExecution,
  CapsuleTypeMeta, CapsuleCategoryInfo, CapsuleTestRunResult,
} from '@/services/contracts/workflowAgent';
import { GlassCard } from '@/components/design/GlassCard';
import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { glassTooltip } from '@/lib/glassStyles';
import {
  getCapsuleType,
  getIconForCapsule, getEmojiForCapsule, getCategoryEmoji,
} from './capsuleRegistry';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';

// ═══════════════════════════════════════════════════════════════
// 流水线步骤元数据（使用舱注册表）
// ═══════════════════════════════════════════════════════════════

interface StepMeta {
  nodeId: string;
  step: number;
  icon: string;
  name: string;
  desc: string;
  helpTip: string;
  inputLabel: string;
  outputLabel: string;
  feedsToLabel?: string;
  accentHue: number;
  capsuleType?: string;
}

const STEPS: StepMeta[] = [
  {
    nodeId: 'n1', step: 1, icon: '🌐', accentHue: 210,
    capsuleType: 'http-request',
    name: '获取测试数据',
    desc: '从公共 API 获取 JSON 测试数据',
    helpTip: '使用 JSONPlaceholder 公共 API 获取示例数据（用户列表）。无需凭证，可直接运行。',
    inputLabel: '无（自动请求）',
    outputLabel: 'JSON 用户列表',
    feedsToLabel: '传递给步骤 ②「延时等待」',
  },
  {
    nodeId: 'n2', step: 2, icon: '⏳', accentHue: 200,
    capsuleType: 'delay',
    name: '延时等待',
    desc: '等待 3 秒模拟数据处理耗时',
    helpTip: '延时舱用于控制流水线节奏，此处等待 3 秒让你观察实时状态推送效果。',
    inputLabel: '步骤 ① 用户数据',
    outputLabel: '透传数据',
    feedsToLabel: '传递给步骤 ③「条件判断」',
  },
  {
    nodeId: 'n3', step: 3, icon: '🔀', accentHue: 45,
    capsuleType: 'condition',
    name: '条件判断',
    desc: '判断数据量是否大于 0，决定走哪个分支',
    helpTip: '条件舱根据数据内容走 TRUE / FALSE 分支。此处检查数据是否非空（not-empty）。如果有数据走格式转换，无数据走通知。',
    inputLabel: '步骤 ② 透传数据',
    outputLabel: 'TRUE 或 FALSE 分支',
    feedsToLabel: 'TRUE → 步骤 ④ / FALSE → 步骤 ⑤',
  },
  {
    nodeId: 'n4', step: 4, icon: '🔄', accentHue: 45,
    capsuleType: 'format-converter',
    name: '格式转换',
    desc: '将 JSON 数据转换为 CSV 格式',
    helpTip: 'TRUE 分支：数据非空时，将 JSON 数组转换为 CSV 格式，便于导出到 Excel 等工具。',
    inputLabel: '步骤 ③ TRUE 分支数据',
    outputLabel: 'CSV 格式数据',
  },
  {
    nodeId: 'n5', step: 5, icon: '🔔', accentHue: 340,
    capsuleType: 'notification-sender',
    name: '空数据通知',
    desc: 'FALSE 分支 — 数据为空时发送告警通知',
    helpTip: 'FALSE 分支：如果数据为空，发送站内通知告警。此步骤在正常流程中会被跳过。',
    inputLabel: '步骤 ③ FALSE 分支',
    outputLabel: '通知结果',
  },
];

// ═══════════════════════════════════════════════════════════════
// 配置项定义
// ═══════════════════════════════════════════════════════════════

interface VarConfig {
  key: string;
  label: string;
  helpTip: string;
  type: 'text' | 'password' | 'month';
  placeholder: string;
  required: boolean;
}

const VAR_CONFIGS: VarConfig[] = [
  {
    key: 'API_URL',
    label: '测试 API 地址',
    helpTip: '公共 REST API 地址，默认使用 JSONPlaceholder（免费测试 API）。可以改成任意返回 JSON 数组的地址。',
    type: 'text',
    placeholder: 'https://jsonplaceholder.typicode.com/users',
    required: false,
  },
];

// ═══════════════════════════════════════════════════════════════
// 后端工作流模板
// ═══════════════════════════════════════════════════════════════

const DEMO_TEMPLATE = {
  name: '数据采集 + 条件分支 Demo',
  description: '获取测试数据 → 延时等待 → 条件判断 → 格式转换(TRUE) / 通知(FALSE)',
  icon: '🧪',
  tags: ['demo', 'test'],
  variables: [
    { key: 'API_URL', label: '测试 API 地址', type: 'string', required: false, isSecret: false, defaultValue: 'https://jsonplaceholder.typicode.com/users' },
  ],
  nodes: [
    {
      nodeId: 'n1', name: '获取测试数据', nodeType: 'http-request',
      config: { url: '{{API_URL}}', method: 'GET' },
      inputSlots: [],
      outputSlots: [{ slotId: 'n1-out', name: 'response', dataType: 'json', required: true }],
    },
    {
      nodeId: 'n2', name: '延时等待', nodeType: 'delay',
      config: { seconds: '3', message: '模拟数据处理中…' },
      inputSlots: [{ slotId: 'n2-in', name: 'input', dataType: 'json', required: false }],
      outputSlots: [{ slotId: 'n2-out', name: 'output', dataType: 'json', required: true }],
    },
    {
      nodeId: 'n3', name: '条件判断', nodeType: 'condition',
      config: { field: '0.name', operator: 'not-empty', value: '' },
      inputSlots: [{ slotId: 'n3-in', name: 'input', dataType: 'json', required: true }],
      outputSlots: [
        { slotId: 'cond-true', name: 'true', dataType: 'json', required: true },
        { slotId: 'cond-false', name: 'false', dataType: 'json', required: true },
      ],
    },
    {
      nodeId: 'n4', name: '格式转换', nodeType: 'format-converter',
      config: { sourceFormat: 'json', targetFormat: 'csv' },
      inputSlots: [{ slotId: 'n4-in', name: 'input', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'n4-out', name: 'csv', dataType: 'text', required: true }],
    },
    {
      nodeId: 'n5', name: '空数据通知', nodeType: 'notification-sender',
      config: { title: '数据为空告警', content: '测试 API 返回了空数据，请检查数据源', level: 'warning' },
      inputSlots: [{ slotId: 'n5-in', name: 'input', dataType: 'json', required: false }],
      outputSlots: [{ slotId: 'n5-out', name: 'result', dataType: 'json', required: true }],
    },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'n1', sourceSlotId: 'n1-out', targetNodeId: 'n2', targetSlotId: 'n2-in' },
    { edgeId: 'e2', sourceNodeId: 'n2', sourceSlotId: 'n2-out', targetNodeId: 'n3', targetSlotId: 'n3-in' },
    { edgeId: 'e3', sourceNodeId: 'n3', sourceSlotId: 'cond-true', targetNodeId: 'n4', targetSlotId: 'n4-in' },
    { edgeId: 'e4', sourceNodeId: 'n3', sourceSlotId: 'cond-false', targetNodeId: 'n5', targetSlotId: 'n5-in' },
  ],
};

const DEFAULT_API_URL = 'https://jsonplaceholder.typicode.com/users';

// ═══════════════════════════════════════════════════════════════
// 小组件
// ═══════════════════════════════════════════════════════════════

function HelpTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex ml-1">
      <span
        className="surface-action w-4 h-4 rounded-full inline-flex items-center justify-center cursor-help transition-colors select-none"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        <HelpCircle className="w-3 h-3" />
      </span>
      {show && (
        <span
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2.5 text-[11px] rounded-[10px] w-72 z-50 leading-relaxed pointer-events-none"
          style={{ ...glassTooltip, color: 'var(--text-secondary)' }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function StepStatusBadge({ status, durationMs }: { status: string; durationMs?: number }) {
  if (status === 'completed') return (
    <Badge variant="success" size="sm" icon={<CheckCircle2 className="w-3 h-3" />}>
      完成{durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}
    </Badge>
  );
  if (status === 'running') return (
    <Badge variant="featured" size="sm" icon={<MapSpinner size={12} />}>
      执行中
    </Badge>
  );
  if (status === 'failed') return (
    <Badge variant="danger" size="sm" icon={<AlertCircle className="w-3 h-3" />}>
      失败
    </Badge>
  );
  if (status === 'skipped') return (
    <Badge variant="subtle" size="sm">已跳过</Badge>
  );
  return <Badge variant="subtle" size="sm">等待执行</Badge>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const EXEC_STATUS_MAP: Record<string, { label: string; variant: 'success' | 'danger' | 'warning' | 'featured' | 'subtle' }> = {
  queued: { label: '排队中', variant: 'warning' },
  running: { label: '执行中', variant: 'featured' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  cancelled: { label: '已取消', variant: 'subtle' },
};

// ═══════════════════════════════════════════════════════════════
// 实时日志类型 + 面板
// ═══════════════════════════════════════════════════════════════

interface LogEntry {
  id: string;
  ts: string;
  level: 'info' | 'success' | 'error' | 'warn';
  nodeId?: string;
  nodeName?: string;
  message: string;
  detail?: string;
}

function ExecutionLogPanel({ entries, onClear }: { entries: LogEntry[]; onClear: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }

  return (
    <div
      className="surface-inset workflow-log-panel flex flex-col h-full flex-shrink-0 border-l border-token-subtle"
    >
      {/* Header */}
      <div className="surface-panel-header flex items-center gap-2 px-3 py-2.5 flex-shrink-0">
        <Terminal className="w-3.5 h-3.5 text-token-accent" />
        <span className="text-[12px] font-semibold flex-1 text-token-primary">
          实时日志
        </span>
        <span className="text-[10px] text-token-muted">
          {entries.length} 条
        </span>
        {entries.length > 0 && (
          <button
            onClick={onClear}
            className="p-1 rounded-[6px] text-token-muted transition-colors hover-bg-soft"
            title="清空日志"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 font-mono"
        onScroll={handleScroll}
      >
        {entries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 opacity-40">
            <Terminal className="w-6 h-6" />
            <span className="text-[11px] text-token-muted">
              执行工作流后日志将在此显示
            </span>
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`flex items-start gap-1.5 px-2 py-1 rounded-[6px] transition-colors ${entry.level === 'error' ? 'workflow-log-row-error' : ''}`}
          >
            {/* Level dot */}
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px] workflow-log-level-${entry.level}`}
            />
            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] text-token-muted">
                  {entry.ts}
                </span>
                {entry.nodeName && (
                  <span className="surface-action surface-action-accent text-[9px] px-1.5 py-0 rounded-[4px] font-medium">
                    {entry.nodeName}
                  </span>
                )}
              </div>
              <div className="text-[10px] leading-relaxed text-token-secondary">
                {entry.message}
              </div>
              {entry.detail && (
                <pre
                  className="text-[9px] mt-0.5 leading-relaxed whitespace-pre-wrap break-all max-h-20 overflow-auto text-token-muted"
                >
                  {entry.detail}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 产物预览
// ═══════════════════════════════════════════════════════════════

function ArtifactCard({ artifact, isExpanded, onToggle, onPreview }: {
  artifact: ExecutionArtifact;
  isExpanded: boolean;
  onToggle: () => void;
  onPreview?: () => void;
}) {
  const hasInline = !!artifact.inlineContent;
  const hasContent = hasInline || !!artifact.cosUrl;

  function getDownloadName(): string {
    const name = artifact.name || 'output';
    if (/\.\w{1,5}$/.test(name)) return name;
    const ext = artifact.mimeType === 'text/markdown' ? '.md'
      : artifact.mimeType === 'text/html' ? '.html'
      : artifact.mimeType === 'application/json' ? '.json'
      : artifact.mimeType === 'text/csv' ? '.csv' : '.txt';
    return name + ext;
  }

  const downloadName = getDownloadName();

  /** 下载：inlineContent 直接 blob，COS URL fetch→blob（跨域 download 属性不生效） */
  async function handleDownload(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      let blob: Blob;
      if (artifact.inlineContent) {
        blob = new Blob([artifact.inlineContent], { type: artifact.mimeType || 'text/plain' });
      } else if (artifact.cosUrl) {
        const resp = await fetch(artifact.cosUrl);
        blob = await resp.blob();
      } else return;
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = downloadName;
      link.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      if (artifact.cosUrl) window.open(artifact.cosUrl, '_blank');
    }
  }

  return (
    <div
      className="surface-inset rounded-[10px] overflow-hidden"
    >
      <div
        className="flex items-center gap-2 px-3 py-2 surface-row cursor-pointer"
        onClick={hasInline ? onToggle : undefined}
      >
        <FileText className="w-3.5 h-3.5 flex-shrink-0 text-token-muted" />
        <span className="text-[12px] font-medium flex-1 truncate text-token-primary">
          {downloadName}
        </span>
        <span className="text-[10px] flex-shrink-0 text-token-muted">
          {formatBytes(artifact.sizeBytes)}
        </span>
        {/* Preview button */}
        {hasContent && onPreview && (
          <button
            onClick={(e) => { e.stopPropagation(); onPreview(); }}
            className="surface-row p-1 rounded-[6px] flex-shrink-0 text-token-accent transition-colors"
            title="预览"
          >
            <Eye className="w-3 h-3" />
          </button>
        )}
        {/* Download link (always visible for any artifact with content) */}
        {hasContent && (
          <a
            href={artifact.cosUrl || '#'}
            download={downloadName}
            onClick={handleDownload}
            className="surface-row p-1 rounded-[6px] flex-shrink-0 text-token-accent transition-colors"
            title={`下载 ${downloadName}`}
          >
            <Download className="w-3 h-3" />
          </a>
        )}
        {hasInline && (
          isExpanded
            ? <ChevronDown className="w-3 h-3 flex-shrink-0 text-token-muted" />
            : <ChevronRight className="w-3 h-3 flex-shrink-0 text-token-muted" />
        )}
      </div>
      {isExpanded && artifact.inlineContent && (
        <div className="px-3 pb-2.5 border-t border-token-nested">
          <pre
            className="surface-code text-token-secondary text-[11px] rounded-[8px] p-2.5 mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
          >
            {artifact.inlineContent}
          </pre>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 步骤卡片
// ═══════════════════════════════════════════════════════════════

function StepCard({ meta, nodeExec, output, expandedArtifacts, onToggleArtifact, onPreviewArtifact, isLast }: {
  meta: StepMeta;
  nodeExec?: NodeExecution;
  output?: { logs: string; artifacts: ExecutionArtifact[] };
  expandedArtifacts: Set<string>;
  onToggleArtifact: (id: string) => void;
  onPreviewArtifact: (art: ExecutionArtifact) => void;
  isLast: boolean;
}) {
  const status = nodeExec?.status || 'idle';
  const isActive = status === 'running';
  const indexClass = status === 'completed'
    ? 'workflow-step-index-completed'
    : status === 'running'
      ? 'workflow-step-index-running'
      : status === 'failed'
        ? 'workflow-step-index-failed'
        : '';

  return (
    <div>
      <GlassCard
        animated
        accentHue={meta.accentHue}
        glow={isActive}
        padding="md"
        className={isActive ? 'ring-1 ring-white/10' : ''}
      >
        {/* 头部：序号 + 图标 + 名称 + 状态 */}
        <div className="flex items-start gap-3">
          <span
            className={`workflow-step-index ${indexClass} w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 mt-0.5`}
          >
            {status === 'completed' ? '✓' : meta.step}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-base">{meta.icon}</span>
              <h3 className="text-[14px] font-semibold text-token-primary">
                {meta.name}
              </h3>
              <HelpTip text={meta.helpTip} />
            </div>
            <p className="text-[11px] mt-0.5 leading-relaxed text-token-muted">
              {meta.desc}
            </p>
          </div>
          <div className="flex-shrink-0">
            <StepStatusBadge status={status} durationMs={nodeExec?.durationMs} />
          </div>
        </div>

        {/* 舱类型 + 接收 / 产出 标签 */}
        <div className="ml-10 mt-3 flex flex-wrap gap-2">
          {meta.capsuleType && (() => {
            const ct = getCapsuleType(meta.capsuleType);
            if (!ct) return null;
            const CIcon = ct.Icon;
            return (
              <span className="surface-inset text-token-muted inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium">
                <CIcon className="w-2.5 h-2.5" />
                {ct.name}
              </span>
            );
          })()}
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{
              background: `hsla(${meta.accentHue}, 60%, 55%, 0.1)`,
              color: `hsla(${meta.accentHue}, 60%, 65%, 0.9)`,
              border: `1px solid hsla(${meta.accentHue}, 60%, 55%, 0.15)`,
            }}
          >
            接收: {meta.inputLabel}
          </span>
          <span
            className="surface-action-success border inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium"
          >
            产出: {meta.outputLabel}
          </span>
        </div>

        {/* 执行中进度条 */}
        {status === 'running' && (
          <div className="ml-10 mt-3 flex items-center gap-2">
            <div className="surface-inset flex-1 h-1.5 rounded-full overflow-hidden">
              <div
                className="workflow-progress-fill h-full w-3/5 rounded-full animate-pulse"
              />
            </div>
            <span className="text-[10px] text-token-accent">处理中...</span>
          </div>
        )}

        {/* 步骤产出展示 */}
        {(status === 'completed' || status === 'failed') && output && (
          <div className="ml-10 mt-3 space-y-2">
            {output.artifacts.length > 0 && (
              <div className="space-y-1.5">
                {output.artifacts.map((art) => (
                  <ArtifactCard
                    key={art.artifactId}
                    artifact={art}
                    isExpanded={expandedArtifacts.has(art.artifactId)}
                    onToggle={() => onToggleArtifact(art.artifactId)}
                    onPreview={() => onPreviewArtifact(art)}
                  />
                ))}
              </div>
            )}

            {output.logs && output.artifacts.length === 0 && (
              <div>
                <span className="text-[10px] font-medium text-token-muted">执行日志</span>
                <pre
                  className="surface-code text-token-secondary text-[10px] rounded-[8px] p-2.5 mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
                >
                  {output.logs.slice(0, 800)}
                  {output.logs.length > 800 ? '\n...(更多日志请查看完整详情)' : ''}
                </pre>
              </div>
            )}

            {!output.logs && output.artifacts.length === 0 && (
              <span className="text-[10px] text-token-muted">处理完成，无附加产出</span>
            )}

            {nodeExec?.errorMessage && (
              <div
                className="surface-state-danger text-[11px] rounded-[8px] px-3 py-2 leading-relaxed"
              >
                {nodeExec.errorMessage}
              </div>
            )}
          </div>
        )}
      </GlassCard>

      {/* 步骤间连接箭头 */}
      {!isLast && (
        <div className="flex justify-center py-2">
          <div className="flex flex-col items-center gap-0.5">
            <ArrowDown className="w-4 h-4 text-token-muted-faint" />
            {meta.feedsToLabel && (
              <span className="text-[10px] text-token-muted opacity-60">
                {meta.feedsToLabel}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 舱目录面板
// ═══════════════════════════════════════════════════════════════

function CapsuleCatalogPanel({ onBack }: { onBack: () => void }) {
  const [capsuleTypes, setCapsuleTypes] = useState<CapsuleTypeMeta[]>([]);
  const [categories, setCategories] = useState<CapsuleCategoryInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [testingType, setTestingType] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<CapsuleTestRunResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setCatalogLoading(true);
      try {
        const res = await listCapsuleTypes();
        if (res.success && res.data) {
          setCapsuleTypes(res.data.items);
          setCategories(res.data.categories);
        }
      } catch { /* ignore */ }
      setCatalogLoading(false);
    })();
  }, []);

  // 按 category 分组
  const grouped = categories.reduce<Record<string, CapsuleTypeMeta[]>>((acc, cat) => {
    acc[cat.key] = capsuleTypes.filter(t => t.category === cat.key);
    return acc;
  }, {});

  async function handleTestRun(typeKey: string) {
    setTestingType(typeKey);
    setTestResult(null);
    setTestError(null);
    try {
      // 从 configSchema 提取默认值作为测试配置
      const meta = capsuleTypes.find(t => t.typeKey === typeKey);
      const defaultConfig: Record<string, string> = {};
      if (meta) {
        for (const field of meta.configSchema) {
          if (field.defaultValue) defaultConfig[field.key] = field.defaultValue;
        }
      }

      const res = await testRunCapsule({ typeKey, config: defaultConfig, mockInput: { _test: true } });
      if (res.success && res.data) {
        setTestResult(res.data.result);
      } else {
        setTestError(res.error?.message || '未知错误');
      }
    } catch (e: unknown) {
      setTestError(e instanceof Error ? e.message : '未知错误');
    }
    setTestingType(null);
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      <TabBar
        title="舱目录"
        icon={<Box size={16} />}
        actions={
          <Button variant="ghost" size="xs" onClick={onBack}>
            返回流水线
          </Button>
        }
      />
      <div className="px-5 pb-6 space-y-6 max-w-3xl mx-auto w-full">
        <p className="text-[12px] leading-relaxed text-token-muted">
          舱是流水线的基本单元。每个舱负责一个独立的处理步骤，可以单独测试调试，然后组装成完整流水线。
        </p>

        {catalogLoading && <MapSectionLoader text="加载舱类型..." />}

        {!catalogLoading && categories.map((cat) => {
          const types = grouped[cat.key] || [];
          if (types.length === 0) return null;
          const catEmoji = getCategoryEmoji(cat.key);

          return (
            <section key={cat.key}>
              <h2 className="text-[14px] font-semibold flex items-center gap-2 mb-3 text-token-primary">
                <span>{catEmoji}</span>
                {cat.label}舱
                <span className="text-[11px] font-normal text-token-muted"> — {cat.description}</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {types.map((meta) => {
                  const Icon = getIconForCapsule(meta.icon);
                  const emoji = getEmojiForCapsule(meta.typeKey);
                  return (
                    <GlassCard key={meta.typeKey} animated accentHue={meta.accentHue} padding="sm">
                      <div className="flex items-start gap-3">
                        <div
                          className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                          style={{
                            background: `hsla(${meta.accentHue}, 60%, 55%, 0.12)`,
                            color: `hsla(${meta.accentHue}, 60%, 65%, 0.95)`,
                          }}
                        >
                          <Icon className="w-4.5 h-4.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-base">{emoji}</span>
                            <h3 className="text-[13px] font-semibold text-token-primary">
                              {meta.name}
                            </h3>
                          </div>
                          <p className="text-[11px] mt-0.5 leading-relaxed text-token-muted">
                            {meta.description}
                          </p>
                          {meta.testable && (
                            <button
                              onClick={() => handleTestRun(meta.typeKey)}
                              disabled={testingType === meta.typeKey}
                              className="surface-row mt-2 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-[6px] font-medium transition-all"
                              style={{
                                background: `hsla(${meta.accentHue}, 60%, 55%, 0.08)`,
                                color: `hsla(${meta.accentHue}, 60%, 65%, 0.9)`,
                                border: `1px solid hsla(${meta.accentHue}, 60%, 55%, 0.15)`,
                              }}
                            >
                              {testingType === meta.typeKey
                                ? <><MapSpinner size={12} />测试中...</>
                                : <><FlaskConical className="w-3 h-3" />单舱测试</>
                              }
                            </button>
                          )}
                        </div>
                        <Badge variant="subtle" size="sm">
                          {cat.label}
                        </Badge>
                      </div>
                    </GlassCard>
                  );
                })}
              </div>
            </section>
          );
        })}

        {/* 测试结果：执行结果 */}
        {testResult && (
          <GlassCard animated accentHue={testResult.status === 'completed' ? 150 : 0} padding="sm">
            <div className="flex items-center gap-2 mb-2">
              <FlaskConical className={`w-4 h-4 ${testResult.status === 'completed' ? 'text-token-success' : 'text-token-error'}`} />
              <span className="text-[12px] font-medium text-token-primary">
                {testResult.typeName}: {testResult.status === 'completed' ? '执行成功' : '执行失败'}
              </span>
              <span className="text-[10px] text-token-muted">
                {testResult.durationMs}ms
              </span>
            </div>
            {testResult.logs && (
              <pre
                className="surface-code text-token-secondary text-[10px] rounded-[8px] p-2 ml-6 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed"
              >
                {testResult.logs}
              </pre>
            )}
            {testResult.artifacts && testResult.artifacts.length > 0 && (
              <div className="space-y-1 ml-6 mt-2">
                {testResult.artifacts.map((art, idx) => (
                  <div key={idx} className="surface-inset rounded-[8px] overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      <span className="text-token-primary">{art.name}</span>
                      <span className="text-token-muted">{art.sizeBytes} bytes</span>
                    </div>
                    {art.inlineContent && (
                      <pre className="text-[10px] px-3 pb-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-token-secondary">
                        {art.inlineContent.slice(0, 2000)}
                        {art.inlineContent.length > 2000 ? '\n...' : ''}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
            {testResult.errorMessage && (
              <p className="text-[11px] mt-2 ml-6 text-token-error">{testResult.errorMessage}</p>
            )}
          </GlassCard>
        )}
        {testError && (
          <GlassCard animated accentHue={0} padding="sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-token-error" />
              <span className="text-[12px] text-token-error">测试失败: {testError}</span>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 主页面
// ═══════════════════════════════════════════════════════════════

interface NodeOutput {
  logs: string;
  artifacts: ExecutionArtifact[];
}

export function WorkflowAgentPage() {
  const { viewMode, setViewMode, setSelectedWorkflow, setSelectedExecution } = useWorkflowStore();

  // 数据状态
  const [tapdWorkflow, setTapdWorkflow] = useState<Workflow | null>(null);
  const [latestExec, setLatestExec] = useState<WorkflowExecution | null>(null);
  const [recentRuns, setRecentRuns] = useState<WorkflowExecution[]>([]);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, NodeOutput>>({});

  // UI 状态
  const [vars, setVars] = useState<Record<string, string>>({ API_URL: DEFAULT_API_URL });
  const [isExecuting, setIsExecuting] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());
  const [showCatalog, setShowCatalog] = useState(false);
  const [showCanvas, setShowCanvas] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<ExecutionArtifact | null>(null);

  // 实时日志
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);

  function addLog(level: LogEntry['level'], message: string, opts?: { nodeId?: string; nodeName?: string; detail?: string }) {
    const entry: LogEntry = {
      id: `log-${logIdRef.current++}`,
      ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message,
      ...opts,
    };
    setLogEntries(prev => [...prev, entry]);
  }

  // SSE 流式订阅
  const sseAbortRef = useRef<AbortController | null>(null);
  const fetchedNodesRef = useRef(new Set<string>());

  // ── 初始化（必须在所有 early return 之前调用 hooks）──

  useEffect(() => {
    init();
    return () => stopSse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 子视图路由
  if (viewMode === 'execution-list') return <ExecutionListPanel />;
  if (viewMode === 'execution-detail') return <ExecutionDetailPanel />;
  if (viewMode === 'shares') return <SharePanel />;
  if (showCanvas && tapdWorkflow) return (
    <WorkflowCanvas
      workflow={tapdWorkflow}
      execution={latestExec}
      onBack={() => setShowCanvas(false)}
      onSaved={(wf) => setTapdWorkflow(wf)}
    />
  );
  if (showCatalog) return <CapsuleCatalogPanel onBack={() => setShowCatalog(false)} />;

  async function init() {
    setPageLoading(true);
    try {
      const wfRes = await listWorkflows({ tag: 'demo', pageSize: 1 });
      if (wfRes.success && wfRes.data?.items?.length) {
        const wf = wfRes.data.items[0];
        setTapdWorkflow(wf);
        setSelectedWorkflow(wf);

        const execRes = await listExecutions({ workflowId: wf.id, pageSize: 5 });
        if (execRes.success && execRes.data?.items?.length) {
          setRecentRuns(execRes.data.items);
          const latest = execRes.data.items[0];
          setLatestExec(latest);

          if (['queued', 'running'].includes(latest.status)) {
            startSse(latest.id);
          } else {
            fetchAllNodeOutputs(latest);
          }
        }
      }
    } catch { /* init fail */ }
    setPageLoading(false);
  }

  // ── SSE 实时状态推送 ──

  function startSse(execId: string) {
    stopSse();
    const ac = new AbortController();
    sseAbortRef.current = ac;
    const token = useAuthStore.getState().token;
    const baseUrl = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_BASE_URL || '';
    const url = `${baseUrl}${api.workflowAgent.executions.stream(execId)}`;

    (async () => {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (!res.ok) {
          // SSE 不可用，回退到轮询
          fallbackPolling(execId);
          return;
        }

        await readSseStream(res, (evt) => {
          if (!evt.data || !evt.event) return;
          try {
            const payload = JSON.parse(evt.data);
            handleSseEvent(evt.event, payload, execId);
          } catch { /* ignore */ }
        }, ac.signal);
      } catch {
        // SSE 连接异常，回退到轮询
        if (!ac.signal.aborted) {
          fallbackPolling(execId);
        }
      }
    })();
  }

  function handleSseEvent(eventName: string, payload: Record<string, unknown>, execId: string) {
    const nodeName = (payload.nodeName as string) || (payload.nodeId as string) || '';
    const nodeId = (payload.nodeId as string) || '';

    if (eventName === 'node-started') {
      setLatestExec(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          status: 'running',
          nodeExecutions: prev.nodeExecutions.map(ne =>
            ne.nodeId === nodeId ? { ...ne, status: 'running', startedAt: new Date().toISOString() } : ne
          ),
        };
      });
      const inputCount = payload.inputArtifactCount as number | undefined;
      addLog('info', `开始执行${inputCount ? ` (${inputCount} 个输入产物)` : ''}`, { nodeId, nodeName });
    } else if (eventName === 'node-completed') {
      const durationMs = payload.durationMs as number;
      const artifactCount = payload.artifactCount as number | undefined;
      setLatestExec(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          nodeExecutions: prev.nodeExecutions.map(ne =>
            ne.nodeId === nodeId
              ? { ...ne, status: 'completed', durationMs, completedAt: new Date().toISOString() }
              : ne
          ),
        };
      });
      if (!fetchedNodesRef.current.has(nodeId)) {
        fetchedNodesRef.current.add(nodeId);
        fetchNodeOutput(execId, nodeId);
      }
      addLog('success', `完成 (${(durationMs / 1000).toFixed(1)}s)${artifactCount ? ` · ${artifactCount} 个产物` : ''}`, { nodeId, nodeName });

      // 显示 SSE 中携带的日志摘要
      const logs = payload.logs as string | undefined;
      if (logs) {
        const lines = logs.split('\n').filter(Boolean).slice(0, 8);
        for (const line of lines) {
          addLog('info', line, { nodeId, nodeName });
        }
      }
    } else if (eventName === 'node-failed') {
      const errorMsg = payload.errorMessage as string;
      const durationMs = payload.durationMs as number;
      setLatestExec(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          nodeExecutions: prev.nodeExecutions.map(ne =>
            ne.nodeId === nodeId
              ? { ...ne, status: 'failed', errorMessage: errorMsg, durationMs, completedAt: new Date().toISOString() }
              : ne
          ),
        };
      });
      if (!fetchedNodesRef.current.has(nodeId)) {
        fetchedNodesRef.current.add(nodeId);
        fetchNodeOutput(execId, nodeId);
      }
      addLog('error', `失败 (${(durationMs / 1000).toFixed(1)}s): ${errorMsg || '未知错误'}`, { nodeId, nodeName });

      const logs = payload.logs as string | undefined;
      if (logs) {
        const lines = logs.split('\n').filter(Boolean).slice(0, 5);
        for (const line of lines) {
          addLog('warn', line, { nodeId, nodeName });
        }
      }
    } else if (eventName === 'execution-completed') {
      const status = payload.status as string;
      setLatestExec(prev => {
        if (!prev) return prev;
        return { ...prev, status, completedAt: new Date().toISOString(), errorMessage: (payload.errorMessage as string) || undefined };
      });
      const totalMs = payload.durationMs as number | undefined;
      addLog(
        status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warn',
        `执行${status === 'completed' ? '完成' : status === 'failed' ? '失败' : '已取消'}${totalMs ? ` · 总耗时 ${(totalMs / 1000).toFixed(1)}s` : ''}`,
      );
      handleRefresh();
      stopSse();
    }
  }

  function fallbackPolling(execId: string) {
    const iv = setInterval(async () => {
      try {
        const res = await getExecution(execId);
        if (res.success && res.data) {
          const exec = res.data.execution;
          setLatestExec(exec);
          for (const ne of exec.nodeExecutions) {
            if (['completed', 'failed'].includes(ne.status) && !fetchedNodesRef.current.has(ne.nodeId)) {
              fetchedNodesRef.current.add(ne.nodeId);
              fetchNodeOutput(exec.id, ne.nodeId);
            }
          }
          if (['completed', 'failed', 'cancelled'].includes(exec.status)) {
            clearInterval(iv);
          }
        }
      } catch { /* ignore */ }
    }, 2000);
    // Store interval id so stopSse can clear it
    sseAbortRef.current = { abort: () => clearInterval(iv) } as unknown as AbortController;
  }

  function stopSse() {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
    }
  }

  async function fetchNodeOutput(execId: string, nodeId: string) {
    try {
      const res = await getNodeLogs({ executionId: execId, nodeId });
      if (res.success && res.data) {
        setNodeOutputs((prev) => ({
          ...prev,
          [nodeId]: { logs: res.data!.logs || '', artifacts: res.data!.artifacts || [] },
        }));
      }
    } catch { /* ignore */ }
  }

  function fetchAllNodeOutputs(exec: WorkflowExecution) {
    for (const ne of exec.nodeExecutions) {
      if (['completed', 'failed'].includes(ne.status)) {
        fetchedNodesRef.current.add(ne.nodeId);
        fetchNodeOutput(exec.id, ne.nodeId);
      }
    }
  }

  // ── 执行 ──

  async function handleExecute() {
    for (const vc of VAR_CONFIGS) {
      if (vc.required && !vars[vc.key]) {
        alert(`请填写「${vc.label}」`);
        return;
      }
    }

    setIsExecuting(true);
    setNodeOutputs({});
    setExpandedArtifacts(new Set());
    setLogEntries([]);
    fetchedNodesRef.current.clear();
    addLog('info', '开始执行工作流...');

    try {
      let wf = tapdWorkflow;
      if (!wf) {
        const res = await createWorkflow(DEMO_TEMPLATE);
        if (!res.success || !res.data) {
          alert('创建工作流失败: ' + (res.error?.message || '未知错误'));
          setIsExecuting(false);
          return;
        }
        wf = res.data.workflow;
        setTapdWorkflow(wf);
        setSelectedWorkflow(wf);
      }

      const res = await executeWorkflow({ id: wf.id, variables: vars });
      if (res.success && res.data) {
        const exec = res.data.execution;
        setLatestExec(exec);
        setRecentRuns((prev) => [exec, ...prev.slice(0, 4)]);
        startSse(exec.id);
      } else {
        alert('执行失败: ' + (res.error?.message || '未知错误'));
      }
    } catch (e: unknown) {
      alert('执行出错: ' + (e instanceof Error ? e.message : '未知错误'));
    }

    setIsExecuting(false);
  }

  async function handleCancel() {
    if (!latestExec || !confirm('确定取消当前执行？')) return;
    await cancelExecution(latestExec.id);
    stopSse();
    try {
      const res = await getExecution(latestExec.id);
      if (res.success && res.data) setLatestExec(res.data.execution);
    } catch { /* ignore */ }
  }

  function handleRefresh() {
    if (latestExec) {
      getExecution(latestExec.id).then((res) => {
        if (res.success && res.data) {
          const exec = res.data.execution;
          setLatestExec(exec);
          fetchAllNodeOutputs(exec);
        }
      });
    }
  }

  // ── UI helpers ──

  const isRunning = latestExec && ['queued', 'running'].includes(latestExec.status);
  const isTerminal = latestExec && ['completed', 'failed', 'cancelled'].includes(latestExec.status);
  const runningNode = latestExec?.nodeExecutions.find((ne) => ne.status === 'running');
  const completedCount = latestExec?.nodeExecutions.filter((ne) => ne.status === 'completed').length || 0;

  function toggleArtifact(id: string) {
    setExpandedArtifacts((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const execStatusInfo = latestExec ? EXEC_STATUS_MAP[latestExec.status] : null;

  // ═══ 渲染 ═══

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* ──── 标题栏 ──── */}
      <TabBar
        title="数据自动化流水线"
        icon={<Zap size={16} />}
        actions={
          <div className="flex items-center gap-2">
            {tapdWorkflow && (
              <Button
                variant="primary"
                size="xs"
                onClick={() => setShowCanvas(true)}
              >
                <PenLine className="w-3.5 h-3.5" />
                编排画布
              </Button>
            )}
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowCatalog(true)}
            >
              <Box className="w-3.5 h-3.5" />
              舱目录
            </Button>
            {latestExec && (
              <Button
                variant="ghost"
                size="xs"
                onClick={handleRefresh}
                title="刷新状态"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            )}
            {recentRuns.length > 0 && (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => {
                  if (tapdWorkflow) setSelectedWorkflow(tapdWorkflow);
                  setViewMode('execution-list');
                }}
              >
                <History className="w-3.5 h-3.5" />
                执行历史
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* ──── 左侧主内容 ──── */}
      <div className="flex-1 overflow-y-auto">
      <div className="px-5 pb-6 pt-5 space-y-5 max-w-3xl mx-auto w-full">
        {/* ──── 描述 ──── */}
        <p className="text-[12px] leading-relaxed text-token-muted">
          一键执行 → 实时观察每个节点状态 → 条件分支自动路由 → 查看最终产出
        </p>

        {/* ──── 加载中 ──── */}
        {pageLoading && <MapSectionLoader text="加载中..." />}

        {!pageLoading && (
          <>
            {/* ──── 数据源配置 ──── */}
            <GlassCard animated>
              <h2 className="text-[14px] font-semibold flex items-center gap-2 mb-4 text-token-primary">
                <Settings2 className="w-4 h-4 text-token-muted" />
                数据源配置
              </h2>
              <div className="space-y-4">
                {VAR_CONFIGS.map((vc) => (
                  <div key={vc.key}>
                    <label className="flex items-center text-[12px] mb-1.5 text-token-secondary">
                      {vc.label}
                      {vc.required && <span className="ml-0.5 text-token-error">*</span>}
                      <HelpTip text={vc.helpTip} />
                    </label>
                    <input
                      type={vc.type === 'month' ? 'month' : vc.type}
                      value={vars[vc.key] || ''}
                      onChange={(e) => setVars((prev) => ({ ...prev, [vc.key]: e.target.value }))}
                      placeholder={vc.placeholder}
                      disabled={!!isRunning}
                      className="prd-field w-full h-[36px] px-3 rounded-[10px] text-[12px] outline-none disabled:opacity-50 transition-all"
                    />
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* ──── 操作按钮 ──── */}
            <div className="flex items-center gap-3">
              {isRunning ? (
                <>
                  <GlassCard animated padding="none" className="flex-1" accentHue={234} glow>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <MapSpinner size={16} color="var(--accent-gold)" />
                      <span className="text-[12px] font-medium text-token-accent">
                        执行中 — {completedCount}/{STEPS.length}
                        {runningNode ? ` ${runningNode.nodeName}...` : ''}
                      </span>
                    </div>
                  </GlassCard>
                  <Button variant="danger" size="sm" onClick={handleCancel}>
                    <XCircle className="w-3.5 h-3.5" />
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  className="w-full"
                  onClick={handleExecute}
                  disabled={isExecuting}
                >
                  {isExecuting
                    ? <><MapSpinner size={16} />提交中...</>
                    : <><Play className="w-4 h-4" />{latestExec ? '重新执行' : '开始执行'}</>
                  }
                </Button>
              )}
            </div>

            {/* ──── 执行流水线 ──── */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-[14px] font-semibold text-token-primary">
                  执行流水线
                </h2>
                {execStatusInfo && (
                  <Badge variant={execStatusInfo.variant} size="sm">
                    {execStatusInfo.label}
                  </Badge>
                )}
              </div>
              <div className="space-y-0">
                {STEPS.map((meta, idx) => (
                  <StepCard
                    key={meta.nodeId}
                    meta={meta}
                    nodeExec={latestExec?.nodeExecutions.find((ne) => ne.nodeId === meta.nodeId)}
                    output={nodeOutputs[meta.nodeId]}
                    expandedArtifacts={expandedArtifacts}
                    onToggleArtifact={toggleArtifact}
                    onPreviewArtifact={(art) => setPreviewArtifact(art)}
                    isLast={idx === STEPS.length - 1}
                  />
                ))}
              </div>
            </section>

            {/* ──── 执行完成总结 ──── */}
            {isTerminal && latestExec && (
              <GlassCard
                animated
                accentHue={latestExec.status === 'completed' ? 150 : 0}
                glow={latestExec.status === 'completed'}
              >
                <div className="flex items-center gap-2">
                  {latestExec.status === 'completed'
                    ? <CheckCircle2 className="w-5 h-5 text-token-success" />
                    : <AlertCircle className="w-5 h-5 text-token-error" />
                  }
                  <span className="text-[14px] font-semibold text-token-primary">
                    {latestExec.status === 'completed' ? '全部步骤执行完成' :
                     latestExec.status === 'failed' ? '执行过程中出现错误' : '执行已取消'}
                  </span>
                  {latestExec.completedAt && latestExec.startedAt && (
                    <span className="text-[11px] ml-auto text-token-muted">
                      总耗时 {((new Date(latestExec.completedAt).getTime() - new Date(latestExec.startedAt).getTime()) / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                {latestExec.errorMessage && (
                  <p className="text-[11px] mt-2 leading-relaxed text-token-error">
                    {latestExec.errorMessage}
                  </p>
                )}
                {latestExec.finalArtifacts.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    <span className="text-[11px] font-medium text-token-muted">最终产物</span>
                    {latestExec.finalArtifacts.map((art) => (
                      <ArtifactCard
                        key={art.artifactId}
                        artifact={art}
                        isExpanded={expandedArtifacts.has(art.artifactId)}
                        onToggle={() => toggleArtifact(art.artifactId)}
                        onPreview={() => setPreviewArtifact(art)}
                      />
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    setSelectedExecution(latestExec);
                    setViewMode('execution-detail');
                  }}
                  className="mt-3 text-[11px] inline-flex items-center gap-1 text-token-accent transition-colors hover:underline"
                >
                  查看完整执行详情 <ExternalLink className="w-3 h-3" />
                </button>
              </GlassCard>
            )}

            {/* ──── 最近执行记录 ──── */}
            {recentRuns.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[14px] font-semibold text-token-primary">
                    最近执行
                  </h2>
                </div>
                <div className="space-y-1.5">
                  {recentRuns.slice(0, 3).map((run) => {
                    const si = EXEC_STATUS_MAP[run.status];
                    return (
                      <div
                        key={run.id}
                        onClick={() => {
                          setSelectedExecution(run);
                          setViewMode('execution-detail');
                        }}
                        className="surface-row bg-token-card border border-token-nested flex items-center gap-3 rounded-[10px] px-3 py-2.5 cursor-pointer transition-all"
                      >
                        {si && <Badge variant={si.variant} size="sm">{si.label}</Badge>}
                        <span className="text-[11px] text-token-muted">
                          {new Date(run.createdAt).toLocaleString('zh-CN')}
                        </span>
                        <span className="flex-1" />
                        {run.completedAt && run.startedAt && (
                          <span className="text-[10px] text-token-muted">
                            {((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(0)}s
                          </span>
                        )}
                        <ExternalLink className="w-3 h-3 flex-shrink-0 text-token-muted" />
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      </div>

      {/* ──── 右侧日志面板 ──── */}
      <ExecutionLogPanel entries={logEntries} onClear={() => setLogEntries([])} />
      </div>

      {/* 产物预览模态窗 */}
      {previewArtifact && (
        <ArtifactPreviewModal
          artifact={previewArtifact}
          onClose={() => setPreviewArtifact(null)}
        />
      )}
    </div>
  );
}
