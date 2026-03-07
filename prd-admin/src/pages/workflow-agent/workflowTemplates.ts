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
//   📊 数据预处理（JS 精确统计 → Markdown 报告）
//     ↓
//   🌐 网页报告生成（LLM → 精美 HTML）
//     ↓      ↓
//   💾 导出  🔔 通知
//

const tapdBugCollectionTemplate: WorkflowTemplate = {
  id: 'tapd-bug-collection',
  name: 'TAPD 缺陷采集与分析',
  description: '从 TAPD 拉取缺陷数据 → JS 精确统计生成 Markdown → LLM 生成精美 HTML 网页 → 文件导出 + 站内通知',
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
    {
      key: 'style',
      label: '网页风格',
      type: 'select',
      required: false,
      defaultValue: 'modern-dark',
      options: [
        { value: 'modern-dark', label: '现代深色 (Glassmorphism)' },
        { value: 'modern-light', label: '现代浅色 (Clean Light)' },
        { value: 'dashboard', label: '数据看板 (Dashboard)' },
        { value: 'report', label: '正式报告 (Professional)' },
      ],
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
        nodeId: 'n-webpage',
        name: '生成精美网页报告',
        nodeType: 'webpage-generator',
        config: {
          reportTemplate: `请将以下 Markdown 格式的缺陷统计报告转换为一份精美的 HTML 网页。

要求：
1. 顶部显示报告标题、生成时间、关键指标摘要卡片（总缺陷数、技术缺陷数、及时修复率等）
2. 中部用图表展示：缺陷分类饼图、等级分布柱状图、P2及以下缺陷处理分析
3. 结构归母分布用水平条形图展示
4. 底部用表格展示详细数据和结论建议
5. 整体风格要有科技感和数据分析报告的专业感
6. 保留原始 Markdown 中的所有数据和验证结果，确保数据准确性`,
          style: inputs.style || 'modern-dark',
          title: 'TAPD 缺陷质量分析报告',
          includeCharts: 'true',
        },
        inputSlots: [{ slotId: 'webpage-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'webpage-out', name: 'webpage', dataType: 'text', required: true }],
        position: { x: 1000, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出 HTML 网页',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'html',
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
          title: 'TAPD 缺陷质量网页报告已生成',
          content: '已完成缺陷数据采集与精美网页报告生成，请查看执行结果预览或下载 HTML 文件',
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
      edge('n-agg', 'script-out', 'n-webpage', 'webpage-in'),
      edge('n-webpage', 'webpage-out', 'n-export', 'export-in'),
      edge('n-webpage', 'webpage-out', 'n-notify', 'notify-in'),
    ];

    const variables: WorkflowVariable[] = [];

    return { nodes, edges, variables };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板 3: 通用 API 数据采集 (通过 cURL 粘贴)
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
