import { useEffect, useRef, useState } from 'react';
import {
  Play, History, Loader2, CheckCircle2, AlertCircle,
  ArrowDown, Download, ChevronDown, ChevronRight, FileText,
  ExternalLink, Settings2, XCircle, RefreshCw,
} from 'lucide-react';
import { useWorkflowStore } from '@/stores/workflowStore';
import {
  createWorkflow, executeWorkflow, getExecution, getNodeLogs,
  listWorkflows, listExecutions, cancelExecution,
} from '@/services';
import { ExecutionListPanel } from './ExecutionListPanel';
import { ExecutionDetailPanel } from './ExecutionDetailPanel';
import { SharePanel } from './SharePanel';
import type {
  Workflow, WorkflowExecution, ExecutionArtifact, NodeExecution,
} from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// 流水线步骤元数据 —— 每一步是什么、做什么、接收什么、产出什么
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
}

const STEPS: StepMeta[] = [
  {
    nodeId: 'n1', step: 1, icon: '🐛',
    name: 'Bug 数据采集',
    desc: '通过 TAPD Open API 自动拉取指定月份的所有缺陷记录',
    helpTip: '缺陷（Bug）是 TAPD 中记录的软件问题，包含严重程度、状态、所属模块、负责人等字段。此步骤通过 TAPD 提供的开放接口（Open API）批量拉取原始数据。',
    inputLabel: 'TAPD 凭证 + 目标月份',
    outputLabel: 'Bug 数据列表（JSON）',
    feedsToLabel: '传递给步骤 ③「智能分析」',
  },
  {
    nodeId: 'n2', step: 2, icon: '📋',
    name: '需求数据采集',
    desc: '通过 TAPD Open API 自动拉取指定月份的所有需求记录',
    helpTip: '需求（Story）是 TAPD 中描述产品功能的用户故事，包含优先级、状态、所属迭代、预估工时等。此步骤和 Bug 采集并行执行。',
    inputLabel: 'TAPD 凭证 + 目标月份',
    outputLabel: 'Story 数据列表（JSON）',
    feedsToLabel: '传递给步骤 ③「智能分析」',
  },
  {
    nodeId: 'n3', step: 3, icon: '🧠',
    name: '智能分析',
    desc: 'AI 综合分析缺陷和需求数据，自动生成多维度统计',
    helpTip: '使用大语言模型（LLM）对步骤 ① 和 ② 采集的原始数据进行自动分析。会生成：缺陷趋势、严重程度分布、模块缺陷热点、需求完成率、迭代健康度等多个统计维度。',
    inputLabel: '步骤 ① Bug 数据 + 步骤 ② 需求数据',
    outputLabel: '统计分析结果（JSON）',
    feedsToLabel: '传递给步骤 ④「生成报告」',
  },
  {
    nodeId: 'n4', step: 4, icon: '📄',
    name: '生成报告',
    desc: '将分析结果整理渲染为结构化的月度质量报告',
    helpTip: '将上一步产出的 JSON 统计数据，转换为可阅读的 Markdown 格式报告。包含数据汇总表格、趋势描述和改进建议，可直接用于月度质量会议。',
    inputLabel: '步骤 ③ 分析结果',
    outputLabel: '月度质量报告（Markdown）',
  },
];

// ═══════════════════════════════════════════════════════════════
// 配置项定义 —— 每个参数是什么、怎么填、为什么需要
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
    key: 'TAPD_WORKSPACE_ID',
    label: 'TAPD 工作空间 ID',
    helpTip: '在 TAPD 项目首页的浏览器地址栏中可以找到，是一串数字（如 20000001）。每个项目有唯一的工作空间 ID，用于标识拉取哪个项目的数据。',
    type: 'text',
    placeholder: '例如: 20000001',
    required: true,
  },
  {
    key: 'TAPD_API_TOKEN',
    label: 'API 访问凭证',
    helpTip: '在 TAPD「公司管理 → 应用与服务 → API」中创建。是一个 Base64 编码的字符串（格式: api_user:api_password 经过编码），用于接口身份验证。创建后请妥善保管，此处以密文方式存储。',
    type: 'password',
    placeholder: '例如: dXNlcjpwYXNzd29yZA==',
    required: true,
  },
  {
    key: 'TARGET_MONTH',
    label: '目标月份',
    helpTip: '要统计的数据月份。系统会拉取该月 1 日至月底的全部数据。留空则默认使用当前月份。',
    type: 'month',
    placeholder: '',
    required: false,
  },
];

