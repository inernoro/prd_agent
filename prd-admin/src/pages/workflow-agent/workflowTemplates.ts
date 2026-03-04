import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// 工作流模板注册表 — 预定义的一键导入模板
// ═══════════════════════════════════════════════════════════════

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  /** 模板需要用户填写的变量（导入前弹窗收集） */
  requiredInputs: TemplateInput[];
  /** 构建节点/边/变量，传入用户填写的输入 */
  build: (inputs: Record<string, string>) => {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    variables: WorkflowVariable[];
  };
}

export interface TemplateInput {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'textarea' | 'month';
  placeholder?: string;
  helpTip?: string;
  required: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
}

// ── 辅助函数 ─────────────────────────────────────────────────

let _edgeIdx = 0;
function edge(src: string, srcSlot: string, tgt: string, tgtSlot: string): WorkflowEdge {
  return {
    edgeId: `e-tpl-${_edgeIdx++}`,
    sourceNodeId: src,
    sourceSlotId: srcSlot,
    targetNodeId: tgt,
    targetSlotId: tgtSlot,
  };
}

// ═══════════════════════════════════════════════════════════════
// 模板 1: TAPD 缺陷数据采集 → 预统计 → 报告生成 → 导出+通知
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🐛 TAPD 数据采集（含 common_get_info 详情）
//     ↓
//   📊 数据预处理（JS 精确统计）
//     ↓
//   📝 质量报告生成（LLM 一次性完成分析+报告）
//     ↓      ↓
//   💾 导出  🔔 通知
//

