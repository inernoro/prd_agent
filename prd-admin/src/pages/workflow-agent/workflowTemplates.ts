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
// 模板 1: TAPD 缺陷数据采集 → 数据统计 → LLM 趋势分析 → 报告导出
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🐛 TAPD 数据采集
//     ↓
//   📊 数据统计（分组计数、分布、趋势）
//     ↓
//   🧠 LLM 趋势分析（仅分析统计摘要）
//     ↓
//   📝 报告生成
//     ↓      ↓
//   💾 导出  🔔 通知
//

const tapdBugCollectionTemplate: WorkflowTemplate = {
  id: 'tapd-bug-collection',
  name: 'TAPD 缺陷采集与分析',
  description: '从 TAPD 拉取缺陷数据 → 统计分析 → AI 趋势解读 → 生成质量报告 → 文件导出 + 站内通知',
  icon: '🐛',
  tags: ['tapd', 'quality', 'report'],
  requiredInputs: [
    {
      key: 'workspaceId',
      label: '工作空间 ID',
      type: 'text',
      placeholder: '50116108',
      helpTip: 'TAPD 项目 URL 中的数字 ID，如 tapd.cn/50116108',
      required: true,
    },
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      placeholder: 'tapdsession=xxx; t_u=xxx; _wt=xxx; ...',
      helpTip: '浏览器登录 TAPD → F12 → Network → 点任意请求 → Headers → 找到 Cookie → 复制整段粘贴到这里',
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
        nodeId: 'n-stats',
        name: '数据统计',
        nodeType: 'data-aggregator',
        config: {
          groupByFields: '缺陷划分,缺陷等级,有效报告,状态,是否逾期,及时处理,结构归母',
          dateField: '创建时间',
          dateGroupBy: 'month',
          topN: '30',
        },
        inputSlots: [{ slotId: 'agg-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'agg-out', name: 'statistics', dataType: 'json', required: true }],
        position: { x: 700, y: 300 },
      },
      {
        nodeId: 'n-llm',
        name: 'AI 趋势分析',
        nodeType: 'llm-analyzer',
        config: {
          systemPrompt: '你是一个软件质量分析专家。你会收到 TAPD 缺陷数据的统计摘要（含缺陷划分分布、缺陷等级分布、有效报告、是否逾期、及时处理、结构归母等维度的分组统计），请按以下 28 个维度生成完整的缺陷统计分析报告。\n\n**重要**：你必须严格基于统计数据计算，列出每个维度的缺陷ID列表。输出 Markdown 格式，包含以下 28 个章节：\n\n1. 缺陷总数\n2. 非缺陷数量（缺陷划分=非缺陷）\n3. 产品缺陷数量（缺陷划分=产品缺陷）\n4. 技术缺陷数量（缺陷划分=技术缺陷）\n5. 无法判断的数量（缺陷划分=无法判断）\n6. 未判断（空）的数量\n7. 无效反馈数量（有效报告=否）\n8. 有效反馈数量（有效报告=是）\n9. P2级及以下技术缺陷数量\n10. P0级别技术缺陷数量\n11. P1级别技术缺陷数量\n12. P2级别技术缺陷数量\n13. P3级别技术缺陷数量\n14. P4级别技术缺陷数量\n15. 未判断缺陷等级技术缺陷数量\n16. 技术缺陷等级统计总和验证\n17. P2级及以下技术缺陷中简报逾期的数量\n18. P2级及以下技术缺陷中未逾期的数量\n19. P2级及以下技术缺陷中简报是否逾期为空的数量\n20. P2级及以下技术缺陷逾期统计总和验证\n21. P2级及以下技术缺陷中及时处理的数量\n22. P2级及以下技术缺陷中未及时处理的数量\n23. P2级及以下技术缺陷中无法判断是否及时处理的数量\n24. P2级及以下技术缺陷及时处理统计总和验证\n25. P2级及以下技术缺陷中已修复的数量（状态=closed/已关闭）\n26. P2级及以下技术缺陷及时修复率（=已修复/P2及以下总数）\n27. P2级及以下技术缺陷及时处理率（=及时处理数/P2及以下总数）\n28. 技术缺陷中"结构归母"字段统计\n\n每个维度必须包含：统计逻辑说明、数量、缺陷ID列表。比率类需包含计算公式和评级（≥90%优秀、≥80%良好、≥70%一般、≥60%需改进、<60%较差）。',
          userPromptTemplate: '以下是 TAPD 缺陷数据的统计摘要，请按 28 个维度生成完整的缺陷统计分析报告：\n\n{{input}}',
          outputFormat: 'markdown',
          temperature: '0.1',
        },
        inputSlots: [{ slotId: 'llm-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'llm-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1000, y: 300 },
      },
      {
        nodeId: 'n-report',
        name: '质量报告生成',
        nodeType: 'report-generator',
        config: {
          reportTemplate: '将以下缺陷统计分析数据整理为最终报告，保持所有 28 个维度的统计内容不变，在末尾补充：\n1. 数据字段信息（可用字段列表）\n2. 总结与改进建议\n\n如果上游已经是完整的 Markdown 报告格式，请直接透传并补充末尾部分即可。',
          format: 'markdown',
        },
        inputSlots: [{ slotId: 'report-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'report-out', name: 'report', dataType: 'text', required: true }],
        position: { x: 1300, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出报告文件',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'markdown',
          fileName: 'tapd-quality-report-{{date}}',
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1600, y: 180 },
      },
      {
        nodeId: 'n-notify',
        name: '完成通知',
        nodeType: 'notification-sender',
        config: {
          title: 'TAPD 缺陷统计分析报告已生成',
          content: '已完成 TAPD 缺陷数据采集、28 维度统计分析，请查看执行结果下载报告',
          level: 'success',
          attachFromInput: 'cos',
        },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1600, y: 420 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-tapd', 'tapd-in'),
      edge('n-tapd', 'tapd-out', 'n-stats', 'agg-in'),
      edge('n-stats', 'agg-out', 'n-llm', 'llm-in'),
      edge('n-llm', 'llm-out', 'n-report', 'report-in'),
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
