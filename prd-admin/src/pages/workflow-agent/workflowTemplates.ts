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
const ids = (arr) => arr.map(i => i["缺陷ID"] || i.id || "").filter(Boolean);
const allIds = ids(data);

// 可用字段
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
const techByLevel = (lv) => 技术缺陷.filter(i => (i["缺陷等级"] || "").toUpperCase() === lv);
const p0 = techByLevel("P0");
const p1 = techByLevel("P1");
const p2 = techByLevel("P2");
const p3 = techByLevel("P3");
const p4 = techByLevel("P4");
const p未判断 = 技术缺陷.filter(i => !(i["缺陷等级"] || "").trim());
const p2及以下 = 技术缺陷.filter(i => ["P2","P3","P4"].includes((i["缺陷等级"] || "").toUpperCase()));

// P2及以下逾期统计
const p2逾期 = p2及以下.filter(i => i["是否逾期"] === "是");
const p2未逾期 = p2及以下.filter(i => i["是否逾期"] === "否");
const p2逾期空 = p2及以下.filter(i => !(i["是否逾期"] || "").trim());

// P2及以下及时处理统计
const p2及时 = p2及以下.filter(i => i["及时处理"] === "是");
const p2未及时 = p2及以下.filter(i => i["及时处理"] === "否");
const p2及时空 = p2及以下.filter(i => !(i["及时处理"] || "").trim() || i["及时处理"] === "无法判断");

// P2及以下已修复
const p2已修复 = p2及以下.filter(i => ["closed","已关闭"].includes((i["状态"] || "").toLowerCase()));

// 及时修复率 & 及时处理率
const p2总 = p2及以下.length;
const 及时修复率 = p2总 > 0 ? (p2已修复.length / p2总 * 100).toFixed(2) + "%" : "N/A";
const 及时处理率 = p2总 > 0 ? (p2及时.length / p2总 * 100).toFixed(2) + "%" : "N/A";

// 结构归母统计
const 归母Map = {};
技术缺陷.forEach(i => {
  const v = (i["结构归母"] || "").trim() || "暂未归母";
  if (!归母Map[v]) 归母Map[v] = [];
  归母Map[v].push(i["缺陷ID"] || i.id || "");
});

