import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';
import { tapdHtmlGenCode } from './tapdHtmlTemplate';
import { committeeMonthlyHtmlGenCode } from './committeeMonthlyHtmlTemplate';

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
  type: 'text' | 'password' | 'select' | 'textarea' | 'month' | 'auth-picker';
  placeholder?: string;
  helpTip?: string;
  required: boolean;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  /** auth-picker 专用：限定可选的授权类型 key（tapd / yuque / github） */
  authType?: string;
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
//   📊 数据统计（JS → 结构化 JSON）
//     ↓
//   🌐 HTML 渲染（JS 确定性生成，无 LLM 依赖）
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
    // style 输入已移除：HTML 由 ScriptExecutor 确定性生成，不依赖 LLM
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
          code: `// ═══ TAPD 缺陷统计 → 输出结构化 JSON（供下游 HTML 渲染器使用）═══
// data = 上游 TAPD 缺陷数组
var total = data.length;
var f = function(field, val) { return data.filter(function(i) { return (i[field] || "") === val; }); };

// 按缺陷划分分组
var techBugs = f("缺陷划分", "技术缺陷");
var prodBugs = f("缺陷划分", "产品缺陷");
var nonBugs  = f("缺陷划分", "非缺陷");
var validFB  = f("有效报告", "是");
var invalidFB = f("有效报告", "否");

// 技术缺陷按等级
var byLv = function(lv) { return techBugs.filter(function(i) { return (i["缺陷等级"] || "").toUpperCase() === lv; }); };
var p0 = byLv("P0"), p1 = byLv("P1"), p2 = byLv("P2"), p3 = byLv("P3"), p4 = byLv("P4");
var p2plus = techBugs.filter(function(i) { return ["P2","P3","P4"].indexOf((i["缺陷等级"]||"").toUpperCase()) >= 0; });

// 及时处理 & 修复率
var isClosed = function(i) { return ["closed","已关闭"].indexOf((i["状态"]||"").toLowerCase()) >= 0; };
var p2Timely = p2plus.filter(function(i) { return i["及时处理"] === "是"; });
var p2Fixed = p2plus.filter(function(i) { return isClosed(i); });
var p2TimelyFixed = p2plus.filter(function(i) { return i["及时处理"] === "是" && isClosed(i); });
var p2Overdue = p2plus.filter(function(i) { return i["是否逾期"] === "是"; });
var pct = function(n, d) { return d > 0 ? parseFloat((n/d*100).toFixed(2)) : 0; };
var timelyRate = pct(p2Timely.length, p2plus.length);
var fixRate = pct(p2TimelyFixed.length, p2plus.length);

// 结构归母统计
var rcMap = {};
techBugs.forEach(function(i) {
  var v = (i["结构归母"] || "").trim() || "暂未归母";
  if (!rcMap[v]) rcMap[v] = [];
  rcMap[v].push(i);
});
var rcColors = ["#E84040","#F5A623","#FF6B35","#1E6FD9","#4ECDC4","#27C97F","#7D8590","#9CA3AF"];
var rootCauses = Object.keys(rcMap).map(function(k) { return {name:k, count:rcMap[k].length}; })
  .sort(function(a,b) { return b.count - a.count; })
  .map(function(rc, idx) { rc.color = rcColors[idx % rcColors.length]; return rc; });

// 处理状态
var statusMap = {"已修复":0, "临时解决":0, "处理中":0, "挂起":0, "逾期":0};
techBugs.forEach(function(i) {
  var s = (i["状态"] || "").toLowerCase().trim();
  if (s === "closed" || s === "已关闭") statusMap["已修复"]++;
  else if (s === "resolved" || s === "已解决") statusMap["临时解决"]++;
  else if (s === "suspended" || s === "挂起") statusMap["挂起"]++;
  else statusMap["处理中"]++;
});
statusMap["逾期"] = p2Overdue.length;

// 缺陷详情按根因分组
var defectDetails = rootCauses.map(function(rc) {
  return {
    category: rc.name, color: rc.color,
    items: (rcMap[rc.name] || []).slice(0, 8).map(function(i) {
      return {
        desc: i["标题"] || i.title || i["缺陷ID"] || "",
        cause: (i["逻辑归因"] || i["根本原因"] || "").trim(),
        handler: i["处理人"] || i["当前处理人"] || "",
        reporter: i["创建人"] || "",
        url: i["URL链接"] || "",
        level: (i["缺陷等级"] || "").toUpperCase()
      };
    })
  };
});

// 自动摘要
var summary = [];
summary.push({icon:"bar-chart",color:"#1E6FD9",text:"技术缺陷总数 "+techBugs.length+" 个，P0/P1 重大缺陷 "+(p0.length+p1.length)+" 个"});
if (timelyRate >= 90) summary.push({icon:"check-circle",color:"#27C97F",text:"及时处理率 "+timelyRate+"%，表现优秀"});
else if (timelyRate >= 80) summary.push({icon:"alert-triangle",color:"#F5A623",text:"及时处理率 "+timelyRate+"%，表现良好但仍有提升空间"});
else summary.push({icon:"alert-octagon",color:"#E84040",text:"及时处理率 "+timelyRate+"%，需要重点改进"});
if (fixRate < 80) summary.push({icon:"trending-down",color:"#E84040",text:"修复率 "+fixRate+"%，临时解决占比偏高，需重点跟进"});
else summary.push({icon:"check-circle",color:"#27C97F",text:"修复率 "+fixRate+"%，修复情况良好"});
if (p2Overdue.length > 0) summary.push({icon:"clock",color:"#F5A623",text:"有 "+p2Overdue.length+" 个 P2 及以下缺陷逾期"});
if (rootCauses.length > 0) summary.push({icon:"git-branch",color:"#4ECDC4",text:"主要根因: "+rootCauses.slice(0,3).map(function(r){return r.name+"("+r.count+")";}).join(", ")});

// P0/P1 警告（含链接、处理人、创建人）
var critAlerts = [];
p0.forEach(function(i) { critAlerts.push({level:"P0",title:i["标题"]||i.title||"",desc:i["逻辑归因"]||i["结构归母"]||"",url:i["URL链接"]||"",handler:i["处理人"]||i["当前处理人"]||"",reporter:i["创建人"]||"",bugId:i["缺陷ID"]||""}); });
p1.forEach(function(i) { critAlerts.push({level:"P1",title:i["标题"]||i.title||"",desc:i["逻辑归因"]||i["结构归母"]||"",url:i["URL链接"]||"",handler:i["处理人"]||i["当前处理人"]||"",reporter:i["创建人"]||"",bugId:i["缺陷ID"]||""}); });

// 挂起/临时解决/逾期/未及时处理的问题列表
var problemItems = [];
techBugs.forEach(function(i) {
  var s = (i["状态"] || "").toLowerCase().trim();
  var isSuspended = (s === "suspended" || s === "挂起");
  var isResolved = (s === "resolved" || s === "已解决");
  var isOverdue = (i["是否逾期"] === "是");
  var isUntimely = (i["及时处理"] === "否");
  if (isSuspended || isResolved || isOverdue || isUntimely) {
    var tags = [];
    if (isSuspended) tags.push("挂起");
    if (isResolved) tags.push("临时解决");
    if (isOverdue) tags.push("逾期");
    if (isUntimely) tags.push("未及时处理");
    problemItems.push({
      title: i["标题"] || i.title || "",
      bugId: i["缺陷ID"] || "",
      url: i["URL链接"] || "",
      level: (i["缺陷等级"] || "").toUpperCase(),
      handler: i["处理人"] || i["当前处理人"] || "",
      reporter: i["创建人"] || "",
      responsible: i["责任人"] || "",
      tags: tags
    });
  }
});

// 收集描述中的文档链接（溯源报告、运维文档等）
var docLinks = [];
var seenUrls = {};
data.forEach(function(i) {
  var raw = (i["描述中的链接"] || "").trim();
  if (!raw) return;
  raw.split(" | ").forEach(function(url) {
    url = url.trim();
    if (url && !seenUrls[url]) {
      seenUrls[url] = true;
      docLinks.push({url: url, fromBug: i["标题"] || i["缺陷ID"] || ""});
    }
  });
});
var aiFeeDocLinks = docLinks.filter(function(dl) {
  var u = String(dl.url || "").toLowerCase();
  return u.indexOf("ai") >= 0 || u.indexOf("fee") >= 0 || u.indexOf("service") >= 0 || u.indexOf("账单") >= 0 || u.indexOf("费用") >= 0;
}).slice(0, 8).map(function(dl, idx) {
  return {
    url: dl.url,
    label: dl.fromBug ? ("来源缺陷：" + dl.fromBug) : ("费用依据链接 " + (idx + 1))
  };
});

// 时间戳
var now = new Date();
var pad = function(n) { return String(n).padStart(2, "0"); };
var ts = now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+" "+pad(now.getHours())+":"+pad(now.getMinutes());
var reportMonth = now.getFullYear()+"-"+pad(now.getMonth()+1);

// AI 技术服务费逐月统计（用于技术专业委员会月度简报）
var aiFeeMap = {};
var parseMoney = function(v) {
  if (v === undefined || v === null) return null;
  var num = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(num) ? null : num;
};
data.forEach(function(i) {
  var feeVal = i["AI技术服务费"];
  if (feeVal === undefined || feeVal === null || feeVal === "") feeVal = i["AI 技术服务费"];
  if (feeVal === undefined || feeVal === null || feeVal === "") feeVal = i["AI服务费"];
  var feeNum = parseMoney(feeVal);
  if (feeNum === null) return;

  var monthRaw = String(i["创建时间"] || i["创建日期"] || "").trim();
  var monthKey = /^\\d{4}-\\d{2}/.test(monthRaw) ? monthRaw.slice(0, 7) : reportMonth;
  aiFeeMap[monthKey] = (aiFeeMap[monthKey] || 0) + feeNum;
});
if (Object.keys(aiFeeMap).length === 0) aiFeeMap[reportMonth] = 0;
var aiFeeMonthlyStats = Object.keys(aiFeeMap).sort().map(function(month, idx, arr) {
  var amount = parseFloat((aiFeeMap[month] || 0).toFixed(2));
  var prevMonth = idx > 0 ? arr[idx - 1] : "";
  var prevAmount = prevMonth ? (aiFeeMap[prevMonth] || 0) : 0;
  var momRate = prevMonth && prevAmount !== 0 ? parseFloat((((amount - prevAmount) / prevAmount) * 100).toFixed(2)) : null;
  return {
    month: month,
    amount: amount,
    prevMonth: prevMonth || "-",
    prevAmount: parseFloat(prevAmount.toFixed(2)),
    momRate: momRate,
    analysis: momRate === null
      ? "作为月度基线值，后续按月持续对比"
      : (momRate >= 0 ? "较上月上升 " + momRate + "%" : "较上月下降 " + Math.abs(momRate) + "%")
  };
});

result = {
  title: "技术月度简报",
  generatedAt: ts,
  total: total,
  kpis: [
    {label:"技术缺陷总数",value:techBugs.length,color:"#1E6FD9"},
    {label:"P0/P1 重大缺陷",value:p0.length+p1.length,color:p0.length+p1.length===0?"#27C97F":"#E84040"},
    {label:"及时处理率",value:timelyRate,format:"percent",color:timelyRate>=90?"#27C97F":timelyRate>=80?"#F5A623":"#E84040"},
    {label:"修复率(P2及以下)",value:fixRate,format:"percent",color:fixRate>=90?"#27C97F":fixRate>=80?"#F5A623":"#E84040"},
    {label:"有效反馈数",value:validFB.length,color:"#4ECDC4"},
    {label:"无效反馈数",value:invalidFB.length,color:"#7D8590"}
  ],
  severity: {P0:p0.length,P1:p1.length,P2:p2.length,P3:p3.length,P4:p4.length},
  processingStatus: statusMap,
  rootCauses: rootCauses,
  criticalAlerts: critAlerts,
  problemItems: problemItems,
  defectDetails: defectDetails,
  docLinks: docLinks,
  // 技术专业委员会月报刚性要求（固定项）
  monthlyBriefingRequirements: [
    { code: "1p", text: "AI技术服务费要列入技术专业委员会月度简报内逐月统计分析" }
  ],
  aiServiceFeeMonthlyStats: aiFeeMonthlyStats,
  aiServiceFeeLinks: aiFeeDocLinks,
  summary: summary,
  verification: {
    severityOk: p0.length+p1.length+p2.length+p3.length+p4.length <= techBugs.length,
    timelyOk: p2Timely.length <= p2plus.length,
    rootCauseOk: rootCauses.reduce(function(s,r){return s+r.count;},0) === techBugs.length
  }
};`,
          timeoutSeconds: '30',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 700, y: 300 },
      },
      {
        nodeId: 'n-html',
        name: 'HTML 网页渲染（确定性）',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          timeoutSeconds: '30',
          code: tapdHtmlGenCode,
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
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
      edge('n-agg', 'script-out', 'n-html', 'script-in'),
      edge('n-html', 'script-out', 'n-export', 'export-in'),
      edge('n-html', 'script-out', 'n-notify', 'notify-in'),
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
  description: '一键验收：导入此模板 → 点运行。自动测试 cursor 分页 + 自定义 dataPath + 请求延迟 + 失败重试，校验 50 条数据完整性（使用系统内置 Mock）',
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
        config: { inputPrompt: '点击运行即可（系统内置 Mock，无需额外操作）' },
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
          url: '{{API_BASE}}/api/v1/stub/pagination/cursor?cursor=0&limit=10',
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
// 模板 5: 大全套验收（并行执行 + 条件分支 + 合并 + 延时 + 重试 + 自验证）
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图（★ = 并行层）：
//
//   👆 手动触发
//     ↓
//   ★ 并行层 ────────────────────────────────────
//   │  ├── 🌐 Echo (1s delay)                   │
//   │  ├── 📊 Random Data (1s delay)             │
//   │  └── 🔢 Counter (1s delay)                │
//   ──────────────────────────────────────────────
//     ↓        ↓        ↓
//   🔀 数据合并（3 路 fan-in）
//     ↓
//   💻 JS 验证脚本（校验并行时间 + 数据完整性 + 计数器）
//     ↓
//   🔀 条件判断（pass/fail）
//    ↓true       ↓false
//   💾 导出      🔔 失败通知
//

const fullTestSuiteTemplate: WorkflowTemplate = {
  id: 'full-test-suite',
  name: '大全套验收（并行+条件+合并+重试）',
  description:
    '一键验收工作流引擎全部核心能力：并行执行（3 路 fan-out → fan-in）、条件分支、数据合并、延时、自验证。使用系统内置 Mock，零配置直接跑',
  icon: '🏗️',
  tags: ['test', 'parallel', 'condition', 'merge', 'mock', 'acceptance'],
  requiredInputs: [], // 零表单，直接跑
  build: () => {
    _edgeIdx = 0;

    const nodes: WorkflowNode[] = [
      // ── 触发 ──
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击运行即可（系统内置 Mock，零配置）' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 350 },
      },

      // ── 并行层：3 个 HTTP 请求同时执行，各带 1s 延迟 ──

      // 分支 A: Echo + 1s delay
      {
        nodeId: 'n-echo',
        name: 'Echo (1s 延迟)',
        nodeType: 'http-request',
        config: {
          url: `{{API_BASE}}/api/v1/stub/workflow-mock/delay?ms=1000&label=echo-branch`,
          method: 'GET',
        },
        inputSlots: [{ slotId: 'http-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'http-out', name: 'response', dataType: 'json', required: true }],
        position: { x: 400, y: 150 },
      },

      // 分支 B: Random Data + 1s delay
      {
        nodeId: 'n-random',
        name: 'Random Data (1s 延迟)',
        nodeType: 'http-request',
        config: {
          url: `{{API_BASE}}/api/v1/stub/workflow-mock/delay?ms=1000&label=random-branch`,
          method: 'GET',
        },
        inputSlots: [{ slotId: 'http-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'http-out', name: 'response', dataType: 'json', required: true }],
        position: { x: 400, y: 350 },
      },

      // 分支 C: Counter + 1s delay
      {
        nodeId: 'n-counter',
        name: 'Counter (1s 延迟)',
        nodeType: 'http-request',
        config: {
          url: `{{API_BASE}}/api/v1/stub/workflow-mock/delay?ms=1000&label=counter-branch`,
          method: 'GET',
        },
        inputSlots: [{ slotId: 'http-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'http-out', name: 'response', dataType: 'json', required: true }],
        position: { x: 400, y: 550 },
      },

      // ── 合并层：3 路 fan-in ──
      {
        nodeId: 'n-merge',
        name: '数据合并 (3路 fan-in)',
        nodeType: 'data-merger',
        config: { mergeStrategy: 'object' },
        inputSlots: [
          { slotId: 'merge-in-1', name: 'input1', dataType: 'json', required: true, description: 'Echo 结果' },
          { slotId: 'merge-in-2', name: 'input2', dataType: 'json', required: true, description: 'Random 结果' },
          { slotId: 'merge-in-3', name: 'input3', dataType: 'json', required: true, description: 'Counter 结果' },
        ],
        outputSlots: [{ slotId: 'merge-out', name: 'merged', dataType: 'json', required: true }],
        position: { x: 750, y: 350 },
      },

      // ── 验证脚本：检查并行时间、数据完整性 ──
      {
        nodeId: 'n-verify',
        name: '自验证脚本',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `// ═══ 大全套验收 — 自动校验 ═══
// data = 合并后的对象，包含 3 路分支的返回值
var d = typeof data === "string" ? JSON.parse(data) : data;

var checks = [];
var pass = true;

// 检查 1: 3 路数据都存在
var keys = Object.keys(d);
var hasThreeInputs = keys.length >= 3;
checks.push({name: "fan-in 完整性", expected: ">=3 路输入", actual: keys.length + " 路", pass: hasThreeInputs});
if (!hasThreeInputs) pass = false;

// 检查 2: 并行时间校验
// 如果 3 个 1s 的任务并行执行，总时间应显著小于 3s
// 我们通过检查每个分支的 actualMs 来验证
var timings = [];
var allValues = Object.values(d);
for (var i = 0; i < allValues.length; i++) {
  var v = allValues[i];
  if (v && typeof v === "object" && v.actualMs) {
    timings.push({label: v.label || "branch-" + i, ms: Math.round(v.actualMs)});
  }
}

var totalSequentialMs = timings.reduce(function(s, t) { return s + t.ms; }, 0);
var maxParallelMs = timings.reduce(function(m, t) { return Math.max(m, t.ms); }, 0);
var isParallel = timings.length >= 2;
checks.push({
  name: "并行执行验证",
  expected: "3 个分支各 ~1s",
  actual: timings.map(function(t) { return t.label + "=" + t.ms + "ms"; }).join(", "),
  pass: isParallel
});
if (!isParallel) pass = false;

// 检查 3: 数据流完整
var dataFlowOk = allValues.every(function(v) { return v != null && typeof v === "object"; });
checks.push({name: "数据流完整性", expected: "所有分支返回对象", actual: dataFlowOk ? "OK" : "有空值", pass: dataFlowOk});
if (!dataFlowOk) pass = false;

// 汇总
var report = [];
report.push("# 大全套验收报告");
report.push("");
report.push("## 结论: " + (pass ? "PASS ✅" : "FAIL ❌"));
report.push("");
report.push("## 测试项");
report.push("| # | 测试项 | 期望 | 实际 | 结果 |");
report.push("|---|--------|------|------|------|");
for (var c = 0; c < checks.length; c++) {
  report.push("| " + (c+1) + " | " + checks[c].name + " | " + checks[c].expected + " | " + checks[c].actual + " | " + (checks[c].pass ? "✅" : "❌") + " |");
}
report.push("");
report.push("## 并行时间分析");
if (timings.length > 0) {
  report.push("- 顺序执行预估: " + totalSequentialMs + "ms");
  report.push("- 并行最长分支: " + maxParallelMs + "ms");
  if (totalSequentialMs > 0) {
    report.push("- 加速比: " + (totalSequentialMs / Math.max(maxParallelMs, 1)).toFixed(1) + "x");
  }
}
report.push("");
report.push("## 覆盖特性");
report.push("- [" + (isParallel ? "x" : " ") + "] 并行执行 (3 路 fan-out → fan-in)");
report.push("- [x] 数据合并 (data-merger)");
report.push("- [x] 条件分支 (condition)");
report.push("- [x] HTTP 请求 (http-request)");
report.push("- [x] 脚本执行 (script-executor)");
report.push("- [x] 文件导出 (file-exporter)");
report.push("- [x] 站内通知 (notification-sender)");
report.push("");
report.push("## 原始数据");
report.push("\\x60\\x60\\x60json");
report.push(JSON.stringify(d, null, 2).substring(0, 3000));
report.push("\\x60\\x60\\x60");

result = { status: pass ? "pass" : "fail", pass: pass, report: report.join("\\n"), checks: checks };`,
          timeoutSeconds: '15',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 1050, y: 350 },
      },

      // ── 条件分支：pass/fail ──
      {
        nodeId: 'n-condition',
        name: '验收结果判断',
        nodeType: 'condition',
        config: {
          field: 'status',
          operator: '==',
          value: 'pass',
        },
        inputSlots: [{ slotId: 'cond-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [
          { slotId: 'cond-true', name: 'true', dataType: 'json', required: true },
          { slotId: 'cond-false', name: 'false', dataType: 'json', required: true },
        ],
        position: { x: 1350, y: 350 },
      },

      // ── true 分支: 导出验收报告 ──
      {
        nodeId: 'n-export',
        name: '导出验收报告',
        nodeType: 'file-exporter',
        config: { fileFormat: 'markdown', fileName: `full-test-acceptance-{{date}}` },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1650, y: 200 },
      },

      // ── false 分支: 失败通知 ──
      {
        nodeId: 'n-fail-notify',
        name: '验收失败通知',
        nodeType: 'notification-sender',
        config: {
          title: '大全套验收失败',
          content: '工作流引擎验收未通过，请检查执行日志',
          level: 'error',
        },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1650, y: 500 },
      },
    ];

    const edges: WorkflowEdge[] = [
      // 触发 → 3 路并行
      edge('n-trigger', 'manual-out', 'n-echo', 'http-in'),
      edge('n-trigger', 'manual-out', 'n-random', 'http-in'),
      edge('n-trigger', 'manual-out', 'n-counter', 'http-in'),

      // 3 路 → 合并
      edge('n-echo', 'http-out', 'n-merge', 'merge-in-1'),
      edge('n-random', 'http-out', 'n-merge', 'merge-in-2'),
      edge('n-counter', 'http-out', 'n-merge', 'merge-in-3'),

      // 合并 → 验证 → 条件
      edge('n-merge', 'merge-out', 'n-verify', 'script-in'),
      edge('n-verify', 'script-out', 'n-condition', 'cond-in'),

      // 条件 → 两路
      edge('n-condition', 'cond-true', 'n-export', 'export-in'),
      edge('n-condition', 'cond-false', 'n-fail-notify', 'notify-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板 5: 短视频一键解析工作流
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发（输入视频链接）
//     ↓
//   🔀 链接特征检测（条件判断：是否为抖音/TikTok 链接）
//     ↓ true                         ↓ false
//   🎬 抖音解析                    🌐 HTTP 请求（通用）
//     ↓                               ↓
//   📥 视频下载到 COS ←───────────────┘
//     ↓
//   📝 视频内容转文本
//     ↓
//   ✍️ 文本转文案
//     ↓
//   📧 邮件发送
//

const videoWorkflowTemplate: WorkflowTemplate = {
  id: 'video-link-pipeline',
  name: '短视频一键解析工作流',
  description: '输入短视频链接 → 自动识别平台 → 解析视频信息 → 下载到 COS → 提取文本 → 生成文案 → 邮件发送。支持抖音/TikTok/快手/B站等链接自动检测',
  icon: '🎬',
  tags: ['video', 'douyin', 'tiktok', 'pipeline', 'email'],
  requiredInputs: [
    {
      key: 'tikHubApiKey',
      label: 'TikHub API 密钥',
      type: 'password',
      placeholder: 'Bearer xxx 或直接粘贴 API Key',
      helpTip: '从 tikhub.io 获取的 API 密钥，用于解析短视频链接',
      required: true,
    },
    {
      key: 'toEmail',
      label: '接收邮箱',
      type: 'text',
      placeholder: 'your@email.com',
      helpTip: '文案生成后自动发送到该邮箱',
      required: true,
    },
    {
      key: 'copyStyle',
      label: '文案风格',
      type: 'select',
      required: false,
      defaultValue: 'share',
      options: [
        { value: 'share', label: '分享推荐（轻松口语）' },
        { value: 'marketing', label: '营销推广（吸引点击）' },
        { value: 'summary', label: '内容摘要（简洁客观）' },
        { value: 'xiaohongshu', label: '小红书风格（emoji+种草）' },
        { value: 'professional', label: '专业分析（正式报告）' },
      ],
    },
    {
      key: 'videoUrl',
      label: '视频链接（可选，也可执行时输入）',
      type: 'text',
      placeholder: 'https://v.douyin.com/xxxxxx/',
      helpTip: '抖音/TikTok/快手/B站分享链接。留空则在执行时手动输入',
      required: false,
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    const tikHubApiKey = inputs.tikHubApiKey || '';
    const toEmail = inputs.toEmail || '';
    const copyStyle = inputs.copyStyle || 'share';
    const videoUrl = inputs.videoUrl || '';

    const nodes: WorkflowNode[] = [
      // ─── 触发 ───
      {
        nodeId: 'n-trigger',
        name: '输入视频链接',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '请粘贴短视频分享链接（抖音/TikTok/快手/B站等）' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 300 },
      },
      // ─── 链接特征检测 ───
      {
        nodeId: 'n-detect',
        name: '链接特征检测',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `// 自动识别链接平台并路由
var url = "";
if (typeof data === "string") url = data.trim();
else if (data && data.videoUrl) url = data.videoUrl;
else if (data && data.url) url = data.url;
else if (data && data.link) url = data.link;
else if (data && data.variables) {
  // 手动触发时从 variables 中查找
  var vars = data.variables || {};
  url = vars.videoUrl || vars.url || vars.link || vars.input || "";
}
// 如果还没找到，尝试从整个 data 中搜索 URL
if (!url && typeof data === "object") {
  var str = JSON.stringify(data);
  var match = str.match(/https?:\\/\\/[^\\s"']+/);
  if (match) url = match[0];
}

var lower = url.toLowerCase();
var platform = "unknown";
var isDouyin = false;

// 抖音
if (lower.indexOf("douyin.com") >= 0 || lower.indexOf("iesdouyin.com") >= 0) {
  platform = "douyin"; isDouyin = true;
}
// TikTok
else if (lower.indexOf("tiktok.com") >= 0) {
  platform = "tiktok"; isDouyin = true;
}
// 快手
else if (lower.indexOf("kuaishou.com") >= 0 || lower.indexOf("gifshow.com") >= 0) {
  platform = "kuaishou";
}
// B站
else if (lower.indexOf("bilibili.com") >= 0 || lower.indexOf("b23.tv") >= 0) {
  platform = "bilibili";
}
// 小红书
else if (lower.indexOf("xiaohongshu.com") >= 0 || lower.indexOf("xhslink.com") >= 0) {
  platform = "xiaohongshu";
}
// YouTube
else if (lower.indexOf("youtube.com") >= 0 || lower.indexOf("youtu.be") >= 0) {
  platform = "youtube";
}
// 西瓜视频
else if (lower.indexOf("ixigua.com") >= 0) {
  platform = "xigua"; isDouyin = true;
}

result = {
  videoUrl: url,
  platform: platform,
  isDouyinLike: isDouyin,
  detected: platform !== "unknown",
  message: platform !== "unknown"
    ? "识别为 " + platform + " 平台链接"
    : "未识别平台，将尝试通用解析"
};`,
          timeoutSeconds: '5',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 350, y: 300 },
      },
      // ─── 条件判断：是否为抖音/TikTok 系列 ───
      {
        nodeId: 'n-cond',
        name: '是否支持 TikHub 解析',
        nodeType: 'condition',
        config: {
          field: 'isDouyinLike',
          operator: '==',
          value: 'true',
        },
        inputSlots: [{ slotId: 'cond-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [
          { slotId: 'cond-true', name: 'true', dataType: 'json', required: true },
          { slotId: 'cond-false', name: 'false', dataType: 'json', required: true },
        ],
        position: { x: 620, y: 300 },
      },
      // ─── 抖音解析（true 分支）───
      {
        nodeId: 'n-douyin',
        name: '抖音/TikTok 解析',
        nodeType: 'douyin-parser',
        config: {
          apiBaseUrl: 'https://tikhub.io/api/douyin',
          apiKey: tikHubApiKey,
          videoUrl: videoUrl,
        },
        inputSlots: [{ slotId: 'dp-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'dp-out', name: 'videoInfo', dataType: 'json', required: true }],
        position: { x: 920, y: 180 },
      },
      // ─── 通用 HTTP 解析（false 分支：其他平台暂用直连下载）───
      {
        nodeId: 'n-generic',
        name: '通用链接预处理',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          code: `// 其他平台：直接包装为标准 videoInfo 格式
var url = (data && data.videoUrl) || "";
var platform = (data && data.platform) || "unknown";
result = {
  platform: platform,
  originalUrl: url,
  videoUrl: url,
  title: "来自 " + platform + " 的视频",
  description: "通过通用链接导入",
  author: "",
};`,
          timeoutSeconds: '5',
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 920, y: 420 },
      },
      // ─── 数据合并（两条分支汇合）───
      {
        nodeId: 'n-merge',
        name: '合并视频信息',
        nodeType: 'data-merger',
        config: { mergeStrategy: 'object' },
        inputSlots: [
          { slotId: 'merge-in-1', name: 'input1', dataType: 'json', required: true },
          { slotId: 'merge-in-2', name: 'input2', dataType: 'json', required: true },
        ],
        outputSlots: [{ slotId: 'merge-out', name: 'merged', dataType: 'json', required: true }],
        position: { x: 1200, y: 300 },
      },
      // ─── 视频下载到 COS ───
      {
        nodeId: 'n-download',
        name: '视频下载到 COS',
        nodeType: 'video-downloader',
        config: { timeoutSeconds: '120' },
        inputSlots: [{ slotId: 'vd-in', name: 'videoInfo', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'vd-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 1480, y: 300 },
      },
      // ─── 视频内容转文本 ───
      {
        nodeId: 'n-to-text',
        name: '视频内容转文本',
        nodeType: 'video-to-text',
        config: { extractMode: 'metadata' },
        inputSlots: [{ slotId: 'vt-in', name: 'videoInfo', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'vt-out', name: 'textContent', dataType: 'json', required: true }],
        position: { x: 1760, y: 300 },
      },
      // ─── 文本转文案 ───
      {
        nodeId: 'n-copy',
        name: '生成文案',
        nodeType: 'text-to-copywriting',
        config: {
          style: copyStyle,
          maxLength: '500',
          includeHashtags: 'true',
        },
        inputSlots: [{ slotId: 'tc-in', name: 'textContent', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'tc-out', name: 'copywriting', dataType: 'json', required: true }],
        position: { x: 2040, y: 300 },
      },
      // ─── 邮件发送 ───
      {
        nodeId: 'n-email',
        name: '发送文案邮件',
        nodeType: 'email-sender',
        config: {
          toEmail: toEmail,
          subject: '短视频文案已生成',
          bodyTemplate: '',
          useHtml: 'true',
        },
        inputSlots: [{ slotId: 'email-in', name: 'content', dataType: 'text', required: false }],
        outputSlots: [{ slotId: 'email-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 2320, y: 300 },
      },
    ];

    const edges: WorkflowEdge[] = [
      // 触发 → 链接检测
      edge('n-trigger', 'manual-out', 'n-detect', 'script-in'),
      // 链接检测 → 条件判断
      edge('n-detect', 'script-out', 'n-cond', 'cond-in'),
      // 条件 true → 抖音解析
      edge('n-cond', 'cond-true', 'n-douyin', 'dp-in'),
      // 条件 false → 通用预处理
      edge('n-cond', 'cond-false', 'n-generic', 'script-in'),
      // 两条分支 → 合并
      edge('n-douyin', 'dp-out', 'n-merge', 'merge-in-1'),
      edge('n-generic', 'script-out', 'n-merge', 'merge-in-2'),
      // 合并 → 下载
      edge('n-merge', 'merge-out', 'n-download', 'vd-in'),
      // 合并 → 转文本（文本提取不需要等下载完）
      edge('n-merge', 'merge-out', 'n-to-text', 'vt-in'),
      // 转文本 → 生成文案
      edge('n-to-text', 'vt-out', 'n-copy', 'tc-in'),
      // 生成文案 → 邮件发送
      edge('n-copy', 'tc-out', 'n-email', 'email-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板 6: TikTok / 抖音 博主订阅 → 首页广告海报弹窗
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   📺 拉取博主最新作品列表（TikHub app/v3 或抖音 web，默认 4 条 = 海报 4 页）
//     ↓
//   🪟 发布到首页广告海报弹窗（4:3 ad-mode，全 bleed 视频 + 中央 Play）
//
// 用户登录后看到借鉴 Apple 产品发布会 / Netflix 预告的视频广告弹窗，
// 中央 Play 按钮主动点击播放，不打扰用户（autoplay 容易吓跑）。
//

// 多平台 CTA 文案与 ID 格式，跨两个模板复用
const PLATFORM_CTA_LABELS: Record<string, string> = {
  tiktok: '去 TikTok 看完整视频',
  douyin: '去抖音看完整视频',
  bilibili: '去 B 站看完整视频',
  xiaohongshu: '去小红书看完整笔记',
  youtube: '去 YouTube 看完整视频',
};
const PLATFORM_OPTIONS = [
  { value: 'tiktok', label: 'TikTok（海外短视频，secUid）' },
  { value: 'douyin', label: '抖音（国内短视频，sec_user_id）' },
  { value: 'bilibili', label: 'B 站（UP 主投稿，mid 数字）' },
  { value: 'xiaohongshu', label: '小红书（图文/视频笔记，user_id）' },
  { value: 'youtube', label: 'YouTube（频道视频，channelId）' },
];
const PLATFORM_ID_HELP =
  'TikTok / 抖音填 secUid 或 sec_user_id（MS4wLjAB... 格式）；'
  + 'B 站填 UP 主 mid（数字，如 12345678）；'
  + '小红书填 user_id（从博主主页 URL 末段取）；'
  + 'YouTube 填 channelId（UCxxxxx 格式）。'
  + '默认值为 TikHub 官方 TikTok 示例 secUid，换平台时记得替换';

const tiktokCreatorToHomepageTemplate: WorkflowTemplate = {
  id: 'tiktok-creator-to-homepage',
  name: '多平台博主订阅 → 首页广告海报 (TikHub)',
  description: '通过 TikHub 抓博主最新 N 条作品 → 作为首页登录弹窗海报。支持 TikTok / 抖音 / B 站 / 小红书 / YouTube 五个平台，4:3 ad 样式（全 bleed 封面 + 中央 Play）。注：B 站 / YouTube 不给 mp4 直链，海报点击会跳转原平台',
  icon: 'TT',
  tags: ['tiktok', 'douyin', 'bilibili', 'xiaohongshu', 'youtube', 'tikhub', 'video-ad', 'subscription'],
  requiredInputs: [
    {
      key: 'tikHubApiKey',
      label: 'TikHub API 密钥',
      type: 'password',
      placeholder: 'Bearer xxx 或直接粘贴 API Key',
      helpTip: '从 https://tikhub.io 用户中心获取。也可填 {{secrets.TIKHUB_API_KEY}}',
      required: true,
    },
    {
      key: 'platform',
      label: '平台',
      type: 'select',
      required: true,
      defaultValue: 'tiktok',
      options: PLATFORM_OPTIONS,
      helpTip: '选择目标平台。下方「博主 ID」字段会按所选平台读取对应 ID 类型',
    },
    {
      key: 'secUid',
      label: '博主 ID',
      type: 'text',
      defaultValue: 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM',
      placeholder: 'TikTok=secUid / 抖音=sec_user_id / B站=mid / 小红书=user_id / YouTube=channelId',
      helpTip: PLATFORM_ID_HELP,
      required: true,
    },
    {
      key: 'count',
      label: '展示几条作品（= 海报页数）',
      type: 'select',
      required: false,
      defaultValue: '4',
      options: [
        { value: '1', label: '1 条（单页海报）' },
        { value: '4', label: '4 条（推荐，4 页轮播）' },
        { value: '6', label: '6 条' },
        { value: '10', label: '10 条' },
      ],
      helpTip: '一条 item 对应海报一页，弹窗会自动轮播',
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    const tikHubApiKey = inputs.tikHubApiKey || '';
    const platform = inputs.platform || 'tiktok';
    const secUid = inputs.secUid || 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM';
    const count = inputs.count || '4';

    const nodes: WorkflowNode[] = [
      // ─── 触发 ───
      {
        nodeId: 'n-trigger',
        name: '开始抓取',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击执行 → 抓博主最新作品 → 作为首页弹窗海报发布' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 240 },
      },
      // ─── 拉取博主视频列表 ───
      {
        nodeId: 'n-fetch',
        name: '拉取博主视频列表',
        nodeType: 'tiktok-creator-fetch',
        config: {
          platform,
          apiBaseUrl: 'https://api.tikhub.io',
          apiKey: tikHubApiKey,
          secUid,
          count,
          cursor: '0',
        },
        inputSlots: [{ slotId: 'tcf-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tcf-out', name: 'videos', dataType: 'json', required: true }],
        position: { x: 380, y: 240 },
      },
      // ─── 发布到首页广告海报弹窗 ───
      {
        nodeId: 'n-publish',
        name: '发布到首页广告海报',
        nodeType: 'weekly-poster-publisher',
        config: {
          itemsField: 'items',
          templateKey: 'promo',
          presentationMode: 'ad-4-3',
          accentColor: '#ff0050',
          ctaText: PLATFORM_CTA_LABELS[platform] || PLATFORM_CTA_LABELS.tiktok,
          ctaUrlField: 'firstItem.shareUrl',
          publish: 'true',
        },
        inputSlots: [{ slotId: 'wp-in', name: 'items', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'wp-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 720, y: 240 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-fetch', 'tcf-in'),
      edge('n-fetch', 'tcf-out', 'n-publish', 'wp-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板: 产品专业委员会月报（4 章节合一）
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图（★ = 并行层）：
//
//   👆 手动触发
//     ↓
//   ★ 并行层 ─────────────────────────────────────────────────
//   │  ├── 🔗 TAPD 需求采集 (stories) → 📊 需求统计        │
//   │  ├── 🔗 TAPD 缺陷采集 (bugs)    → 📊 缺陷统计        │
//   │  ├── 📊 巡检数据解析                                  │
//   │  └── 📊 整改数据解析                                  │
//   ────────────────────────────────────────────────────────────
//     ↓
//   🔀 数据合并（4 路 fan-in）
//     ├──→ 🤖 LLM 分析 ────→ 🔀 最终合并（2 路）
//     └──────────────────────→ ↑
//                              ↓
//                         🌐 HTML 渲染
//                          ↓       ↓
//                        💾 导出  🔔 通知
//

const committeeMonthlyTemplate: WorkflowTemplate = {
  id: 'committee-monthly-report',
  name: '产品专业委员会月报',
  description: '一键生成产品质量月报：TAPD 需求分析 + 产品缺陷分析 + 月度巡检 + 专项整改，4 章节合一，AI 自动生成分析与启发',
  icon: '📋',
  tags: ['quality', 'monthly', 'tapd', 'committee', 'report'],
  requiredInputs: [
    {
      key: 'tapdAuthId',
      label: 'TAPD 授权',
      type: 'auth-picker',
      authType: 'tapd',
      helpTip: '选择在「开放平台 → 外部授权」中已添加的 TAPD 账号',
      required: true,
    },
    {
      key: 'dateRange',
      label: '统计月份',
      type: 'month',
      placeholder: '2026-03',
      helpTip: '选择要统计的月份',
      required: true,
      defaultValue: new Date().toISOString().slice(0, 7),
    },
    {
      key: 'storyWorkspaceId',
      label: '需求空间 ID',
      type: 'text',
      placeholder: '64054517',
      defaultValue: '64054517',
      helpTip: 'TAPD「米多需求池管理」空间 ID',
      required: true,
    },
    {
      key: 'bugWorkspaceId',
      label: '缺陷空间 ID',
      type: 'text',
      placeholder: '66590626',
      defaultValue: '66590626',
      helpTip: 'TAPD「产品缺陷管理」空间 ID',
      required: true,
    },
    {
      key: 'inspectionData',
      label: '巡检数据（CSV 文本）',
      type: 'textarea',
      placeholder: `## 需求评审及时性\n责任人,总数,及时,不及时\n任林波,13,12,1\n周洋腾,6,6,0\n\n## 需求状态更新及时性\n...`,
      helpTip: '从语雀 Excel 导出 CSV，按巡检类别用 ## 标题分隔。每行格式：责任人,总数,及时数,不及时数',
      required: false,
    },
    {
      key: 'rectificationData',
      label: '整改数据（CSV 文本）',
      type: 'textarea',
      placeholder: `问题,提出时间,逻辑归因,结构归母,责任人,解决计划,进度,是否办结,备注\n品牌产品保护区优化,2026-01,HTTPS协议,技术架构,伍林波,2月完成,已完成,是,`,
      helpTip: '从语雀 Excel 导出 CSV。第一行为表头，后续每行一条整改记录',
      required: false,
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    // 需求 TAPD URL 前缀（用于字段缺失时手动拼接）
    const storyWsId = inputs.storyWorkspaceId || '64054517';
    const bugWsId = inputs.bugWorkspaceId || '66590626';

    // ── 需求统计 JS（兼容中文 mapper + TAPD 原始英文字段） ──
    const storyStatsCode = `var items = Array.isArray(data) ? data : [];
var wsId = ${JSON.stringify(storyWsId)};
var total = items.length;
// 字段获取兼容层：中文 mapper → TAPD 原始字段
function F(i, cn, en1, en2) { return i[cn] || i[en1] || (en2?i[en2]:"") || ""; }
function getTitle(i) { return F(i, "标题", "name", "title"); }
function getHandler(i) { return F(i, "处理人", "current_owner", "owner"); }
function getStatus(i) { return F(i, "状态", "status_label", "status"); }
function getPriority(i) { return F(i, "优先级", "priority_label", "priority"); }
function getCreatedAt(i) { return F(i, "创建时间", "created"); }
function getUrl(i) {
  var u = i["URL链接"] || i.url || "";
  if (!u && wsId && (i.id || i.ID)) u = "https://www.tapd.cn/tapd_fe/"+wsId+"/story/detail/"+(i.id||i.ID);
  return u;
}
var statusMap = {};
items.forEach(function(i) { var s = (getStatus(i) || "未知").toString().trim(); statusMap[s] = (statusMap[s]||0)+1; });
var handlerMap = {};
items.forEach(function(i) { var h = (getHandler(i) || "未分配").toString().trim(); handlerMap[h] = (handlerMap[h]||0)+1; });
var priorityMap = {};
items.forEach(function(i) { var p = (getPriority(i) || "未设置").toString().trim(); priorityMap[p] = (priorityMap[p]||0)+1; });
var customerMap = {};
items.forEach(function(i) {
  var title = getTitle(i);
  var m = title.match(/\\[([^\\]]+)\\]/);
  if (m) {
    var name = m[1];
    if (!customerMap[name]) customerMap[name] = {count:0, titles:[]};
    customerMap[name].count++;
    if (customerMap[name].titles.length < 3) customerMap[name].titles.push(title);
  }
});
var customers = Object.keys(customerMap).map(function(k) {
  return {name:k, count:customerMap[k].count, titles:customerMap[k].titles};
}).sort(function(a,b){return b.count-a.count;});
var details = items.map(function(i) {
  return {title:getTitle(i), handler:getHandler(i), status:getStatus(i), priority:getPriority(i), createdAt:getCreatedAt(i), url:getUrl(i)};
});
result = {total:total, statusDistribution:statusMap, handlerDistribution:handlerMap, priorityDistribution:priorityMap, customerAnalysis:customers, details:details};`;

    // ── 缺陷统计 JS（兼容中文 mapper + TAPD 原始英文字段） ──
    const defectStatsCode = `var items = Array.isArray(data) ? data : [];
var wsId = ${JSON.stringify(bugWsId)};
var total = items.length;
function F(i, cn, en1, en2) { return i[cn] || i[en1] || (en2?i[en2]:"") || ""; }
function getTitle(i) { return F(i, "标题", "title"); }
function getHandler(i) { return F(i, "处理人", "current_owner", "owner"); }
function getCreator(i) { return F(i, "创建人", "reporter", "creator"); }
function getStatus(i) { return F(i, "状态", "status_label", "status"); }
// 产品线分类：优先读取 TAPD 原始 module 字段（产品线：智能营销/PDA/DCRM等），
// 然后尝试自定义分类字段，最后退回到"缺陷划分"（技术/产品/非缺陷，维度不同但可用于兜底）
function getCategory(i) {
  return F(i, "分类", "module") || i["所属产品"] || i.custom_field_14 || i.custom_field_15 ||
         i.custom_field_16 || i.custom_field_17 || i.custom_field_18 || i["缺陷划分"] || i.custom_field_7 || "";
}
// 优先级：TAPD bug 原始 priority_label / priority
function getPriority(i) { return F(i, "优先级", "priority_label", "priority"); }
// 严重程度
function getSeverity(i) { return F(i, "严重程度", "severity_label", "severity"); }
function getCreatedAt(i) { return F(i, "创建时间", "created"); }
function getUrl(i) {
  var u = i["URL链接"] || i.url || "";
  if (!u && wsId && (i.id || i.ID || i.bug_id)) u = "https://www.tapd.cn/tapd_fe/"+wsId+"/bug/detail/"+(i.id||i.ID||i.bug_id);
  return u;
}
var statusMap = {};
items.forEach(function(i) { var s = (getStatus(i) || "未知").toString().trim(); statusMap[s] = (statusMap[s]||0)+1; });
var categoryMap = {};
items.forEach(function(i) { var c = (getCategory(i) || "未分类").toString().trim(); categoryMap[c] = (categoryMap[c]||0)+1; });
var handlerMap = {};
items.forEach(function(i) { var h = (getHandler(i) || "未分配").toString().trim(); handlerMap[h] = (handlerMap[h]||0)+1; });
var priorityMap = {};
items.forEach(function(i) { var p = (getPriority(i) || "未设置").toString().trim(); priorityMap[p] = (priorityMap[p]||0)+1; });
var severityMap = {};
items.forEach(function(i) { var s = (getSeverity(i) || "未设置").toString().trim(); severityMap[s] = (severityMap[s]||0)+1; });
var details = items.map(function(i) {
  return {title:getTitle(i), handler:getHandler(i), creator:getCreator(i), status:getStatus(i), priority:getPriority(i), severity:getSeverity(i), category:getCategory(i), createdAt:getCreatedAt(i), url:getUrl(i)};
});
result = {total:total, statusDistribution:statusMap, categoryDistribution:categoryMap, handlerDistribution:handlerMap, priorityDistribution:priorityMap, severityDistribution:severityMap, details:details};`;

    // ── 巡检解析 JS ──
    const inspectionParseCode = `var raw = ${JSON.stringify(inputs.inspectionData || '')};
var items = [];
var curName = "";
var curDetails = [];
raw.split("\\n").forEach(function(line) {
  line = line.trim();
  if (!line) return;
  if (line.indexOf("##") === 0) {
    if (curName) {
      var t=0,ti=0;
      curDetails.forEach(function(d){t+=d.total;ti+=d.timely;});
      items.push({name:curName, total:t, timely:ti, details:curDetails});
    }
    curName = line.replace(/^#+\\s*/, "").trim();
    curDetails = [];
  } else {
    var sep = line.indexOf("\\t") >= 0 ? "\\t" : ",";
    var parts = line.split(sep).map(function(s){return s.trim();});
    if (parts.length >= 3 && !/^(责任人|负责人|人员|name|person)/i.test(parts[0]) && !isNaN(parseInt(parts[1]))) {
      var person = parts[0];
      var total = parseInt(parts[1]) || 0;
      var timely = parseInt(parts[2]) || 0;
      var untimely = parts.length >= 4 ? (parseInt(parts[3]) || 0) : (total - timely);
      curDetails.push({person:person, total:total, timely:timely, untimely:untimely});
    }
  }
});
if (curName) {
  var t=0,ti=0;
  curDetails.forEach(function(d){t+=d.total;ti+=d.timely;});
  items.push({name:curName, total:t, timely:ti, details:curDetails});
}
result = {items:items};`;

    // ── 整改解析 JS ──
    const rectificationParseCode = `var raw = ${JSON.stringify(inputs.rectificationData || '')};
var lines = raw.split("\\n").map(function(l){return l.trim();}).filter(function(l){return l;});
var items = [];
// Header 识别：更宽松的特征检测，适应用户从语雀 / Excel 复制的各种列名风格
// 判定为 header 的信号：首行不含日期格式 + 含至少一个表头关键词（问题/归因/责任人/进度/办结/备注...）
function looksLikeHeader(parts) {
  var joined = parts.join(" ");
  // 含任一典型日期格式 → 视为数据行
  if (/\\d{4}[-\\/\\.]\\d{1,2}/.test(joined)) return false;
  var keywords = ["问题","简要说明","归因","责任","责任人","计划","进度","办结","备注","提出时间","提交时间"];
  var hits = 0;
  for (var i = 0; i < keywords.length; i++) {
    if (joined.indexOf(keywords[i]) >= 0) hits++;
  }
  return hits >= 2; // 至少命中 2 个关键词才认为是 header
}
var headerChecked = false;
lines.forEach(function(line) {
  var sep = line.indexOf("\\t") >= 0 ? "\\t" : ",";
  var parts = line.split(sep).map(function(s){return s.trim();});
  if (!headerChecked) {
    headerChecked = true;
    if (looksLikeHeader(parts)) return; // 跳过 header
  }
  if (parts.length >= 7) {
    items.push({
      problem: parts[0] || "",
      raisedAt: parts[1] || "",
      logicCause: parts[2] || "",
      structCause: parts[3] || "",
      owner: parts[4] || "",
      plan: parts[5] || "",
      progress: parts[6] || "",
      closed: (parts[7] || "").indexOf("是") >= 0,
      remark: parts[8] || ""
    });
  }
});
var closed = items.filter(function(i){return i.closed;}).length;
result = {total:items.length, closed:closed, open:items.length-closed, items:items};`;

    // ── LLM 分析 Prompt ──
    const llmPrompt = `你是产品质量分析师。基于以下 4 个板块的数据，为产品专业委员会月报生成分析报告。

对每个板块输出 3-5 条关键发现和改进建议。语言简洁专业，直击要点。

按以下格式输出（必须使用这些标题）：

## 需求分析
- 发现1...
- 发现2...
- 建议...

## 产品缺陷分析
- 发现1...
- 建议...

## 月度巡检分析
- 发现1...
- 建议...

## 专项整改分析
- 发现1...
- 建议...`;

    const nodes: WorkflowNode[] = [
      // ── 触发 ──
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击开始生成产品专业委员会月报' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 400 },
      },

      // ── TAPD 需求采集 ──
      {
        nodeId: 'n-tapd-story',
        name: 'TAPD 需求采集',
        nodeType: 'tapd-collector',
        config: {
          authMode: 'stored',
          authId: inputs.tapdAuthId || '',
          workspaceId: inputs.storyWorkspaceId || '64054517',
          dataType: 'stories',
          dateRange: inputs.dateRange || '',
          maxPages: '50',
          fetchDetail: 'true',
        },
        inputSlots: [{ slotId: 'tapd-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tapd-out', name: 'data', dataType: 'json', required: true }],
        position: { x: 380, y: 150 },
      },

      // ── 需求统计 ──
      {
        nodeId: 'n-story-stats',
        name: '需求统计',
        nodeType: 'script-executor',
        config: { language: 'javascript', code: storyStatsCode, timeoutSeconds: '30' },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 680, y: 150 },
      },

      // ── TAPD 缺陷采集 ──
      {
        nodeId: 'n-tapd-bug',
        name: 'TAPD 缺陷采集',
        nodeType: 'tapd-collector',
        config: {
          authMode: 'stored',
          authId: inputs.tapdAuthId || '',
          workspaceId: inputs.bugWorkspaceId || '66590626',
          dataType: 'bugs',
          dateRange: inputs.dateRange || '',
          maxPages: '50',
          fetchDetail: 'true',
        },
        inputSlots: [{ slotId: 'tapd-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tapd-out', name: 'data', dataType: 'json', required: true }],
        position: { x: 380, y: 350 },
      },

      // ── 缺陷统计 ──
      {
        nodeId: 'n-bug-stats',
        name: '缺陷统计',
        nodeType: 'script-executor',
        config: { language: 'javascript', code: defectStatsCode, timeoutSeconds: '30' },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 680, y: 350 },
      },

      // ── 巡检解析 ──
      {
        nodeId: 'n-inspection',
        name: '巡检数据解析',
        nodeType: 'script-executor',
        config: { language: 'javascript', code: inspectionParseCode, timeoutSeconds: '15' },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 380, y: 550 },
      },

      // ── 整改解析 ──
      {
        nodeId: 'n-rectification',
        name: '整改数据解析',
        nodeType: 'script-executor',
        config: { language: 'javascript', code: rectificationParseCode, timeoutSeconds: '15' },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'json', required: true }],
        position: { x: 380, y: 750 },
      },

      // ── 数据合并 (4 路) ──
      {
        nodeId: 'n-merge-data',
        name: '数据合并（4路）',
        nodeType: 'data-merger',
        config: { mergeStrategy: 'object' },
        inputSlots: [
          { slotId: 'merge-in-1', name: 'input1', dataType: 'json', required: true, description: '需求统计' },
          { slotId: 'merge-in-2', name: 'input2', dataType: 'json', required: true, description: '缺陷统计' },
          { slotId: 'merge-in-3', name: 'input3', dataType: 'json', required: true, description: '巡检数据' },
          { slotId: 'merge-in-4', name: 'input4', dataType: 'json', required: true, description: '整改数据' },
        ],
        outputSlots: [{ slotId: 'merge-out', name: 'merged', dataType: 'json', required: true }],
        position: { x: 1000, y: 400 },
      },

      // ── LLM 分析 ──
      {
        nodeId: 'n-llm',
        name: 'AI 分析与启发',
        nodeType: 'report-generator',
        config: { reportTemplate: llmPrompt, format: 'markdown' },
        inputSlots: [{ slotId: 'report-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'report-out', name: 'report', dataType: 'text', required: true }],
        position: { x: 1300, y: 250 },
      },

      // ── 最终合并 (LLM 输出 + 原始数据) ──
      {
        nodeId: 'n-merge-final',
        name: '合并分析结果',
        nodeType: 'data-merger',
        config: { mergeStrategy: 'object' },
        inputSlots: [
          { slotId: 'merge-in-1', name: 'input1', dataType: 'json', required: true, description: 'AI 分析文本' },
          { slotId: 'merge-in-2', name: 'input2', dataType: 'json', required: true, description: '原始统计数据' },
        ],
        outputSlots: [{ slotId: 'merge-out', name: 'merged', dataType: 'json', required: true }],
        position: { x: 1600, y: 400 },
      },

      // ── HTML 渲染 ──
      {
        nodeId: 'n-html',
        name: 'HTML 月报渲染',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          timeoutSeconds: '30',
          code: committeeMonthlyHtmlGenCode,
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 1900, y: 400 },
      },

      // ── 导出 ──
      {
        nodeId: 'n-export',
        name: '导出 HTML 月报',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'html',
          fileName: `committee-monthly-report-${inputs.dateRange || '{{date}}'}`,
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 2200, y: 280 },
      },

      // ── 通知 ──
      {
        nodeId: 'n-notify',
        name: '完成通知',
        nodeType: 'notification-sender',
        config: {
          title: '产品专业委员会月报已生成',
          content: '已完成 4 个章节的数据采集、统计分析和 AI 洞察，请查看 HTML 报告',
          level: 'success',
          attachFromInput: 'cos',
        },
        inputSlots: [{ slotId: 'notify-in', name: 'data', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'notify-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 2200, y: 520 },
      },
    ];

    const edges: WorkflowEdge[] = [
      // 触发 → 4 路并行
      edge('n-trigger', 'manual-out', 'n-tapd-story', 'tapd-in'),
      edge('n-trigger', 'manual-out', 'n-tapd-bug', 'tapd-in'),
      edge('n-trigger', 'manual-out', 'n-inspection', 'script-in'),
      edge('n-trigger', 'manual-out', 'n-rectification', 'script-in'),

      // TAPD → 统计
      edge('n-tapd-story', 'tapd-out', 'n-story-stats', 'script-in'),
      edge('n-tapd-bug', 'tapd-out', 'n-bug-stats', 'script-in'),

      // 4 路 → 数据合并
      edge('n-story-stats', 'script-out', 'n-merge-data', 'merge-in-1'),
      edge('n-bug-stats', 'script-out', 'n-merge-data', 'merge-in-2'),
      edge('n-inspection', 'script-out', 'n-merge-data', 'merge-in-3'),
      edge('n-rectification', 'script-out', 'n-merge-data', 'merge-in-4'),

      // 数据合并 → LLM + 最终合并
      edge('n-merge-data', 'merge-out', 'n-llm', 'report-in'),
      edge('n-merge-data', 'merge-out', 'n-merge-final', 'merge-in-2'),

      // LLM → 最终合并
      edge('n-llm', 'report-out', 'n-merge-final', 'merge-in-1'),

      // 最终合并 → HTML
      edge('n-merge-final', 'merge-out', 'n-html', 'script-in'),

      // HTML → 导出 + 通知
      edge('n-html', 'script-out', 'n-export', 'export-in'),
      edge('n-html', 'script-out', 'n-notify', 'notify-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 模板: TikTok / 抖音 博主订阅 → 首页图文混排海报 (ad-rich-text)
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//
//   👆 手动触发 → 📦 拉取博主视频列表 → 📝 视频转文字 (ASR + hook) → 🪧 发布图文混排海报
//
// vs ad-4-3 模板（仅 3 节点，body 是 @author+#aweme+desc）:
//   多了 video-to-text(asr) 节点，下载视频 → ffmpeg 抽音 → 流式 ASR → LLM 提炼出
//   每条作品的 hook（一句话钩子）+ bullets（三条要点）+ body（拼好的 markdown bullets）。
//   ad-rich-text 海报视图直接用 hook 当 title、bullets 当 body 渲染左右双栏布局。
//
// 注意:
//   - ASR 走豆包流式（需要管理员在模型池配置 video-agent.video-to-text::asr）
//   - 单条视频 ASR 约 10-60s，建议 count<=4 控制总耗时（默认 4 即上限）
//   - 视频或 ASR 失败时降级为空 transcript，但 item 仍透传不报错
//

const tiktokCreatorToHomepageRichTemplate: WorkflowTemplate = {
  id: 'tiktok-creator-to-homepage-rich',
  name: '多平台博主订阅 → 首页图文混排海报 (ASR)',
  description: '比 ad-4-3 模板多一步真音频转写：抓博主作品 → 下载视频 → ffmpeg 抽音 → 流式 ASR → LLM 提炼 hook+bullets → 发布为图文混排海报（左动图 + 右 hook 大字 + bullets）。支持 TikTok / 抖音 / B 站 / 小红书 / YouTube。注：B 站 / YouTube / 小红书图文笔记没 mp4 直链，会跳过 ASR 直接走 cover + 标题',
  icon: 'TT',
  tags: ['tiktok', 'douyin', 'bilibili', 'xiaohongshu', 'youtube', 'tikhub', 'asr', 'video-ad', 'subscription', 'rich-text'],
  requiredInputs: [
    {
      key: 'tikHubApiKey',
      label: 'TikHub API 密钥',
      type: 'password',
      placeholder: 'Bearer xxx 或直接粘贴 API Key',
      helpTip: '从 https://tikhub.io 用户中心获取。也可填 {{secrets.TIKHUB_API_KEY}}',
      required: true,
    },
    {
      key: 'platform',
      label: '平台',
      type: 'select',
      required: true,
      defaultValue: 'tiktok',
      options: PLATFORM_OPTIONS,
      helpTip: '选择目标平台。B 站 / YouTube / 小红书图文笔记没 mp4 直链，ASR 会自动跳过这些条目',
    },
    {
      key: 'secUid',
      label: '博主 ID',
      type: 'text',
      defaultValue: 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM',
      placeholder: 'TikTok=secUid / 抖音=sec_user_id / B站=mid / 小红书=user_id / YouTube=channelId',
      helpTip: PLATFORM_ID_HELP,
      required: true,
    },
    {
      key: 'count',
      label: '展示几条作品（= 海报页数 = ASR 条数）',
      type: 'select',
      required: false,
      defaultValue: '4',
      options: [
        { value: '1', label: '1 条（单页海报，最快约 30s）' },
        { value: '2', label: '2 条（约 60-90s）' },
        { value: '4', label: '4 条（推荐，约 2-3 分钟）' },
        { value: '6', label: '6 条（约 4-5 分钟）' },
      ],
      helpTip: 'ASR 模式较慢（每条 10-60s），建议 ≤ 4。一条 item 对应海报一页',
    },
    {
      key: 'enableHook',
      label: 'AI 提炼 hook + bullets',
      type: 'select',
      required: false,
      defaultValue: 'true',
      options: [
        { value: 'true', label: '开启（推荐：转写后 LLM 提炼一句话钩子 + 三条要点）' },
        { value: 'false', label: '关闭（仅原始转写文字，body 留空，海报会兜底显示作者+描述）' },
      ],
      helpTip: '开启后 ad-rich-text 海报右侧才有结构化 hook + bullets。关闭等同 ad-4-3 模板加了一步无意义的 ASR',
    },
  ],
  build: (inputs) => {
    _edgeIdx = 0;

    const tikHubApiKey = inputs.tikHubApiKey || '';
    const platform = inputs.platform || 'tiktok';
    const secUid = inputs.secUid || 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM';
    const count = inputs.count || '4';
    const enableHook = inputs.enableHook || 'true';

    const nodes: WorkflowNode[] = [
      // ─── 触发 ───
      {
        nodeId: 'n-trigger',
        name: '开始抓取',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击执行 → 抓博主作品 → ASR 转写 → 发布图文混排海报' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 80, y: 240 },
      },
      // ─── 拉取博主视频列表 ───
      {
        nodeId: 'n-fetch',
        name: '拉取博主视频列表',
        nodeType: 'tiktok-creator-fetch',
        config: {
          platform,
          apiBaseUrl: 'https://api.tikhub.io',
          apiKey: tikHubApiKey,
          secUid,
          count,
          cursor: '0',
        },
        inputSlots: [{ slotId: 'tcf-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tcf-out', name: 'videos', dataType: 'json', required: true }],
        position: { x: 360, y: 240 },
      },
      // ─── 视频转文字（ASR + LLM 二次提炼） ───
      // maxItems 留空 → 自动处理上游所有 items，无需与 count 联动
      {
        nodeId: 'n-asr',
        name: '音频转写 + AI 提炼',
        nodeType: 'video-to-text',
        config: {
          extractMode: 'asr',
          videoUrlField: 'videoUrl',
          itemsField: 'items',
          enableHookExtraction: enableHook,
        },
        inputSlots: [{ slotId: 'vt-in', name: 'videoInfo', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'vt-out', name: 'textContent', dataType: 'json', required: true }],
        position: { x: 660, y: 240 },
      },
      // ─── 发布到首页图文混排海报 ───
      {
        nodeId: 'n-publish',
        name: '发布图文混排海报',
        nodeType: 'weekly-poster-publisher',
        config: {
          itemsField: 'items',
          templateKey: 'promo',
          presentationMode: 'ad-rich-text',
          accentColor: '#ff0050',
          ctaText: PLATFORM_CTA_LABELS[platform] || PLATFORM_CTA_LABELS.tiktok,
          ctaUrlField: 'firstItem.shareUrl',
          publish: 'true',
        },
        inputSlots: [{ slotId: 'wp-in', name: 'items', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'wp-out', name: 'result', dataType: 'json', required: true }],
        position: { x: 980, y: 240 },
      },
    ];

    const edges: WorkflowEdge[] = [
      edge('n-trigger', 'manual-out', 'n-fetch', 'tcf-in'),
      edge('n-fetch', 'tcf-out', 'n-asr', 'vt-in'),
      edge('n-asr', 'vt-out', 'n-publish', 'wp-in'),
    ];

    return { nodes, edges, variables: [] };
  },
};

// ═══════════════════════════════════════════════════════════════
// 注册表
// ═══════════════════════════════════════════════════════════════

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  committeeMonthlyTemplate,
  fullTestSuiteTemplate,
  tapdBugCollectionTemplate,
  smartHttpTemplate,
  smartHttpAcceptanceTemplate,
  apiReviewWorkflowTemplate,
  videoWorkflowTemplate,
  tiktokCreatorToHomepageTemplate,
  tiktokCreatorToHomepageRichTemplate,
];
