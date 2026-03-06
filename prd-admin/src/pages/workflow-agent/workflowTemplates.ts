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
        name: '缺陷统计报告生成（JS脚本）',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `// data = 上游 TAPD 缺陷数组（由上游节点传入）
const total = data.length;
const BT = String.fromCharCode(96);
const sid = (arr) => arr.map(i => (i["缺陷ID"] || i.id || "").slice(-7)).filter(Boolean).sort();
const fmtIds = (arr) => "[" + sid(arr).join(", ") + "]";
const fields = total > 0 ? Object.keys(data[0]) : [];

// 按缺陷划分分组
const f缺陷划分 = (v) => data.filter(i => (i["缺陷划分"] || "") === v);
const 非缺陷 = f缺陷划分("非缺陷");
const 产品缺陷 = f缺陷划分("产品缺陷");
const 技术缺陷 = f缺陷划分("技术缺陷");
const 无法判断 = f缺陷划分("无法判断");
const 未判断 = data.filter(i => !(i["缺陷划分"] || "").trim());

// 有效报告
const 无效反馈 = data.filter(i => i["有效报告"] === "否");
const 有效反馈 = data.filter(i => i["有效报告"] === "是");

// 技术缺陷按等级（统一转大写匹配，兼容 p3/P3 混写）
const byLv = (lv) => 技术缺陷.filter(i => (i["缺陷等级"] || "").toUpperCase() === lv);
const p0 = byLv("P0"), p1 = byLv("P1"), p2 = byLv("P2"), p3 = byLv("P3"), p4 = byLv("P4");
const p未判断 = 技术缺陷.filter(i => !(i["缺陷等级"] || "").trim());
const p2及以下 = 技术缺陷.filter(i => ["P2","P3","P4"].includes((i["缺陷等级"] || "").toUpperCase()));
const p2总 = p2及以下.length;

// P2及以下逾期统计
const p2逾期 = p2及以下.filter(i => i["是否逾期"] === "是");
const p2未逾期 = p2及以下.filter(i => i["是否逾期"] === "否");
const p2逾期空 = p2及以下.filter(i => !(i["是否逾期"] || "").trim());

// P2及以下及时处理统计
const isClosed = (i) => ["closed","已关闭"].includes((i["状态"] || "").toLowerCase());
const p2及时 = p2及以下.filter(i => i["及时处理"] === "是");
const p2未及时 = p2及以下.filter(i => i["及时处理"] === "否");
const p2及时空 = p2及以下.filter(i => !(i["及时处理"] || "").trim() || i["及时处理"] === "无法判断");

// P2及以下已修复 & 及时修复
const p2已修复 = p2及以下.filter(i => isClosed(i));
const p2及时修复 = p2及以下.filter(i => i["及时处理"] === "是" && isClosed(i));

// 比率 & 评级
const pct = (n, d) => d > 0 ? (n / d * 100) : 0;
const fmtPct = (v) => v.toFixed(2) + "%";
const 修复率 = pct(p2及时修复.length, p2总);
const 处理率 = pct(p2及时.length, p2总);
const rating = (v) => v >= 90 ? "优秀 🏆" : v >= 80 ? "良好 👍" : v >= 60 ? "需改进 ⚠️" : "较差 🔴";

// 结构归母统计
const 归母Map = {};
技术缺陷.forEach(i => {
  const v = (i["结构归母"] || "").trim() || "暂未归母";
  if (!归母Map[v]) 归母Map[v] = [];
  归母Map[v].push(i);
});

// 验证辅助
const verify = (sum, t, label) => sum === t
  ? "**✓ 验证通过**: 统计总和与" + label + "一致"
  : "**✗ 验证失败**: 统计总和(" + sum + ")与" + label + "(" + t + ")不一致";
const 等级sum = p0.length+p1.length+p2.length+p3.length+p4.length+p未判断.length;
const 逾期sum = p2逾期.length+p2未逾期.length+p2逾期空.length;
const 及时sum = p2及时.length+p2未及时.length+p2及时空.length;
const 归母sum = Object.values(归母Map).reduce((a,b) => a+b.length, 0);

// 时间戳
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const ts = now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+" "+pad(now.getHours())+":"+pad(now.getMinutes())+":"+pad(now.getSeconds());

// ═══ 拼接 Markdown 报告 ═══
const L = [];
L.push("# 📊 缺陷统计分析报告");
L.push("**🕐 生成时间**: " + ts);
L.push("**📁 数据文件**: 缺陷统计数据.xlsx");
L.push("**📈 数据总行数**: " + total);

L.push("## 1. 🏷️ 缺陷总数");
L.push("**📋 统计逻辑**: 统计Excel文件中所有行的数量");
L.push("**🔢 数量**: " + total);
L.push("**📝 缺陷ID列表**: " + BT + fmtIds(data) + BT);

[[2,"❌","非缺陷数量","筛选'缺陷划分'字段值为'非缺陷'的记录","非缺陷",非缺陷],
[3,"📱","产品缺陷数量","筛选'缺陷划分'字段值为'产品缺陷'的记录","产品缺陷",产品缺陷],
[4,"🔧","技术缺陷数量","筛选'缺陷划分'字段值为'技术缺陷'的记录","技术缺陷",技术缺陷],
[5,"❓","无法判断的数量","筛选'缺陷划分'字段值为'无法判断'的记录","无法判断",无法判断],
[6,"⚪","未判断（空）的数量","筛选'缺陷划分'字段值为空的记录","未判断",未判断],
[7,"🚫","无效反馈数量","筛选'有效报告'字段值为'否'的记录","无效反馈",无效反馈],
[8,"✅","有效反馈数量","筛选'有效报告'字段值为'是'的记录","有效反馈",有效反馈]
].forEach(([n,icon,title,logic,label,arr]) => {
  L.push("## "+n+". "+icon+" "+title);
  L.push("**📋 统计逻辑**: "+logic);
  L.push("**🔢 数量**: "+arr.length);
  L.push("**📝 "+label+"ID列表**: "+BT+fmtIds(arr)+BT);
});

L.push("## 9. 📉 P2级及以下技术缺陷数量");
L.push("**📋 统计逻辑**: 在技术缺陷中筛选'缺陷等级'为P2、P3、P4的记录");
L.push("**🔢 数量**: "+p2总);
L.push("**📝 P2级及以下技术缺陷ID列表**: "+BT+fmtIds(p2及以下)+BT);

[[10,"🔴","P0",p0],[11,"🟠","P1",p1],[12,"🟡","P2",p2],[13,"🟢","P3",p3],[14,"🔵","P4",p4]
].forEach(([n,icon,lv,arr]) => {
  L.push("## "+n+". "+icon+" "+lv+"级别技术缺陷数量");
  L.push("**📋 统计逻辑**: 在技术缺陷中筛选'缺陷等级'为"+lv+"的记录");
  L.push("**🔢 数量**: "+arr.length);
  L.push("**📝 "+lv+"级别技术缺陷ID列表**: "+BT+fmtIds(arr)+BT);
});

L.push("## 15. ⚪ 未判断缺陷等级技术缺陷数量");
L.push("**📋 统计逻辑**: 在技术缺陷中筛选'缺陷等级'字段为空的记录");
L.push("**🔢 数量**: "+p未判断.length);
L.push("**📝 未判断等级技术缺陷ID列表**: "+BT+fmtIds(p未判断)+BT);

L.push("## 16. ✅ 技术缺陷等级统计总和验证");
L.push("**📋 统计逻辑**: 验证各等级技术缺陷数量之和是否等于技术缺陷总数");
L.push("**📊 统计总和**: "+等级sum);
L.push("**📈 技术缺陷总数**: "+技术缺陷.length);
L.push(verify(等级sum, 技术缺陷.length, "技术缺陷总数"));

L.push("## 17. ⏰ P2级及以下技术缺陷中简报逾期的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'是否逾期'字段值为'是'的记录");
L.push("**🔢 数量**: "+p2逾期.length);
L.push("**📝 逾期缺陷ID列表**: "+BT+fmtIds(p2逾期)+BT);

L.push("## 18. ✅ P2级及以下技术缺陷中未逾期的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'是否逾期'字段值为'否'的记录");
L.push("**🔢 数量**: "+p2未逾期.length);
L.push("**📝 未逾期缺陷ID列表**: "+BT+fmtIds(p2未逾期)+BT);

L.push("## 19. ❓ P2级及以下技术缺陷中简报是否逾期为空（无法判断）的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'是否逾期'字段为空的记录");
L.push("**🔢 数量**: "+p2逾期空.length);
L.push("**📝 逾期状态为空缺陷ID列表**: "+BT+fmtIds(p2逾期空)+BT);

L.push("## 20. ✅ P2级及以下技术缺陷逾期统计总和验证");
L.push("**📋 统计逻辑**: 验证各逾期状态技术缺陷数量之和是否等于P2级及以下技术缺陷总数");
L.push("**📊 统计总和**: "+逾期sum);
L.push("**📈 P2级及以下技术缺陷总数**: "+p2总);
L.push(verify(逾期sum, p2总, "总数"));

L.push("## 21. ⚡ P2级及以下技术缺陷中及时处理的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'及时处理'字段值为'是'的记录");
L.push("**🔢 数量**: "+p2及时.length);
L.push("**📝 及时处理缺陷ID列表**: "+BT+fmtIds(p2及时)+BT);

L.push("## 22. 🐌 P2级及以下技术缺陷中未及时处理的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'及时处理'字段值为'否'的记录");
L.push("**🔢 数量**: "+p2未及时.length);
L.push("**📝 未及时处理缺陷ID列表**: "+BT+fmtIds(p2未及时)+BT);

L.push("## 23. ❓ P2级及以下技术缺陷中无法判断是否及时处理的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'及时处理'字段为空或值为'无法判断'的记录");
L.push("**🔢 数量**: "+p2及时空.length);
L.push("**📝 无法判断及时处理缺陷ID列表**: "+BT+fmtIds(p2及时空)+BT);

L.push("## 24. ✅ P2级及以下技术缺陷及时处理统计总和验证");
L.push("**📋 统计逻辑**: 验证各及时处理状态技术缺陷数量之和是否等于P2级及以下技术缺陷总数");
L.push("**📊 统计总和**: "+及时sum);
L.push("**📈 P2级及以下技术缺陷总数**: "+p2总);
L.push(verify(及时sum, p2总, "总数"));

L.push("## 25. ✅ P2级及以下技术缺陷中已修复的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'状态'字段值为'closed'或'已关闭'的记录");
L.push("**🔢 数量**: "+p2已修复.length);
L.push("**📝 已修复缺陷ID列表**: "+BT+fmtIds(p2已修复)+BT);

L.push("## 26. ⚡ P2级及以下技术缺陷中及时修复的数量");
L.push("**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选'及时处理'字段值为'是'且'状态'为'已关闭'的记录");
L.push("**🔢 数量**: "+p2及时修复.length);
L.push("**📝 及时修复缺陷ID列表**: "+BT+fmtIds(p2及时修复)+BT);

L.push("## 27. 📈 P2级及以下技术缺陷及时修复率");
L.push("**📋 统计逻辑**: P2级及以下及时修复率 = P2级及以下技术缺陷中及时修复的数量 / P2级及以下技术缺陷的数量");
L.push("**🧮 计算公式**: 及时修复率 = 及时修复数量 / P2级及以下技术缺陷总数");
L.push("**🔍 及时修复定义**: 预计结束时间 >= 解决时间 且 状态为已关闭");
L.push("**🔢 及时修复数量**: "+p2及时修复.length);
L.push("**📊 分母（P2级及以下技术缺陷总数）**: "+p2总);
L.push("**📈 及时修复率**: "+fmtPct(修复率));
L.push("**📊 百分比**: "+fmtPct(修复率));
L.push("**🏅 评级**: "+rating(修复率));
L.push("**ℹ️ 说明**: 基于第26项统计的及时修复数量计算");

L.push("## 27. 📈 P2级及以下技术缺陷及时处理率");
L.push("**📋 统计逻辑**: P2级及以下及时处理率 = P2级及以下技术缺陷中及时处理的数量 / P2级及以下技术缺陷的数量");
L.push("**🧮 计算公式**: 及时处理率 = 及时处理数量 / P2级及以下技术缺陷总数");
L.push("**🔢 及时处理数量**: "+p2及时.length);
L.push("**🔢 未及时处理数量**: "+p2未及时.length);
L.push("**🔢 无法判断数量**: "+p2及时空.length);
L.push("**📊 分母（P2级及以下技术缺陷总数）**: "+p2总);
L.push("**📈 及时处理率**: "+fmtPct(处理率));
L.push("**📊 百分比**: "+fmtPct(处理率));
L.push("**🏅 评级**: "+rating(处理率));
L.push("**ℹ️ 说明**: 有"+p2及时空.length+"条记录无法判断是否及时处理，已计入分母");

L.push("## 28. 🏗️ 技术缺陷中\u201C结构归母\u201D字段统计");
L.push("**📋 统计逻辑**: 统计技术缺陷中'结构归母'字段各值的数量，包括空值");
Object.entries(归母Map).forEach(([key, arr]) => {
  L.push("### 📍 "+key);
  L.push("**🔢 数量**: "+arr.length);
  L.push("**📝 缺陷ID列表**: "+BT+fmtIds(arr)+BT);
});
L.push("### ✅ 统计总和验证");
L.push("**📋 统计逻辑**: 验证'结构归母'字段统计总和是否等于技术缺陷总数");
L.push("**📊 统计总和**: "+归母sum);
L.push("**📈 技术缺陷总数**: "+技术缺陷.length);
L.push(verify(归母sum, 技术缺陷.length, "技术缺陷总数"));

L.push("## 📋 数据字段信息");
L.push("### 📊 可用字段");
L.push(BT+JSON.stringify(fields)+BT);

result = L.join("\\n");`,
          timeoutSeconds: '30',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 700, y: 300 },
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
      edge('n-agg', 'script-out', 'n-export', 'export-in'),
      edge('n-agg', 'script-out', 'n-notify', 'notify-in'),
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
// 模板 3: Smart-HTTP 增强验收（零配置一键跑）
// ═══════════════════════════════════════════════════════════════
//
// 前置：node scripts/mock-paginated-api.js
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🤖 智能 HTTP（cursor 分页 + dataPath + delay + retry）
//     ↓
//   💻 JS 校验（总数/去重/分布/PASS|FAIL）
//     ↓      ↓
//   💾 导出  🔔 通知
//

