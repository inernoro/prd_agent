import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listWorkflows, createWorkflow, deleteWorkflow } from '@/services';
import type { Workflow, WorkflowNode, WorkflowEdge } from '@/services/contracts/workflowAgent';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { getEmojiForCapsule, getCapsuleType } from './capsuleRegistry';
import { NodeTypeLabels } from '@/services/contracts/workflowAgent';
import { TemplatePickerDialog } from './TemplatePickerDialog';
import type { WorkflowTemplate } from './workflowTemplates';

// ═══════════════════════════════════════════════════════════════
// 工作流列表页 — 卡片网格 + 统计总览 + Mini DAG 预览
// ═══════════════════════════════════════════════════════════════

// ── 工具函数 ─────────────────────────────────────────────────

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '从未';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '从未';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/** 节点类型 → 分类色相 */
const CATEGORY_HUE: Record<string, number> = {
  'timer': 30, 'webhook-receiver': 200, 'manual-trigger': 280, 'file-upload': 170,
  'tapd-collector': 30, 'http-request': 210, 'smart-http': 250, 'llm-analyzer': 270,
  'script-executor': 150, 'data-extractor': 180, 'data-merger': 60, 'format-converter': 45,
  'report-generator': 150, 'file-exporter': 100, 'webhook-sender': 200, 'notification-sender': 340,
};

function getNodeHue(nodeType: string): number {
  return CATEGORY_HUE[nodeType] ?? 220;
}

// ── Mini DAG 预览 (纯 SVG) ────────────────────────────────────