// ═══════════════════════════════════════════════════════════════
// 后端工作流模板 —— 自动创建时使用
// ═══════════════════════════════════════════════════════════════

const TAPD_TEMPLATE = {
  name: 'TAPD 月度质量报告',
  description: '自动从 TAPD 拉取 Bug 和 Story 数据，统计分析后生成月度质量报告',
  icon: '📊',
  tags: ['tapd', 'quality', 'monthly'],
  variables: [
    { key: 'TAPD_WORKSPACE_ID', label: 'TAPD 工作空间 ID', type: 'string', required: true, isSecret: false },
    { key: 'TAPD_API_TOKEN', label: 'TAPD API Token', type: 'string', required: true, isSecret: true },
    { key: 'TARGET_MONTH', label: '目标月份', type: 'string', required: false, isSecret: false },
  ],
  nodes: [
    { nodeId: 'n1', name: 'Bug 数据采集', nodeType: 'data-collector', config: {}, inputSlots: [], outputSlots: [{ slotId: 's1o', name: 'bugs', dataType: 'json', required: true }] },
    { nodeId: 'n2', name: '需求数据采集', nodeType: 'data-collector', config: {}, inputSlots: [], outputSlots: [{ slotId: 's2o', name: 'stories', dataType: 'json', required: true }] },
    { nodeId: 'n3', name: '智能分析', nodeType: 'llm-code-executor', config: {}, inputSlots: [{ slotId: 's3i1', name: 'bugs', dataType: 'json', required: true }, { slotId: 's3i2', name: 'stories', dataType: 'json', required: true }], outputSlots: [{ slotId: 's3o', name: 'stats', dataType: 'json', required: true }] },
    { nodeId: 'n4', name: '生成报告', nodeType: 'renderer', config: {}, inputSlots: [{ slotId: 's4i', name: 'stats', dataType: 'json', required: true }], outputSlots: [{ slotId: 's4o', name: 'report', dataType: 'text', required: true }] },
  ],
  edges: [
    { edgeId: 'e1', sourceNodeId: 'n1', sourceSlotId: 's1o', targetNodeId: 'n3', targetSlotId: 's3i1' },
    { edgeId: 'e2', sourceNodeId: 'n2', sourceSlotId: 's2o', targetNodeId: 'n3', targetSlotId: 's3i2' },
    { edgeId: 'e3', sourceNodeId: 'n3', sourceSlotId: 's3o', targetNodeId: 'n4', targetSlotId: 's4i' },
  ],
};

function getDefaultMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// 小组件
// ═══════════════════════════════════════════════════════════════

/** 术语解释气泡 — 鼠标悬停 (?) 显示解释 */
function HelpTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex ml-1">
      <span
        className="w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] inline-flex items-center justify-center cursor-help hover:bg-primary/10 hover:text-primary transition-colors select-none"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
      >
        ?
      </span>
      {show && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2.5 text-xs rounded-lg bg-popover text-popover-foreground border border-border shadow-lg w-72 z-50 leading-relaxed pointer-events-none">
          {text}
        </span>
      )}
    </span>
  );
}

/** 步骤状态指示器 */
function StepStatus({ status, durationMs }: { status: string; durationMs?: number }) {
  if (status === 'completed') return (
    <div className="flex items-center gap-1.5">
      <CheckCircle2 className="w-4 h-4 text-green-500" />
      <span className="text-xs text-green-600 font-medium">
        完成{durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}
      </span>
    </div>
  );
  if (status === 'running') return (
    <div className="flex items-center gap-1.5">
      <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
      <span className="text-xs text-blue-500 font-medium">执行中</span>
    </div>
  );
  if (status === 'failed') return (
    <div className="flex items-center gap-1.5">
      <AlertCircle className="w-4 h-4 text-red-500" />
      <span className="text-xs text-red-500 font-medium">失败</span>
    </div>
  );
  if (status === 'skipped') return (
    <span className="text-xs text-muted-foreground">已跳过</span>
  );
  return <span className="text-xs text-muted-foreground/50">等待执行</span>;
}