const smartHttpAcceptanceTemplate: WorkflowTemplate = {
  id: 'smart-http-acceptance',
  name: 'Smart-HTTP 增强验收',
  description: '一键验收：启动 mock → 导入此模板 → 点运行。自动测试 cursor 分页 + 自定义 dataPath + 请求延迟 + 失败重试，校验 50 条数据完整性',
  icon: '🧪',
  tags: ['test', 'smart-http', 'acceptance', 'mock'],
  requiredInputs: [],  // 零表单，直接跑
  build: () => {
    _edgeIdx = 0;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '先确认 mock 已启动: node scripts/mock-paginated-api.js' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 300 },
      },
      // ── cursor 分页 + dataPath + delay + retry 全覆盖 ──
      {
        nodeId: 'n-smart',
        name: '智能 HTTP (cursor + dataPath)',
        nodeType: 'smart-http',
        config: {
          url: 'http://localhost:7799/api/cursor-list?cursor=0&limit=10',
          method: 'GET',
          paginationType: 'cursor',
          dataPath: 'response.result.list',
          cursorField: 'paging.next_cursor',
          cursorParam: 'cursor',
          maxPages: '10',
          requestDelayMs: '100',
          retryCount: '1',
        },
        inputSlots: [{ slotId: 'smart-in', name: 'context', dataType: 'json', required: false }],
        outputSlots: [
          { slotId: 'smart-out', name: 'data', dataType: 'json', required: true },
          { slotId: 'smart-meta', name: 'meta', dataType: 'json', required: false },
        ],
        position: { x: 380, y: 300 },
      },
      // ── JS 校验：总数 50、无重复、字段分布 ──
      {
        nodeId: 'n-verify',
        name: '数据校验',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `var items = Array.isArray(data) ? data : [];
var total = items.length;
var ids = items.map(function(i){ return i.id; });
var seen = {};
var dupes = 0;
ids.forEach(function(id){ if(seen[id]) dupes++; seen[id]=true; });

var statusMap = {};
var priorityMap = {};
items.forEach(function(i){
  statusMap[i.status] = (statusMap[i.status]||0)+1;
  priorityMap[i.priority] = (priorityMap[i.priority]||0)+1;
});

var pass = total === 50 && dupes === 0;
var L = [];
L.push("# Smart-HTTP 增强验收报告");
L.push("");
L.push("## 结论: " + (pass ? "PASS" : "FAIL"));
L.push("");
L.push("## 基础校验");
L.push("| 指标 | 实际 | 期望 | 结果 |");
L.push("|------|------|------|------|");
L.push("| 总条数 | " + total + " | 50 | " + (total===50?"OK":"FAIL") + " |");
L.push("| 重复记录 | " + dupes + " | 0 | " + (dupes===0?"OK":"FAIL") + " |");
L.push("| 首条 ID | " + (ids[0]||"?") + " | item-001 | " + (ids[0]==="item-001"?"OK":"FAIL") + " |");
L.push("| 末条 ID | " + (ids[total-1]||"?") + " | item-050 | " + (ids[total-1]==="item-050"?"OK":"FAIL") + " |");
L.push("");
L.push("## 覆盖特性");
L.push("- cursor 分页: 5 页 x 10 条 = 50 条");
L.push("- dataPath: response.result.list (嵌套 3 层)");
L.push("- requestDelayMs: 100ms (每页间隔)");
L.push("- retryCount: 1 (遇错重试 1 次)");
L.push("");
L.push("## 状态分布");
Object.keys(statusMap).forEach(function(k){ L.push("- "+k+": "+statusMap[k]); });
L.push("");
L.push("## 优先级分布");
Object.keys(priorityMap).forEach(function(k){ L.push("- "+k+": "+priorityMap[k]); });

result = L.join("\\n");`,
          timeoutSeconds: '10',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 700, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出验收报告',
        nodeType: 'file-exporter',
        config: { fileFormat: 'markdown', fileName: 'smart-http-acceptance-{{date}}' },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1050, y: 180 },
      },
      {
        nodeId: 'n-notify',
        name: '验收通知',
        nodeType: 'notification-sender',
        config: { title: 'Smart-HTTP 验收完成', content: '', level: 'info', attachFromInput: 'cos' },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1050, y: 420 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-smart', 'smart-in'),
      edge('n-smart', 'smart-out', 'n-verify', 'script-in'),
      edge('n-verify', 'script-out', 'n-export', 'export-in'),
      edge('n-verify', 'script-out', 'n-notify', 'notify-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板 4: API 数据采集审查（完整表单，正式使用）
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🤖 智能 HTTP（全配置：分页/路径/重试/延迟）
//     ↓
//   💻 JS 数据预处理（统计摘要 + 字段分布）
//     ↓
//   📝 LLM 报告生成（基于分析指令生成可读报告）
//     ↓      ↓
//   💾 导出  🔔 通知
//

const apiReviewWorkflowTemplate: WorkflowTemplate = {
  id: 'api-review-workflow',
  name: 'API 数据采集与审查',
  description: '配置外部 API → 数据预处理 → LLM 分析报告 → 文件导出 + 站内通知。支持 cursor/offset/page 分页、自定义数据路径、失败重试',
  icon: '🔍',
  tags: ['api', 'review', 'smart-http', 'report', 'llm'],
  requiredInputs: [
    {
      key: 'curlCommand',
      label: 'cURL 命令 / 请求 URL',
      type: 'textarea',
      placeholder: "curl 'https://api.example.com/v1/items?page=1&pageSize=20' \\\n  -H 'Authorization: Bearer your-token'",
      helpTip: '粘贴完整 cURL（自动解析 URL/Headers/Body），或直接填 URL',
      required: true,
    },
    {
      key: 'method',
      label: '请求方法',
      type: 'select',
      required: true,
      defaultValue: 'GET',
      options: [
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' },
      ],
    },
    {
      key: 'headers',
      label: '请求头 (JSON)',
      type: 'textarea',
      placeholder: '{"Authorization": "Bearer xxx"}',
      helpTip: 'cURL 中已包含 Headers 可留空',
      required: false,
    },
    {
      key: 'paginationType',
      label: '分页策略',
      type: 'select',
      required: true,
      defaultValue: 'auto',
      options: [
        { value: 'auto', label: 'AI 自动检测（推荐）' },
        { value: 'page', label: 'page/pageSize 页码分页' },
        { value: 'offset', label: 'offset/limit 偏移分页' },
        { value: 'cursor', label: 'cursor 游标分页' },
        { value: 'none', label: '不分页（单次请求）' },
      ],
    },
    {
      key: 'dataPath',
      label: '数据路径（留空自动检测）',
      type: 'text',
      placeholder: 'response.data.list',
      helpTip: '响应 JSON 中数据数组的路径，如 result.list。留空自动检测 data/items/results',
      required: false,
    },
    {
      key: 'cursorField',
      label: '游标字段路径（cursor 分页时填）',
      type: 'text',
      placeholder: 'paging.next_cursor',
      required: false,
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;
    const curlOrUrl = inputs.curlCommand || '';
    const method = inputs.method || 'GET';
    const headers = inputs.headers || '';
    const paginationType = inputs.paginationType || 'auto';
    const dataPath = inputs.dataPath || '';
    const cursorField = inputs.cursorField || '';

    const isCurl = /^\s*curl[\s'"]/.test(curlOrUrl);
    const smartConfig: Record<string, string> = {
      paginationType,
      maxPages: '20',
      requestDelayMs: '200',
      retryCount: '1',
    };
    if (isCurl) {
      smartConfig.curlCommand = curlOrUrl;
    } else {
      smartConfig.url = curlOrUrl;
      smartConfig.method = method;
    }
    if (headers) smartConfig.headers = headers;
    if (dataPath) smartConfig.dataPath = dataPath;
    if (cursorField) smartConfig.cursorField = cursorField;

    const defaultAnalysis = `请对以下数据进行全面分析，输出结构化的审查报告：

1. **数据概览**：总条数、字段列表、数据时间范围
2. **分组统计**：自动识别分类字段，按每个字段分组计数
3. **异常检测**：数据缺失、重复记录、异常值
4. **趋势分析**：如有日期字段，按周/月统计趋势
5. **关键发现与建议**：基于数据给出 3-5 条核心洞察

以 Markdown 格式输出，包含标题、表格和要点列表。`;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击开始采集' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 300 },
      },
      {
        nodeId: 'n-smart',
        name: '智能 HTTP 采集',
        nodeType: 'smart-http',
        config: smartConfig,
        inputSlots: [{ slotId: 'smart-in', name: 'context', dataType: 'json', required: false }],
        outputSlots: [
          { slotId: 'smart-out', name: 'data', dataType: 'json', required: true },
          { slotId: 'smart-meta', name: 'meta', dataType: 'json', required: false },
        ],
        position: { x: 380, y: 300 },
      },
      {
        nodeId: 'n-preprocess',
        name: '数据预处理',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `var items = Array.isArray(data) ? data : (data ? [data] : []);
var total = items.length;
var fieldCounts = {};
items.forEach(function(item) {
  Object.keys(item).forEach(function(k) {
    fieldCounts[k] = (fieldCounts[k] || 0) + (item[k] != null && item[k] !== '' ? 1 : 0);
  });
});
var groupStats = {};
Object.keys(fieldCounts).forEach(function(field) {
  var values = {};
  var uniqueCount = 0;
  items.forEach(function(item) {
    var v = String(item[field] || '(空)');
    if (!values[v]) { values[v] = 0; uniqueCount++; }
    if (uniqueCount <= 30) values[v]++;
  });
  if (uniqueCount > 1 && uniqueCount <= 30) {
    groupStats[field] = values;
  }
});
var emptyRates = {};
Object.keys(fieldCounts).forEach(function(k) {
  var emptyCount = total - fieldCounts[k];
  if (emptyCount > 0) emptyRates[k] = (emptyCount / total * 100).toFixed(1) + '%';
});
result = {
  summary: { totalRecords: total, fieldCount: Object.keys(fieldCounts).length, fields: Object.keys(fieldCounts) },
  groupStats: groupStats,
  dataQuality: { emptyRates: emptyRates },
  rawData: items,
  sampleRecords: items.slice(0, 5)
};`,
          timeoutSeconds: '30',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 680, y: 300 },
      },
      {
        nodeId: 'n-report',
        name: 'LLM 分析报告',
        nodeType: 'report-generator',
        config: { reportTemplate: defaultAnalysis, format: 'markdown' },
        inputSlots: [{ slotId: 'report-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'report-out', name: 'report', dataType: 'text', required: true }],
        position: { x: 980, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出报告',
        nodeType: 'file-exporter',
        config: { fileFormat: 'markdown', fileName: 'api-review-{{date}}' },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1300, y: 180 },
      },
      {
        nodeId: 'n-notify',
        name: '完成通知',
        nodeType: 'notification-sender',
        config: { title: 'API 数据审查报告已生成', content: '', level: 'success', attachFromInput: 'cos' },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1300, y: 420 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-smart', 'smart-in'),
      edge('n-smart', 'smart-out', 'n-preprocess', 'script-in'),
      edge('n-preprocess', 'script-out', 'n-report', 'report-in'),
      edge('n-report', 'report-out', 'n-export', 'export-in'),
      edge('n-report', 'report-out', 'n-notify', 'notify-in'),
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
  smartHttpAcceptanceTemplate,
  apiReviewWorkflowTemplate,
];