const tapdBugCollectionTemplate: WorkflowTemplate = {
  id: 'tapd-bug-collection',
  name: 'TAPD 缺陷采集与分析',
  description: '从 TAPD 拉取缺陷数据 → JS 预处理统计 → LLM 一次性生成质量分析报告 → 文件导出 + 站内通知',
  icon: '🐛',
  tags: ['tapd', 'quality', 'report'],
  requiredInputs: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      placeholder: 'tapdsession=xxx; t_u=xxx; _wt=xxx; ...',
      helpTip: '浏览器登录 TAPD → F12 → Network → 点任意请求 → Headers → 找到 Cookie → 复制整段粘贴到这里',
      required: true,
    },
    {
      key: 'workspaceId',
      label: '工作空间 ID',
      type: 'text',
      placeholder: '50116108',
      defaultValue: '50116108',
      helpTip: 'TAPD 项目 URL 中的数字 ID，如 tapd.cn/50116108。验证 Cookie 后可从下拉列表选择',
      required: true,
    },
    {
      key: 'dataType',
      label: '数据类型',
      type: 'select',
      required: true,
      defaultValue: 'bugs',
      options: [
        { value: 'bugs', label: '缺陷 (Bugs)' },
        { value: 'stories', label: '需求 (Stories)' },
        { value: 'tasks', label: '任务 (Tasks)' },
        { value: 'iterations', label: '迭代 (Iterations)' },
      ],
    },
    {
      key: 'dateRange',
      label: '时间范围（可选）',
      type: 'month',
      placeholder: '2026-03',
      helpTip: '留空取全部，选择月份按月筛选',
      required: false,
      defaultValue: new Date().toISOString().slice(0, 7),
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击开始采集 TAPD 数据' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 100, y: 300 },
      },
      {
        nodeId: 'n-tapd',
        name: 'TAPD 数据采集',
        nodeType: 'tapd-collector',
        config: {
          authMode: 'cookie',
          workspaceId: inputs.workspaceId || '',
          cookie: inputs.cookie || '',
          dataType: inputs.dataType || 'bugs',
          dateRange: inputs.dateRange || '',
          maxPages: '50',
          fetchDetail: 'true',
        },
        inputSlots: [{ slotId: 'tapd-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tapd-out', name: 'data', dataType: 'json', required: true }],
        position: { x: 400, y: 300 },
      },
      {
        nodeId: 'n-agg',
        name: '数据预处理（JS脚本）',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `// data = 上游 TAPD 缺陷数组
const total = data.length;
const byStatus = {};
const bySeverity = {};
const byPriority = {};

data.forEach(item => {
  const s = item["状态"] || item.status || "未知";
  const sev = item["缺陷等级"] || item.severity || "未知";
  const pri = item["优先级"] || item.priority || "未知";
  byStatus[s] = (byStatus[s] || 0) + 1;
  bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  byPriority[pri] = (byPriority[pri] || 0) + 1;
});

const closed = data.filter(i => ["已关闭","closed","已验证"].includes(i["状态"] || i.status || ""));
const fixRate = total > 0 ? (closed.length / total * 100).toFixed(1) + "%" : "N/A";

result = {
  总数: total,
  修复率: fixRate,
  按状态: byStatus,
  按等级: bySeverity,
  按优先级: byPriority,
};`,
          timeoutSeconds: '30',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 700, y: 300 },
      },
      {
        nodeId: 'n-report',
        name: '质量报告生成',
        nodeType: 'report-generator',
        config: {
          reportTemplate: '你是一个软件质量分析专家。你会收到一份由 JS 脚本预处理后的 TAPD 缺陷统计数据（JSON 格式），包含按状态、等级、优先级的分布统计和修复率。\n\n请基于这些数据，一次性生成完整的 Markdown 质量分析报告，包含：\n\n1. **数据概览**：缺陷总数、修复率、各维度统计\n2. **按状态分布**：引用 JSON 中的具体数字\n3. **按等级分布**：严重/致命缺陷占比分析\n4. **按优先级分布**：高优先级缺陷关注点\n5. **风险提示**：高严重度或高优先级缺陷的风险\n6. **改进建议**：基于数据给出 2-3 条具体可执行建议\n7. **数据采集说明**：数据来源 TAPD，由代码精确计算',
          format: 'markdown',
        },
        inputSlots: [{ slotId: 'report-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'report-out', name: 'report', dataType: 'text', required: true }],
        position: { x: 1000, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出报告文件',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'md',
          fileName: `tapd-quality-report-{{date}}-${inputs.workspaceId || 'unknown'}`,
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1300, y: 180 },
      },
      {
        nodeId: 'n-notify',
        name: '完成通知',
        nodeType: 'notification-sender',
        config: {
          title: 'TAPD 缺陷质量报告已生成',
          content: '已完成 TAPD 缺陷数据采集与质量分析，请查看执行结果下载报告',
          level: 'success',
          attachFromInput: 'cos',
        },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1300, y: 420 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-tapd', 'tapd-in'),
      edge('n-tapd', 'tapd-out', 'n-agg', 'script-in'),
      edge('n-agg', 'script-out', 'n-report', 'report-in'),
      edge('n-report', 'report-out', 'n-export', 'export-in'),
      edge('n-report', 'report-out', 'n-notify', 'notify-in'),
    ];

    const variables: WorkflowVariable[] = [];

    return { nodes, edges, variables };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板 2: 通用 API 数据采集 (通过 cURL 粘贴)
// ═══════════════════════════════════════════════════════════════

const smartHttpTemplate: WorkflowTemplate = {
  id: 'smart-http-collector',
  name: '通用 API 采集',
  description: '粘贴 cURL 命令 → AI 自动分页拉取全量数据 → 格式转换 → 文件导出',
  icon: '🌐',
  tags: ['api', 'http', 'curl'],
  requiredInputs: [
    {
      key: 'curlCommand',
      label: 'cURL 命令',
      type: 'text',
      placeholder: "curl 'https://api.example.com/data?page=1' -H 'Authorization: Bearer xxx'",
      helpTip: '从浏览器 DevTools → Network → 右键请求 → Copy as cURL',
      required: true,
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击开始采集' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 100, y: 300 },
      },
      {
        nodeId: 'n-smart',
        name: '智能 HTTP 采集',
        nodeType: 'smart-http',
        config: {
          curlCommand: inputs.curlCommand || '',
          paginationType: 'auto',
          maxPages: '10',
        },
        inputSlots: [{ slotId: 'smart-in', name: 'context', dataType: 'json', required: false }],
        outputSlots: [
          { slotId: 'smart-out', name: 'data', dataType: 'json', required: true },
          { slotId: 'smart-meta', name: 'meta', dataType: 'json', required: false },
        ],
        position: { x: 450, y: 300 },
      },
      {
        nodeId: 'n-convert',
        name: '转为 CSV',
        nodeType: 'format-converter',
        config: {
          sourceFormat: 'json',
          targetFormat: 'csv',
          prettyPrint: 'true',
        },
        inputSlots: [{ slotId: 'convert-in', name: 'input', dataType: 'text', required: true }],
        outputSlots: [{ slotId: 'convert-out', name: 'converted', dataType: 'text', required: true }],
        position: { x: 800, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '文件导出',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'csv',
          fileName: 'api-data-{{date}}',
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1150, y: 300 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-smart', 'smart-in'),
      edge('n-smart', 'smart-out', 'n-convert', 'convert-in'),
      edge('n-convert', 'convert-out', 'n-export', 'export-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 注册表
// ═══════════════════════════════════════════════════════════════

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  tapdBugCollectionTemplate,
  smartHttpTemplate,
];