/** 执行记录小圆点 */
function StatusDot({ status }: { status: string }) {
  const c =
    status === 'completed' ? 'bg-green-500' :
    status === 'failed' ? 'bg-red-500' :
    status === 'running' ? 'bg-blue-500 animate-pulse' :
    status === 'cancelled' ? 'bg-gray-400' :
    'bg-yellow-500';
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${c}`} />;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消',
};

// ═══════════════════════════════════════════════════════════════
// 产物预览 —— 每个步骤执行完后的可见产出
// ═══════════════════════════════════════════════════════════════

function ArtifactCard({ artifact, isExpanded, onToggle }: {
  artifact: ExecutionArtifact;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasInline = !!artifact.inlineContent;
  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <div
        className={`flex items-center gap-2 px-3 py-2 ${hasInline ? 'cursor-pointer hover:bg-accent/30' : ''}`}
        onClick={hasInline ? onToggle : undefined}
      >
        <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-xs font-medium flex-1 truncate">{artifact.name}</span>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatBytes(artifact.sizeBytes)}</span>
        {artifact.cosUrl && (
          <a
            href={artifact.cosUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="p-1 rounded hover:bg-accent text-primary flex-shrink-0"
            title="下载文件"
          >
            <Download className="w-3 h-3" />
          </a>
        )}
        {hasInline && (
          isExpanded
            ? <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        )}
      </div>
      {isExpanded && artifact.inlineContent && (
        <div className="border-t border-border/50 px-3 pb-2.5">
          <pre className="text-[11px] bg-muted/30 rounded p-2.5 mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
            {artifact.inlineContent}
          </pre>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 步骤卡片 —— 展示单个步骤的完整信息
// ═══════════════════════════════════════════════════════════════

function StepCard({ meta, nodeExec, output, expandedArtifacts, onToggleArtifact, isLast }: {
  meta: StepMeta;
  nodeExec?: NodeExecution;
  output?: { logs: string; artifacts: ExecutionArtifact[] };
  expandedArtifacts: Set<string>;
  onToggleArtifact: (id: string) => void;
  isLast: boolean;
}) {
  const status = nodeExec?.status || 'idle';

  const borderColor =
    status === 'running' ? 'border-blue-500/40' :
    status === 'completed' ? 'border-green-500/30' :
    status === 'failed' ? 'border-red-500/30' :
    'border-border';

  const bgColor =
    status === 'running' ? 'bg-blue-500/[0.03]' :
    status === 'completed' ? 'bg-green-500/[0.03]' :
    status === 'failed' ? 'bg-red-500/[0.03]' :
    'bg-card';

  return (
    <div>
      <div className={`rounded-xl border ${borderColor} ${bgColor} p-4 transition-all`}>
        {/* —— 头部：序号 + 图标 + 名称 + 状态 —— */}
        <div className="flex items-start gap-3">
          <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
            status === 'completed' ? 'bg-green-500 text-white' :
            status === 'running' ? 'bg-blue-500 text-white' :
            status === 'failed' ? 'bg-red-500 text-white' :
            'bg-muted text-muted-foreground'
          }`}>
            {status === 'completed' ? '✓' : meta.step}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-base">{meta.icon}</span>
              <h3 className="text-sm font-semibold">{meta.name}</h3>
              <HelpTip text={meta.helpTip} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{meta.desc}</p>
          </div>
          <div className="flex-shrink-0">
            <StepStatus status={status} durationMs={nodeExec?.durationMs} />
          </div>
        </div>

        {/* —— 接收 / 产出标签 —— */}
        <div className="ml-10 mt-3 flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
            接收: {meta.inputLabel}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
            产出: {meta.outputLabel}
          </span>
        </div>

        {/* —— 执行中提示 —— */}
        {status === 'running' && (
          <div className="ml-10 mt-3 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
            <span className="text-[10px] text-blue-500">处理中...</span>
          </div>
        )}

        {/* —— 步骤产出展示 —— */}
        {(status === 'completed' || status === 'failed') && output && (
          <div className="ml-10 mt-3 space-y-2">
            {/* 产物文件 */}
            {output.artifacts.length > 0 && (
              <div className="space-y-1.5">
                {output.artifacts.map((art) => (
                  <ArtifactCard
                    key={art.artifactId}
                    artifact={art}
                    isExpanded={expandedArtifacts.has(art.artifactId)}
                    onToggle={() => onToggleArtifact(art.artifactId)}
                  />
                ))}
              </div>
            )}

            {/* 执行日志（仅当无产物文件时展示） */}
            {output.logs && output.artifacts.length === 0 && (
              <div>
                <span className="text-[10px] text-muted-foreground font-medium">执行日志</span>
                <pre className="text-[10px] bg-muted/40 rounded-md p-2.5 mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
                  {output.logs.slice(0, 800)}
                  {output.logs.length > 800 ? '\n...(更多日志请查看完整详情)' : ''}
                </pre>
              </div>
            )}

            {/* 无产出 */}
            {!output.logs && output.artifacts.length === 0 && (
              <span className="text-[10px] text-muted-foreground">处理完成，无附加产出</span>
            )}

            {/* 错误信息 */}
            {nodeExec?.errorMessage && (
              <div className="text-xs text-red-500 bg-red-500/5 rounded-md px-3 py-2 leading-relaxed">
                {nodeExec.errorMessage}
              </div>
            )}
          </div>
        )}
      </div>

      {/* —— 步骤间连接箭头 + 数据流向说明 —— */}
      {!isLast && (
        <div className="flex justify-center py-2">
          <div className="flex flex-col items-center gap-0.5">
            <ArrowDown className="w-4 h-4 text-muted-foreground/40" />
            {meta.feedsToLabel && (
              <span className="text-[10px] text-muted-foreground/50">{meta.feedsToLabel}</span>
            )}
          </div>
        </div>
      )}
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

  // —— 数据状态 ——
  const [tapdWorkflow, setTapdWorkflow] = useState<Workflow | null>(null);
  const [latestExec, setLatestExec] = useState<WorkflowExecution | null>(null);
  const [recentRuns, setRecentRuns] = useState<WorkflowExecution[]>([]);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, NodeOutput>>({});

  // —— UI 状态 ——
  const [vars, setVars] = useState<Record<string, string>>({ TARGET_MONTH: getDefaultMonth() });
  const [isExecuting, setIsExecuting] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());

  // —— 轮询 ——
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchedNodesRef = useRef(new Set<string>());

  // —— 子视图路由 ——
  if (viewMode === 'execution-list') return <ExecutionListPanel />;
  if (viewMode === 'execution-detail') return <ExecutionDetailPanel />;
  if (viewMode === 'shares') return <SharePanel />;

  // ── 初始化 ──

  useEffect(() => {
    init();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function init() {
    setPageLoading(true);
    try {
      const wfRes = await listWorkflows({ tag: 'tapd', pageSize: 1 });
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
            startPolling(latest.id);
          } else {
            fetchAllNodeOutputs(latest);
          }
        }
      }
    } catch { /* init fail, show empty state */ }
    setPageLoading(false);
  }

  // ── 轮询执行状态 ──

  function startPolling(execId: string) {
    stopPolling();
    pollingRef.current = setInterval(async () => {
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
            stopPolling();
          }
        }
      } catch { /* ignore poll errors */ }
    }, 2500);
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
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
    fetchedNodesRef.current.clear();

    try {
      let wf = tapdWorkflow;
      if (!wf) {
        const res = await createWorkflow(TAPD_TEMPLATE);
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
        startPolling(exec.id);
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
    stopPolling();
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

  // ═══ 渲染 ═══

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* ──── 标题 ──── */}
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          📊 TAPD 数据自动化
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          填写数据源配置 → 一键执行 → 查看每个步骤的产出 → 获得月度质量报告
        </p>
      </div>

      {/* ──── 加载中 ──── */}
      {pageLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">加载中...</span>
        </div>
      )}

      {!pageLoading && (
        <>
          {/* ──── 数据源配置 ──── */}
          <section className="rounded-xl border border-border p-5 bg-card space-y-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              数据源配置
            </h2>
            {VAR_CONFIGS.map((vc) => (
              <div key={vc.key}>
                <label className="flex items-center text-sm mb-1.5">
                  {vc.label}
                  {vc.required && <span className="text-red-500 ml-0.5">*</span>}
                  <HelpTip text={vc.helpTip} />
                </label>
                <input
                  type={vc.type === 'month' ? 'month' : vc.type}
                  value={vars[vc.key] || ''}
                  onChange={(e) => setVars((prev) => ({ ...prev, [vc.key]: e.target.value }))}
                  placeholder={vc.placeholder}
                  disabled={!!isRunning}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 transition-colors"
                />
              </div>
            ))}
          </section>

          {/* ──── 操作按钮 ──── */}
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <div className="flex-1 flex items-center gap-3 px-4 py-3.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
                  <span className="text-sm text-blue-600 font-medium">
                    执行中 — {completedCount}/{STEPS.length}
                    {runningNode ? ` ${runningNode.nodeName}...` : ''}
                  </span>
                </div>
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-4 py-3.5 text-sm rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  <XCircle className="w-4 h-4" />
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleExecute}
                  disabled={isExecuting}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {isExecuting
                    ? <><Loader2 className="w-4 h-4 animate-spin" />提交中...</>
                    : <><Play className="w-4 h-4" />{latestExec ? '重新执行' : '开始执行'}</>
                  }
                </button>
                {latestExec && (
                  <button
                    onClick={handleRefresh}
                    className="inline-flex items-center gap-1.5 px-4 py-3.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors"
                    title="刷新状态"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                )}
              </>
            )}
          </div>

          {/* ──── 执行流水线 ──── */}
          <section>
            <h2 className="text-sm font-semibold mb-3">
              执行流水线
              {latestExec && (
                <span className={`ml-2 text-xs font-normal px-2 py-0.5 rounded-full ${
                  latestExec.status === 'completed' ? 'bg-green-500/10 text-green-600' :
                  latestExec.status === 'failed' ? 'bg-red-500/10 text-red-600' :
                  latestExec.status === 'running' ? 'bg-blue-500/10 text-blue-600' :
                  latestExec.status === 'cancelled' ? 'bg-gray-500/10 text-gray-500' :
                  'bg-yellow-500/10 text-yellow-600'
                }`}>
                  {STATUS_LABELS[latestExec.status] || latestExec.status}
                </span>
              )}
            </h2>
            <div className="space-y-0">
              {STEPS.map((meta, idx) => (
                <StepCard
                  key={meta.nodeId}
                  meta={meta}
                  nodeExec={latestExec?.nodeExecutions.find((ne) => ne.nodeId === meta.nodeId)}
                  output={nodeOutputs[meta.nodeId]}
                  expandedArtifacts={expandedArtifacts}
                  onToggleArtifact={toggleArtifact}
                  isLast={idx === STEPS.length - 1}
                />
              ))}
            </div>
          </section>

          {/* ──── 执行完成总结 ──── */}
          {isTerminal && latestExec && (
            <div className={`rounded-xl border p-4 ${
              latestExec.status === 'completed'
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-red-500/30 bg-red-500/5'
            }`}>
              <div className="flex items-center gap-2">
                {latestExec.status === 'completed'
                  ? <CheckCircle2 className="w-5 h-5 text-green-500" />
                  : <AlertCircle className="w-5 h-5 text-red-500" />
                }
                <span className="text-sm font-semibold">
                  {latestExec.status === 'completed' ? '全部步骤执行完成' :
                   latestExec.status === 'failed' ? '执行过程中出现错误' : '执行已取消'}
                </span>
                {latestExec.completedAt && latestExec.startedAt && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    总耗时 {((new Date(latestExec.completedAt).getTime() - new Date(latestExec.startedAt).getTime()) / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
              {latestExec.errorMessage && (
                <p className="text-xs text-red-500 mt-2 leading-relaxed">{latestExec.errorMessage}</p>
              )}
              {latestExec.finalArtifacts.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">最终产物</span>
                  {latestExec.finalArtifacts.map((art) => (
                    <ArtifactCard
                      key={art.artifactId}
                      artifact={art}
                      isExpanded={expandedArtifacts.has(art.artifactId)}
                      onToggle={() => toggleArtifact(art.artifactId)}
                    />
                  ))}
                </div>
              )}
              <button
                onClick={() => {
                  setSelectedExecution(latestExec);
                  setViewMode('execution-detail');
                }}
                className="mt-3 text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                查看完整执行详情 <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* ──── 最近执行记录 ──── */}
          {recentRuns.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold">最近执行</h2>
                <button
                  onClick={() => {
                    if (tapdWorkflow) setSelectedWorkflow(tapdWorkflow);
                    setViewMode('execution-list');
                  }}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  查看全部 <History className="w-3 h-3" />
                </button>
              </div>
              <div className="space-y-1.5">
                {recentRuns.slice(0, 3).map((run) => (
                  <div
                    key={run.id}
                    onClick={() => {
                      setSelectedExecution(run);
                      setViewMode('execution-detail');
                    }}
                    className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent/30 cursor-pointer transition-colors"
                  >
                    <StatusDot status={run.status} />
                    <span className="text-xs font-medium">
                      {STATUS_LABELS[run.status] || run.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString('zh-CN')}
                    </span>
                    <span className="flex-1" />
                    {run.completedAt && run.startedAt && (
                      <span className="text-[10px] text-muted-foreground">
                        {((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(0)}s
                      </span>
                    )}
                    <ExternalLink className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