result = {
  可用字段: fields,
  缺陷总数: total, 全部缺陷ID: ids(data),
  非缺陷数量: { count: 非缺陷.length, ids: ids(非缺陷) },
  产品缺陷数量: { count: 产品缺陷.length, ids: ids(产品缺陷) },
  技术缺陷数量: { count: 技术缺陷.length, ids: ids(技术缺陷) },
  无法判断数量: { count: 无法判断.length, ids: ids(无法判断) },
  未判断数量: { count: 未判断.length, ids: ids(未判断) },
  无效反馈数量: { count: 无效反馈.length, ids: ids(无效反馈) },
  有效反馈数量: { count: 有效反馈.length, ids: ids(有效反馈) },
  P2级及以下技术缺陷: { count: p2及以下.length, ids: ids(p2及以下) },
  P0级技术缺陷: { count: p0.length, ids: ids(p0) },
  P1级技术缺陷: { count: p1.length, ids: ids(p1) },
  P2级技术缺陷: { count: p2.length, ids: ids(p2) },
  P3级技术缺陷: { count: p3.length, ids: ids(p3) },
  P4级技术缺陷: { count: p4.length, ids: ids(p4) },
  未判断等级技术缺陷: { count: p未判断.length, ids: ids(p未判断) },
  等级统计验证: { sum: p0.length+p1.length+p2.length+p3.length+p4.length+p未判断.length, total: 技术缺陷.length },
  P2级及以下逾期缺陷: { count: p2逾期.length, ids: ids(p2逾期) },
  P2级及以下未逾期缺陷: { count: p2未逾期.length, ids: ids(p2未逾期) },
  P2级及以下逾期未判断: { count: p2逾期空.length, ids: ids(p2逾期空) },
  逾期统计验证: { sum: p2逾期.length+p2未逾期.length+p2逾期空.length, total: p2总 },
  P2级及以下及时处理: { count: p2及时.length, ids: ids(p2及时) },
  P2级及以下未及时处理: { count: p2未及时.length, ids: ids(p2未及时) },
  P2级及以下及时未判断: { count: p2及时空.length, ids: ids(p2及时空) },
  及时处理统计验证: { sum: p2及时.length+p2未及时.length+p2及时空.length, total: p2总 },
  P2级及以下已修复: { count: p2已修复.length, ids: ids(p2已修复) },
  及时修复率, 及时处理率, P2级及以下总数: p2总,
  结构归母统计: 归母Map,
  归母统计验证: { sum: Object.values(归母Map).reduce((a,b) => a+b.length, 0), total: 技术缺陷.length },
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
          reportTemplate: '你是一个软件质量分析专家。你会收到一份由 JS 脚本预处理后的 TAPD 缺陷统计数据（JSON 格式），包含精确统计结果和缺陷ID列表。\n\n**严格按照以下模板格式输出 Markdown 报告，直接引用 JSON 中的数据，不要自行重新计算，不要遗漏任何章节：**\n\n# 📊 缺陷统计分析报告\n\n**🕐 生成时间**: {{当前时间}}\n**📁 数据文件**: 缺陷统计数据.xlsx\n**📈 数据总行数**: {{缺陷总数}}\n\n## 1. 🏷️ 缺陷总数\n**📋 统计逻辑**: 统计Excel文件中所有行的数量\n**🔢 数量**: {{缺陷总数}}\n**📝 缺陷ID列表**: `{{全部缺陷ID}}`\n\n## 2. ❌ 非缺陷数量\n**📋 统计逻辑**: 筛选\'缺陷划分\'字段值为\'非缺陷\'的记录\n**🔢 数量**: {{非缺陷数量.count}}\n**📝 非缺陷ID列表**: `{{非缺陷数量.ids}}`\n\n## 3. 📱 产品缺陷数量\n**📋 统计逻辑**: 筛选\'缺陷划分\'字段值为\'产品缺陷\'的记录\n**🔢 数量**: {{产品缺陷数量.count}}\n**📝 产品缺陷ID列表**: `{{产品缺陷数量.ids}}`\n\n## 4. 🔧 技术缺陷数量\n**📋 统计逻辑**: 筛选\'缺陷划分\'字段值为\'技术缺陷\'的记录\n**🔢 数量**: {{技术缺陷数量.count}}\n**📝 技术缺陷ID列表**: `{{技术缺陷数量.ids}}`\n\n## 5. ❓ 无法判断的数量\n**📋 统计逻辑**: 筛选\'缺陷划分\'字段值为\'无法判断\'的记录\n**🔢 数量**: {{无法判断数量.count}}\n**📝 无法判断ID列表**: `{{无法判断数量.ids}}`\n\n## 6. ⚪ 未判断（空）的数量\n**📋 统计逻辑**: 筛选\'缺陷划分\'字段值为空的记录\n**🔢 数量**: {{未判断数量.count}}\n**📝 未判断ID列表**: `{{未判断数量.ids}}`\n\n## 7. 🚫 无效反馈数量\n**📋 统计逻辑**: 筛选\'有效报告\'字段值为\'否\'的记录\n**🔢 数量**: {{无效反馈数量.count}}\n**📝 无效反馈ID列表**: `{{无效反馈数量.ids}}`\n\n## 8. ✅ 有效反馈数量\n**📋 统计逻辑**: 筛选\'有效报告\'字段值为\'是\'的记录\n**🔢 数量**: {{有效反馈数量.count}}\n**📝 有效反馈ID列表**: `{{有效反馈数量.ids}}`\n\n## 9. 📉 P2级及以下技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P2、P3、P4的记录\n**🔢 数量**: {{P2级及以下技术缺陷.count}}\n**📝 P2级及以下技术缺陷ID列表**: `{{P2级及以下技术缺陷.ids}}`\n\n## 10. 🔴 P0级别技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P0的记录\n**🔢 数量**: {{P0级技术缺陷.count}}\n**📝 P0级别技术缺陷ID列表**: `{{P0级技术缺陷.ids}}`\n\n## 11. 🟠 P1级别技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P1的记录\n**🔢 数量**: {{P1级技术缺陷.count}}\n**📝 P1级别技术缺陷ID列表**: `{{P1级技术缺陷.ids}}`\n\n## 12. 🟡 P2级别技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P2的记录\n**🔢 数量**: {{P2级技术缺陷.count}}\n**📝 P2级别技术缺陷ID列表**: `{{P2级技术缺陷.ids}}`\n\n## 13. 🟢 P3级别技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P3的记录\n**🔢 数量**: {{P3级技术缺陷.count}}\n**📝 P3级别技术缺陷ID列表**: `{{P3级技术缺陷.ids}}`\n\n## 14. 🔵 P4级别技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'为P4的记录\n**🔢 数量**: {{P4级技术缺陷.count}}\n**📝 P4级别技术缺陷ID列表**: `{{P4级技术缺陷.ids}}`\n\n## 15. ⚪ 未判断缺陷等级技术缺陷数量\n**📋 统计逻辑**: 在技术缺陷中筛选\'缺陷等级\'字段为空的记录\n**🔢 数量**: {{未判断等级技术缺陷.count}}\n**📝 未判断等级技术缺陷ID列表**: `{{未判断等级技术缺陷.ids}}`\n\n## 16. ✅ 技术缺陷等级统计总和验证\n**📋 统计逻辑**: 验证各等级技术缺陷数量之和是否等于技术缺陷总数\n**📊 统计总和**: {{等级统计验证.sum}}\n**📈 技术缺陷总数**: {{等级统计验证.total}}\n（如果 sum === total 输出 **✓ 验证通过**，否则输出 **✗ 验证失败**）\n\n## 17. ⏰ P2级及以下技术缺陷中简报逾期的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'是否逾期\'字段值为\'是\'的记录\n**🔢 数量**: {{P2级及以下逾期缺陷.count}}\n**📝 逾期缺陷ID列表**: `{{P2级及以下逾期缺陷.ids}}`\n\n## 18. ✅ P2级及以下技术缺陷中未逾期的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'是否逾期\'字段值为\'否\'的记录\n**🔢 数量**: {{P2级及以下未逾期缺陷.count}}\n**📝 未逾期缺陷ID列表**: `{{P2级及以下未逾期缺陷.ids}}`\n\n## 19. ❓ P2级及以下技术缺陷中简报是否逾期为空（无法判断）的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'是否逾期\'字段为空的记录\n**🔢 数量**: {{P2级及以下逾期未判断.count}}\n**📝 逾期状态为空缺陷ID列表**: `{{P2级及以下逾期未判断.ids}}`\n\n## 20. ✅ P2级及以下技术缺陷逾期统计总和验证\n**📋 统计逻辑**: 验证各逾期状态技术缺陷数量之和是否等于P2级及以下技术缺陷总数\n**📊 统计总和**: {{逾期统计验证.sum}}\n**📈 P2级及以下技术缺陷总数**: {{逾期统计验证.total}}\n（验证通过/失败）\n\n## 21. ⚡ P2级及以下技术缺陷中及时处理的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'及时处理\'字段值为\'是\'的记录\n**🔢 数量**: {{P2级及以下及时处理.count}}\n**📝 及时处理缺陷ID列表**: `{{P2级及以下及时处理.ids}}`\n\n## 22. 🐌 P2级及以下技术缺陷中未及时处理的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'及时处理\'字段值为\'否\'的记录\n**🔢 数量**: {{P2级及以下未及时处理.count}}\n**📝 未及时处理缺陷ID列表**: `{{P2级及以下未及时处理.ids}}`\n\n## 23. ❓ P2级及以下技术缺陷中无法判断是否及时处理的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'及时处理\'字段为空或值为\'无法判断\'的记录\n**🔢 数量**: {{P2级及以下及时未判断.count}}\n**📝 无法判断及时处理缺陷ID列表**: `{{P2级及以下及时未判断.ids}}`\n\n## 24. ✅ P2级及以下技术缺陷及时处理统计总和验证\n**📋 统计逻辑**: 验证各及时处理状态技术缺陷数量之和是否等于P2级及以下技术缺陷总数\n**📊 统计总和**: {{及时处理统计验证.sum}}\n**📈 P2级及以下技术缺陷总数**: {{及时处理统计验证.total}}\n（验证通过/失败）\n\n## 25. ✅ P2级及以下技术缺陷中已修复的数量\n**📋 统计逻辑**: 在P2级及以下技术缺陷中筛选\'状态\'字段值为\'closed\'或\'已关闭\'的记录\n**🔢 数量**: {{P2级及以下已修复.count}}\n**📝 已修复缺陷ID列表**: `{{P2级及以下已修复.ids}}`\n\n## 26. 📈 P2级及以下技术缺陷及时修复率\n**📋 统计逻辑**: P2级及以下及时修复率 = P2级及以下技术缺陷中已修复的数量 / P2级及以下技术缺陷总数\n**🧮 计算公式**: 及时修复率 = 已修复数量 / P2级及以下技术缺陷总数\n**🔢 及时修复数量（已关闭）**: {{P2级及以下已修复.count}}\n**📊 分母（P2级及以下技术缺陷总数）**: {{P2级及以下总数}}\n**📈 及时修复率**: {{及时修复率}}\n（根据比例给出评级：>=90% 优秀🏆, >=80% 良好🟢, >=60% 一般📊, <60% 较差🔴）\n\n## 27. 📈 P2级及以下技术缺陷及时处理率\n**📋 统计逻辑**: P2级及以下及时处理率 = P2级及以下技术缺陷中及时处理的数量 / P2级及以下技术缺陷总数\n**🧮 计算公式**: 及时处理率 = 及时处理数量 / P2级及以下技术缺陷总数\n**🔢 及时处理数量**: {{P2级及以下及时处理.count}}\n**🔢 未及时处理数量**: {{P2级及以下未及时处理.count}}\n**🔢 无法判断数量**: {{P2级及以下及时未判断.count}}\n**📊 分母（P2级及以下技术缺陷总数）**: {{P2级及以下总数}}\n**📈 及时处理率**: {{及时处理率}}\n（根据比例给出评级，并说明无法判断记录已计入分母）\n\n## 28. 🏗️ 技术缺陷中"结构归母"字段统计\n**📋 统计逻辑**: 统计技术缺陷中\'结构归母\'字段各值的数量，包括空值\n（遍历 结构归母统计 对象，每个 key 输出一个子章节 ### 📍 {key}，包含数量和ID列表）\n\n### ✅ 统计总和验证\n**📊 统计总和**: {{归母统计验证.sum}}\n**📈 技术缺陷总数**: {{归母统计验证.total}}\n（验证通过/失败）\n\n## 📋 数据字段信息\n### 📊 可用字段\n`{{可用字段}}`\n\n---\n注意：报告中所有数字和ID列表必须直接从输入 JSON 中提取，不要自行计算或编造。验证章节根据 sum 与 total 是否相等输出通过或失败。',
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