function MiniDag({ nodes, edges }: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) {
  if (nodes.length === 0) {
    return (
      <div
        className="surface-inset flex items-center justify-center rounded-[10px] h-[52px] text-[11px] text-token-muted border-dashed"
      >
        尚未添加节点
      </div>
    );
  }

  // 拓扑排序 → 分层
  const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));
  const inDegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.nodeId, 0);
    downstream.set(n.nodeId, []);
  }
  for (const e of edges) {
    if (nodeMap.has(e.sourceNodeId) && nodeMap.has(e.targetNodeId)) {
      inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
      downstream.get(e.sourceNodeId)?.push(e.targetNodeId);
    }
  }

  // BFS 分层
  const layers: string[][] = [];
  let queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    layers.push(queue);
    const next: string[] = [];
    for (const id of queue) {
      visited.add(id);
      for (const d of downstream.get(id) ?? []) {
        if (!visited.has(d)) {
          const remaining = (inDegree.get(d) ?? 1) - 1;
          inDegree.set(d, remaining);
          if (remaining <= 0 && !next.includes(d)) next.push(d);
        }
      }
    }
    queue = next;
    if (layers.length > 20) break;
  }
  // 未被分层的孤立节点放最后
  const unvisited = nodes.filter(n => !visited.has(n.nodeId));
  if (unvisited.length > 0) layers.push(unvisited.map(n => n.nodeId));

  const R = 6;
  const gapX = 32;
  const gapY = 20;
  const padX = 16;
  const padY = 14;

  const maxPerLayer = Math.max(...layers.map(l => l.length));
  const svgW = padX * 2 + (layers.length - 1) * gapX + R * 2;
  const svgH = padY * 2 + (maxPerLayer - 1) * gapY + R * 2;

  // 计算节点位置
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const x = padX + R + li * gapX;
    const totalH = (layer.length - 1) * gapY;
    const startY = (svgH - totalH) / 2;
    layer.forEach((id, ni) => {
      pos.set(id, { x, y: startY + ni * gapY });
    });
  });

  return (
    <div
      className="surface-inset rounded-[10px] flex items-center justify-center overflow-hidden"
    >
      <svg width="100%" height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="max-h-16">
        {/* 连线 */}
        {edges.map((e) => {
          const from = pos.get(e.sourceNodeId);
          const to = pos.get(e.targetNodeId);
          if (!from || !to) return null;
          return (
            <line
              key={e.edgeId}
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="var(--border-subtle)" strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}
        {/* 节点 */}
        {nodes.map((n) => {
          const p = pos.get(n.nodeId);
          if (!p) return null;
          const hue = getNodeHue(n.nodeType);
          return (
            <circle
              key={n.nodeId}
              cx={p.x} cy={p.y} r={R}
              fill={`hsla(${hue}, 55%, 55%, 0.6)`}
              stroke={`hsla(${hue}, 55%, 65%, 0.3)`}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── 节点类型芯片 ─────────────────────────────────────────────

function NodeChips({ nodes }: { nodes: WorkflowNode[] }) {
  // 去重 + 保持顺序
  const seen = new Set<string>();
  const types: { type: string; emoji: string; label: string }[] = [];
  for (const n of nodes) {
    if (!seen.has(n.nodeType)) {
      seen.add(n.nodeType);
      const def = getCapsuleType(n.nodeType);
      types.push({
        type: n.nodeType,
        emoji: getEmojiForCapsule(n.nodeType),
        label: def?.name ?? NodeTypeLabels[n.nodeType] ?? n.nodeType,
      });
    }
  }
  if (types.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {types.map(({ type, emoji, label }) => (
        <span
          key={type}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
          style={{
            background: `hsla(${getNodeHue(type)}, 50%, 50%, 0.1)`,
            border: `1px solid hsla(${getNodeHue(type)}, 50%, 50%, 0.18)`,
            color: `hsla(${getNodeHue(type)}, 55%, 70%, 0.9)`,
          }}
        >
          <span>{emoji}</span>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

// ── 工作流卡片 ───────────────────────────────────────────────

function WorkflowCard({ workflow, onEdit, onCanvas, onDelete }: {
  workflow: Workflow;
  onEdit: () => void;
  onCanvas: () => void;
  onDelete: () => void;
}) {
  return (
    <GlassCard
      animated
      interactive
      padding="none"
      onClick={onEdit}
      className="group flex flex-col h-full overflow-hidden"
    >
      {/* 主体内容 — flex-1 撑满剩余高度 */}
      <div className="p-4 pb-3 flex-1 flex flex-col">
        {/* 头部：emoji + 名称 + 状态 */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0 text-[18px] overflow-hidden ${workflow.avatarUrl ? 'border border-token-subtle' : 'surface-inset'}`}
            >
              {workflow.avatarUrl
                ? <img src={workflow.avatarUrl} alt="" className="w-full h-full object-cover" />
                : (workflow.icon || '⚡')
              }
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-[13px] font-semibold truncate text-token-primary">
                  {workflow.name || '未命名工作流'}
                </h3>
                <span
                  className={`workflow-status-dot w-2 h-2 rounded-full flex-shrink-0 ${workflow.isEnabled ? 'workflow-status-dot-enabled' : ''}`}
                  title={workflow.isEnabled ? '已启用' : '已禁用'}
                />
              </div>
              <p className="text-[11px] truncate mt-0.5 text-token-muted">
                {workflow.description || `${workflow.nodes.length} 个节点 · ${workflow.edges.length} 条连线`}
              </p>
            </div>
          </div>
        </div>

        {/* Mini DAG 预览 */}
        <MiniDag nodes={workflow.nodes} edges={workflow.edges} />

        {/* 节点类型芯片 */}
        <div className="mt-2.5">
          <NodeChips nodes={workflow.nodes} />
        </div>

        {/* 弹性间距 + 统计行固定在底部 */}
        <div className="flex-1" />
        <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-token-nested">
          <div className="flex items-center gap-3 text-[11px] text-token-muted">
            <span>
              <span className="text-token-secondary">{workflow.executionCount}</span> 次执行
            </span>
            {workflow.lastExecutedAt && (
              <span>
                <span className="opacity-40">·</span> {timeAgo(workflow.lastExecutedAt)}
              </span>
            )}
          </div>
          <div className="text-[10px] text-token-muted">
            {formatDate(workflow.createdAt)}
          </div>
        </div>
      </div>

      {/* 操作栏 — 始终贴底 */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 mt-auto bg-token-nested border-t border-token-nested">
        <button
          className="surface-action surface-action-accent flex-1 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          ✎ 编辑
        </button>
        <button
          className="surface-action flex-1 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150"
          onClick={(e) => { e.stopPropagation(); onCanvas(); }}
        >
          ◇ 画布
        </button>
        <button
          className="surface-action surface-action-danger w-7 h-7 rounded-[8px] text-[11px] font-semibold transition-all duration-150 flex items-center justify-center flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="删除"
        >
          ✕
        </button>
      </div>
    </GlassCard>
  );
}

// ── 空状态 ─────────────────────────────────────────────────

function EmptyState({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <GlassCard animated>
      <div className="flex flex-col items-center py-12 gap-5">
        <div
          className="surface-inset w-20 h-20 rounded-[20px] flex items-center justify-center text-[36px]"
        >
          ⚡
        </div>
        <div className="text-center">
          <h3 className="text-[15px] font-semibold text-token-primary">
            开始自动化
          </h3>
          <p className="text-[12px] mt-1.5 max-w-[280px] text-token-muted">
            创建工作流，用可视化的方式编排数据采集、分析和输出
          </p>
        </div>

        {/* 示意 DAG */}
        <div className="flex items-center gap-2 my-1">
          {['🐛', '→', '🧠', '→', '📝'].map((item, i) => (
            <span
              key={i}
              className={item === '→'
                ? 'text-[12px] opacity-30'
                : 'surface-inset w-9 h-9 rounded-[10px] flex items-center justify-center text-[16px]'
              }
            >
              {item}
            </span>
          ))}
        </div>

        <Button variant="primary" size="sm" onClick={onCreate} disabled={creating}>
          {creating ? '⏳' : '＋'} 新建工作流
        </Button>
      </div>
    </GlassCard>
  );
}

// ── 全套测试工作流模板 ─────────────────────────────────────
//
// 拓扑图：
//   👆 manual-trigger
//     ├─→ 🌐 http-request → 🔍 data-extractor → 💻 script-executor ──→ 🔀 data-merger(in1)
//     └─→ 🐛 tapd-collector → 🤖 smart-http ─────────────────────────→ 🔀 data-merger(in2)
//                                                                          ↓
//                                                                    🔄 format-converter
//                                                                          ↓
//                                                                    🧠 llm-analyzer
//                                                                          ↓
//                                                                    📝 report-generator
//                                                                    ↓     ↓     ↓
//                                                              💾 export  📡 webhook  🔔 notify
//
// 共 13 节点 = 1 trigger + 8 processor + 4 output，覆盖全部可用舱类型

function buildTestWorkflowTemplate(): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const nodes: WorkflowNode[] = [
    // ── 触发 ──
    {
      nodeId: 'n-trigger',
      name: '手动触发',
      nodeType: 'manual-trigger',
      config: { inputPrompt: '点击执行开始全链路测试' },
      inputSlots: [],
      outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
      position: { x: 100, y: 350 },
    },

    // ── 上分支：HTTP → 提取 → 脚本 ──
    {
      nodeId: 'n-http',
      name: 'HTTP 请求（测试）',
      nodeType: 'http-request',
      config: {
        url: 'https://jsonplaceholder.typicode.com/posts?_limit=3',
        method: 'GET',
      },
      inputSlots: [{ slotId: 'http-in', name: 'input', dataType: 'json', required: false }],
      outputSlots: [{ slotId: 'http-out', name: 'response', dataType: 'json', required: true }],
      position: { x: 400, y: 180 },
    },
    {
      nodeId: 'n-extractor',
      name: '数据提取',
      nodeType: 'data-extractor',
      config: {
        expression: '$',
        flattenArray: 'false',
      },
      inputSlots: [{ slotId: 'extract-in', name: 'input', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'extract-out', name: 'extracted', dataType: 'json', required: true }],
      position: { x: 700, y: 180 },
    },
    {
      nodeId: 'n-script',
      name: '代码脚本（透传）',
      nodeType: 'script-executor',
      config: {
        language: 'javascript',
        code: '// 上游数据在 data 变量中，处理结果赋值给 result\nresult = {\n  processed: true,\n  count: Array.isArray(data) ? data.length : 1,\n  items: data\n};',
        timeoutSeconds: '30',
      },
      inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
      position: { x: 1000, y: 180 },
    },

    // ── 下分支：TAPD → 智能HTTP ──
    {
      nodeId: 'n-tapd',
      name: 'TAPD 采集（需配置凭证）',
      nodeType: 'tapd-collector',
      config: {
        apiUrl: 'https://api.tapd.cn',
        workspaceId: '',
        authToken: '',
        dataType: 'bugs',
        dateRange: '',
      },
      inputSlots: [{ slotId: 'tapd-in', name: 'trigger', dataType: 'json', required: false }],
      outputSlots: [{ slotId: 'tapd-out', name: 'data', dataType: 'json', required: true }],
      position: { x: 400, y: 520 },
    },
    {
      nodeId: 'n-smart',
      name: '智能 HTTP（测试）',
      nodeType: 'smart-http',
      config: {
        url: 'https://jsonplaceholder.typicode.com/users?_limit=2',
        method: 'GET',
        paginationType: 'none',
        maxPages: '1',
      },
      inputSlots: [{ slotId: 'smart-in', name: 'context', dataType: 'json', required: false }],
      outputSlots: [
        { slotId: 'smart-out', name: 'data', dataType: 'json', required: true },
        { slotId: 'smart-meta', name: 'meta', dataType: 'json', required: false },
      ],
      position: { x: 700, y: 520 },
    },

    // ── 合并 ──
    {
      nodeId: 'n-merger',
      name: '数据合并',
      nodeType: 'data-merger',
      config: { mergeStrategy: 'object' },
      inputSlots: [
        { slotId: 'merge-in-1', name: 'input1', dataType: 'json', required: true },
        { slotId: 'merge-in-2', name: 'input2', dataType: 'json', required: true },
      ],
      outputSlots: [{ slotId: 'merge-out', name: 'merged', dataType: 'json', required: true }],
      position: { x: 1300, y: 350 },
    },

    // ── 后续处理：转换 → LLM → 报告 ──
    {
      nodeId: 'n-converter',
      name: '格式转换（JSON→Markdown表格）',
      nodeType: 'format-converter',
      config: {
        sourceFormat: 'json',
        targetFormat: 'markdown-table',
        prettyPrint: 'true',
      },
      inputSlots: [{ slotId: 'convert-in', name: 'input', dataType: 'text', required: true }],
      outputSlots: [{ slotId: 'convert-out', name: 'converted', dataType: 'text', required: true }],
      position: { x: 1600, y: 350 },
    },
    {
      nodeId: 'n-llm',
      name: 'LLM 分析',
      nodeType: 'llm-analyzer',
      config: {
        systemPrompt: '你是一个数据分析专家，擅长从结构化数据中发现规律和问题。请用中文回答。',
        userPromptTemplate: '请分析以下数据，给出 3 个关键发现和改进建议：\n\n{{input}}',
        outputFormat: 'markdown',
        temperature: '0.3',
      },
      inputSlots: [{ slotId: 'llm-in', name: 'input', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'llm-out', name: 'result', dataType: 'json', required: true }],
      position: { x: 1900, y: 350 },
    },
    {
      nodeId: 'n-report',
      name: '报告生成',
      nodeType: 'report-generator',
      config: {
        reportTemplate: '将以下数据整理为质量分析报告，包含：\n1. 数据概览\n2. 关键指标统计\n3. 趋势分析\n4. 改进建议',
        format: 'markdown',
      },
      inputSlots: [{ slotId: 'report-in', name: 'data', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'report-out', name: 'report', dataType: 'text', required: true }],
      position: { x: 2200, y: 350 },
    },

    // ── 三路输出 ──
    {
      nodeId: 'n-export',
      name: '文件导出',
      nodeType: 'file-exporter',
      config: {
        fileFormat: 'markdown',
        fileName: 'test-report-{{date}}',
      },
      inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
      position: { x: 2500, y: 180 },
    },
    {
      nodeId: 'n-webhook',
      name: 'Webhook 发送（httpbin）',
      nodeType: 'webhook-sender',
      config: {
        targetUrl: 'https://httpbin.org/post',
      },
      inputSlots: [{ slotId: 'wh-send-in', name: 'data', dataType: 'json', required: true }],
      outputSlots: [{ slotId: 'wh-send-out', name: 'response', dataType: 'json', required: true }],
      position: { x: 2500, y: 350 },
    },
    {
      nodeId: 'n-notify',
      name: '站内通知',
      nodeType: 'notification-sender',
      config: {
        title: '全链路测试完成',
        content: '工作流全链路测试运行成功，请查看执行结果',
        level: 'success',
      },
      inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
      outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
      position: { x: 2500, y: 520 },
    },
  ];

  let edgeIdx = 0;
  const edge = (src: string, srcSlot: string, tgt: string, tgtSlot: string): WorkflowEdge => ({
    edgeId: `e-test-${edgeIdx++}`,
    sourceNodeId: src,
    sourceSlotId: srcSlot,
    targetNodeId: tgt,
    targetSlotId: tgtSlot,
  });

  const edges: WorkflowEdge[] = [
    // trigger → 上下两条分支
    edge('n-trigger', 'manual-out', 'n-http',    'http-in'),
    edge('n-trigger', 'manual-out', 'n-tapd',    'tapd-in'),
    // 上分支：http → extractor → script → merger(in1)
    edge('n-http',      'http-out',    'n-extractor', 'extract-in'),
    edge('n-extractor', 'extract-out', 'n-script',    'script-in'),
    edge('n-script',    'script-out',  'n-merger',    'merge-in-1'),
    // 下分支：tapd → smart-http → merger(in2)
    edge('n-tapd',  'tapd-out',  'n-smart',  'smart-in'),
    edge('n-smart', 'smart-out', 'n-merger', 'merge-in-2'),
    // 合并 → 转换 → LLM → 报告
    edge('n-merger',    'merge-out',   'n-converter', 'convert-in'),
    edge('n-converter', 'convert-out', 'n-llm',       'llm-in'),
    edge('n-llm',       'llm-out',     'n-report',    'report-in'),
    // 报告 → 三路输出
    edge('n-report', 'report-out', 'n-export',  'export-in'),
    edge('n-report', 'report-out', 'n-webhook', 'wh-send-in'),
    edge('n-report', 'report-out', 'n-notify',  'notify-in'),
  ];

  return { nodes, edges };
}

// ── 主页面 ─────────────────────────────────────────────────

export function WorkflowListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingTest, setCreatingTest] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateImporting, setTemplateImporting] = useState(false);

  useEffect(() => {
    reload();
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const res = await listWorkflows({ pageSize: 100 });
      if (res.success && res.data) {
        setWorkflows(res.data.items);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await createWorkflow({
        name: '新建工作流',
        description: '',
        icon: '⚡',
        tags: [],
      });
      if (res.success && res.data) {
        navigate(`/workflow-agent/${res.data.workflow.id}/canvas`);
      }
    } catch { /* ignore */ }
    setCreating(false);
  }

  async function handleCreateTestWorkflow() {
    setCreatingTest(true);
    try {
      const { nodes, edges } = buildTestWorkflowTemplate();
      const res = await createWorkflow({
        name: '全链路测试工作流',
        description: '覆盖全部 13 种舱类型的端到端测试工作流 (手动触发 → HTTP/TAPD → 提取/脚本/智能HTTP → 合并 → 转换 → LLM → 报告 → 导出/Webhook/通知)',
        icon: '🧪',
        tags: ['test', 'full-chain'],
        nodes,
        edges,
      });
      if (res.success && res.data) {
        navigate(`/workflow-agent/${res.data.workflow.id}/canvas`);
      }
    } catch { /* ignore */ }
    setCreatingTest(false);
  }

  async function handleDelete(wf: Workflow) {
    if (!confirm(`确定删除「${wf.name || '未命名'}」？`)) return;
    try {
      const res = await deleteWorkflow(wf.id);
      if (res.success) {
        setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
      }
    } catch { /* ignore */ }
  }

  async function handleImportTemplate(template: WorkflowTemplate, inputs: Record<string, string>) {
    setTemplateImporting(true);
    try {
      const { nodes, edges, variables } = template.build(inputs);
      const res = await createWorkflow({
        name: template.name,
        description: template.description,
        icon: template.icon,
        tags: template.tags,
        nodes,
        edges,
        variables,
      });
      if (res.success && res.data) {
        setTemplateOpen(false);
        navigate(`/workflow-agent/${res.data.workflow.id}/canvas`);
      }
    } catch { /* ignore */ }
    setTemplateImporting(false);
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-4">
      <TabBar
        title="TAPD 数据自动化"
        icon={<span className="text-[14px]">⚡</span>}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setTemplateOpen(true)}
              disabled={creating || creatingTest}
              title="从预定义模板一键创建工作流"
            >
              📋 从模板创建
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCreateTestWorkflow}
              disabled={creatingTest || creating}
              title="一键创建包含全部 13 种舱类型的测试工作流"
            >
              {creatingTest ? '⏳' : '🧪'} 创建全套测试
            </Button>
            <Button
              variant="primary"
              size="xs"
              onClick={handleCreate}
              disabled={creating || creatingTest}
            >
              {creating ? '⏳' : '＋'} 新建工作流
            </Button>
          </div>
        }
      />

      <div className="pb-6 w-full">

        {/* 加载态 */}
        {loading && <MapSectionLoader text="加载中..." />}

        {/* 空状态 */}
        {!loading && workflows.length === 0 && (
          <EmptyState onCreate={handleCreate} creating={creating} />
        )}

        {/* 卡片网格 */}
        {!loading && workflows.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {workflows.map((wf) => (
              <WorkflowCard
                key={wf.id}
                workflow={wf}
                onEdit={() => navigate(`/workflow-agent/${wf.id}`)}
                onCanvas={() => navigate(`/workflow-agent/${wf.id}/canvas`)}
                onDelete={() => handleDelete(wf)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 模板选择器弹窗 */}
      <TemplatePickerDialog
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        onImport={handleImportTemplate}
        importing={templateImporting}
      />
    </div>
  );
}
