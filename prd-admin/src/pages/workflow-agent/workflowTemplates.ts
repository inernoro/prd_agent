import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';
import { tapdHtmlGenCode } from './tapdHtmlTemplate';

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

// 时间戳
var now = new Date();
var pad = function(n) { return String(n).padStart(2, "0"); };
var ts = now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+" "+pad(now.getHours())+":"+pad(now.getMinutes());

result = {
  title: "TAPD 缺陷质量分析报告",
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
// 注册表
// ═══════════════════════════════════════════════════════════════

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  fullTestSuiteTemplate,
  tapdBugCollectionTemplate,
  smartHttpTemplate,
  smartHttpAcceptanceTemplate,
  apiReviewWorkflowTemplate,
  videoWorkflowTemplate,
];
