import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';
import { qualityMonthlyTemplate } from './qualityMonthlyTemplate';

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
          code: `// data = upstream stats JSON (kpis, severity, rootCauses, defectDetails, etc.)
var d = data;
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>' + (d.title || 'Quality Report') + '</title>');
H.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
H.push('<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');
H.push(':root{--bg:#0D1117;--card:#161B22;--elev:#1C2128;--bdr:#30363D;--t1:#E6EDF3;--t2:#7D8590;--blue:#1E6FD9;--orange:#F5A623;--green:#27C97F;--red:#E84040;--cyan:#4ECDC4}');
H.push('*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Noto Sans SC",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;min-height:100vh}');
H.push('.ctn{max-width:1400px;margin:0 auto;padding:0 24px}');
H.push('.nav{position:sticky;top:0;z-index:100;background:rgba(13,17,23,0.85);backdrop-filter:blur(16px);border-bottom:1px solid var(--bdr);padding:16px 24px}');
H.push('.nav-in{max-width:1400px;margin:0 auto;display:flex;align-items:center;gap:12px}');
H.push('.logo{width:32px;height:32px;background:linear-gradient(135deg,var(--blue),var(--cyan));border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}');
H.push('.nav-t{font-weight:700;font-size:1.1rem}.nav-ts{margin-left:auto;font-size:0.8rem;color:var(--t2)}');
H.push('.sec{padding:40px 0}.sec-t{font-size:1.4rem;font-weight:700;margin-bottom:24px;background:linear-gradient(135deg,var(--t1),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}');
H.push('.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:40px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;transition:0.3s}.kpi:hover{transform:translateY(-4px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}');
H.push('.kpi-l{font-size:0.8rem;color:var(--t2);margin-bottom:6px;font-weight:600}');
H.push('.kpi-v{font-family:"Bebas Neue",monospace;font-size:2.8rem;line-height:1}');
H.push('.cg{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:20px;margin-bottom:32px}');
H.push('.cc{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px}.cc h3{font-size:1rem;margin-bottom:16px}');
H.push('.alert{background:rgba(232,64,64,0.08);border:1px solid rgba(232,64,64,0.3);border-radius:12px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:flex-start;gap:12px}');
H.push('.alert-b{background:var(--red);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:700;flex-shrink:0}');
H.push('.alert-t{font-weight:600;color:var(--red)}.alert-t a{color:var(--red);text-decoration:underline;text-underline-offset:3px}.alert-t a:hover{color:#FF6B6B}');
H.push('.alert-d{font-size:0.8rem;color:var(--t2);margin-top:2px}');
H.push('.alert-meta{display:flex;gap:12px;margin-top:6px;font-size:0.75rem;color:var(--t2)}.alert-meta span{display:inline-flex;align-items:center;gap:4px}');
H.push('.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:0.65rem;font-weight:600}');
H.push('.tag-suspend{background:rgba(125,133,144,0.2);color:#7D8590}.tag-tmp{background:rgba(245,166,35,0.2);color:#F5A623}');
H.push('.tag-overdue{background:rgba(232,64,64,0.2);color:#E84040}.tag-untimely{background:rgba(255,107,53,0.2);color:#FF6B35}');
H.push('.prob-list{display:flex;flex-direction:column;gap:10px;margin-top:16px}');
H.push('.prob-item{background:var(--elev);border:1px solid var(--bdr);border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;gap:6px}');
H.push('.prob-title{font-size:0.85rem;font-weight:600}.prob-title a{color:var(--t1);text-decoration:none}.prob-title a:hover{text-decoration:underline;color:var(--blue)}');
H.push('.prob-tags{display:flex;gap:6px;flex-wrap:wrap}.prob-meta{font-size:0.75rem;color:var(--t2);display:flex;gap:12px}');
H.push('.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:24px}');
H.push('.sc{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:14px;text-align:center}');
H.push('.sc-n{font-family:"Bebas Neue",monospace;font-size:1.8rem}.sc-l{font-size:0.75rem;color:var(--t2)}');
H.push('.bl{display:flex;flex-direction:column;gap:10px}');
H.push('.bi{display:flex;align-items:center;gap:10px}.bi-l{flex:0 0 160px;font-size:0.85rem;text-align:right;color:var(--t2)}');
H.push('.bi-t{flex:1;height:24px;background:var(--elev);border-radius:4px;overflow:hidden}');
H.push('.bi-f{height:100%;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;font-size:0.7rem;font-weight:700;color:rgba(255,255,255,0.9);transition:width 0.8s ease}');
H.push('.acc{display:flex;flex-direction:column;gap:8px}');
H.push('.ag{background:var(--card);border:1px solid var(--bdr);border-radius:8px;overflow:hidden}');
H.push('.ah{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer}.ah:hover{background:rgba(255,255,255,0.03)}');
H.push('.ad{width:8px;height:8px;border-radius:50%;flex-shrink:0}.ac{font-weight:600;flex:1}');
H.push('.ab{background:rgba(30,111,217,0.15);color:var(--blue);padding:2px 10px;border-radius:12px;font-size:0.7rem;font-weight:700}');
H.push('.abdy{max-height:0;overflow:hidden;transition:max-height 0.4s ease}.ag.open .abdy{max-height:2000px}');
H.push('.dl{padding:0 16px 16px;display:flex;flex-direction:column;gap:6px}');
H.push('.df{display:flex;gap:10px;padding:10px;background:var(--elev);border-radius:6px;border-left:3px solid var(--blue);font-size:0.85rem}');
H.push('.di{flex-shrink:0;width:20px;height:20px;background:rgba(30,111,217,0.15);color:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700}');
H.push('.dc{margin-top:3px;font-size:0.8rem;color:var(--orange)}');
H.push('.dh{display:inline-block;margin-top:3px;background:rgba(125,133,144,0.15);color:var(--t2);padding:1px 6px;border-radius:8px;font-size:0.65rem}');
H.push('.smg{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}');
H.push('.smc{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:18px 20px;display:flex;align-items:flex-start;gap:14px}');
H.push('.smi{flex-shrink:0;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center}');
H.push('.ft{text-align:center;padding:32px 0;border-top:1px solid var(--bdr);color:var(--t2);font-size:0.8rem}');
H.push('.doc-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}');
H.push('.doc-card{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:14px 18px;display:flex;align-items:center;gap:12px;transition:0.2s}');
H.push('.doc-card:hover{border-color:var(--blue);transform:translateY(-2px)}.doc-card a{color:var(--blue);text-decoration:none;font-size:0.85rem;font-weight:600}');
H.push('.doc-card a:hover{text-decoration:underline}.doc-from{font-size:0.7rem;color:var(--t2);margin-top:2px}');
H.push('.edit-sec{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px;margin-top:24px}');
H.push('.edit-sec h4{font-size:1rem;font-weight:700;margin-bottom:12px;color:var(--t1)}');
H.push('.edit-area{min-height:120px;padding:16px;background:var(--elev);border:1px dashed var(--bdr);border-radius:8px;color:var(--t1);font-size:0.9rem;line-height:1.8;outline:none}');
H.push('.edit-area:focus{border-color:var(--blue)}.edit-area:empty:before{content:attr(data-placeholder);color:var(--t2)}');
H.push('.edit-hint{font-size:0.7rem;color:var(--t2);margin-top:8px;font-style:italic}');
H.push('.improve-item{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(48,54,61,0.5)}');
H.push('.improve-cb{width:18px;height:18px;border:2px solid var(--bdr);border-radius:4px;flex-shrink:0;margin-top:2px;cursor:pointer;display:flex;align-items:center;justify-content:center}');
H.push('.improve-cb.checked{background:var(--green);border-color:var(--green)}.improve-cb.checked:after{content:"\\\\2713";color:#fff;font-size:11px}');
H.push('.improve-tag{padding:1px 6px;border-radius:3px;font-size:0.65rem;font-weight:600;background:rgba(30,111,217,0.15);color:var(--blue);flex-shrink:0}');
H.push('@media(max-width:768px){.kg{grid-template-columns:repeat(2,1fr)}.cg{grid-template-columns:1fr}.bi-l{flex:0 0 80px;font-size:0.7rem}}');
H.push('</style></head><body>');

// Navbar
H.push('<nav class="nav"><div class="nav-in"><div class="logo">Q</div>');
H.push('<span class="nav-t">' + (d.title || "Quality Report") + '</span>');
H.push('<span class="nav-ts">' + (d.generatedAt || "") + '</span></div></nav>');

// KPI Cards
H.push('<div class="sec"><div class="ctn"><div class="kg">');
(d.kpis || []).forEach(function(k) {
  var val = k.format === "percent" ? k.value + "%" : k.value;
  H.push('<div class="kpi"><div class="kpi-l">' + k.label + '</div>');
  H.push('<div class="kpi-v" style="color:' + (k.color||"#1E6FD9") + '">' + val + '</div></div>');
});
H.push('</div>');

// Critical Alerts
if (d.criticalAlerts && d.criticalAlerts.length > 0) {
  d.criticalAlerts.forEach(function(a) {
    H.push('<div class="alert"><span class="alert-b">' + a.level + '</span><div style="flex:1">');
    if (a.url) {
      H.push('<div class="alert-t"><a href="' + a.url + '" target="_blank" rel="noopener">' + a.title + ' &rarr;</a></div>');
    } else {
      H.push('<div class="alert-t">' + a.title + '</div>');
    }
    if (a.desc) H.push('<div class="alert-d">' + a.desc + '</div>');
    var metaParts = [];
    if (a.handler) metaParts.push('<span>&#128736; ' + a.handler + '</span>');
    if (a.reporter) metaParts.push('<span>&#128221; ' + a.reporter + '</span>');
    if (a.bugId) metaParts.push('<span>#' + a.bugId + '</span>');
    if (metaParts.length > 0) H.push('<div class="alert-meta">' + metaParts.join('') + '</div>');
    H.push('</div></div>');
  });
}

// Charts
var sev = d.severity || {};
H.push('<div class="cg">');
H.push('<div class="cc"><h3>缺陷级别分布</h3><div id="sevChart" style="width:100%;height:320px"></div></div>');
var rcs = d.rootCauses || [];
var rcMax = rcs.length > 0 ? rcs[0].count : 1;
H.push('<div class="cc"><h3>缺陷根因分布</h3><div class="bl">');
rcs.forEach(function(rc) {
  var pW = Math.max(rc.count / rcMax * 100, 8);
  H.push('<div class="bi"><div class="bi-l">' + rc.name + '</div>');
  H.push('<div class="bi-t"><div class="bi-f" style="width:'+pW+'%;background:'+(rc.color||"#1E6FD9")+'">' + rc.count + '</div></div></div>');
});
H.push('</div></div></div>');

// Status
H.push('<h3 class="sec-t" style="margin-top:32px">处理状态总览</h3>');
var stMap = d.processingStatus || {};
var stC = {"已修复":"var(--green)","临时解决":"var(--orange)","处理中":"var(--blue)","挂起":"var(--t2)","逾期":"var(--red)"};
H.push('<div class="sg">');
Object.keys(stMap).forEach(function(k) {
  H.push('<div class="sc"><div class="sc-n" style="color:'+(stC[k]||"var(--t1)")+'">' + stMap[k] + '</div><div class="sc-l">' + k + '</div></div>');
});
H.push('</div>');

// Problem Items (挂起/临时解决/逾期/未及时处理)
var probs = d.problemItems || [];
if (probs.length > 0) {
  H.push('<h3 class="sec-t" style="margin-top:32px">需跟进问题清单 (' + probs.length + ')</h3>');
  H.push('<div class="prob-list">');
  var tagClassMap = {"挂起":"tag-suspend","临时解决":"tag-tmp","逾期":"tag-overdue","未及时处理":"tag-untimely"};
  probs.forEach(function(p) {
    H.push('<div class="prob-item">');
    var titleHtml = p.title;
    if (p.url) titleHtml = '<a href="' + p.url + '" target="_blank" rel="noopener">' + p.title + ' &rarr;</a>';
    H.push('<div class="prob-title">' + (p.level ? '<span class="alert-b" style="font-size:0.6rem;margin-right:6px;vertical-align:middle">' + p.level + '</span>' : '') + titleHtml + '</div>');
    H.push('<div class="prob-tags">');
    p.tags.forEach(function(t) { H.push('<span class="tag ' + (tagClassMap[t]||"") + '">' + t + '</span>'); });
    H.push('</div>');
    var meta = [];
    if (p.handler) meta.push('&#128736; ' + p.handler);
    if (p.responsible) meta.push('&#128100; ' + p.responsible);
    if (p.reporter) meta.push('&#128221; ' + p.reporter);
    if (p.bugId) meta.push('#' + p.bugId);
    if (meta.length > 0) H.push('<div class="prob-meta">' + meta.map(function(m){return '<span>'+m+'</span>';}).join('') + '</div>');
    H.push('</div>');
  });
  H.push('</div>');
}

// Defect Accordion
var dets = d.defectDetails || [];
if (dets.length > 0) {
  H.push('<h3 class="sec-t">典型缺陷详情</h3><div class="acc">');
  dets.forEach(function(grp, gi) {
    var q = String.fromCharCode(39);
    H.push('<div class="ag" data-g="' + gi + '">');
    H.push('<div class="ah" onclick="var g=this.parentElement;g.classList.toggle('+q+'open'+q+')">');
    H.push('<div class="ad" style="background:' + (grp.color||"#1E6FD9") + '"></div>');
    H.push('<div class="ac">' + grp.category + '</div>');
    H.push('<div class="ab">' + grp.items.length + '</div>');
    H.push('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t2)"><path d="M6 9l6 6 6-6"/></svg>');
    H.push('</div><div class="abdy"><div class="dl">');
    grp.items.forEach(function(item, ii) {
      H.push('<div class="df" style="border-left-color:' + (grp.color||"#1E6FD9") + '">');
      H.push('<div class="di">' + (ii+1) + '</div><div style="flex:1">');
      if (item.url) {
        H.push('<div><a href="' + item.url + '" target="_blank" rel="noopener" style="color:var(--t1);text-decoration:none">' + item.desc + ' &rarr;</a></div>');
      } else {
        H.push('<div>' + item.desc + '</div>');
      }
      if (item.cause) H.push('<div class="dc">' + item.cause + '</div>');
      var dm = [];
      if (item.handler) dm.push('&#128736; ' + item.handler);
      if (item.reporter) dm.push('&#128221; ' + item.reporter);
      if (dm.length > 0) H.push('<div class="alert-meta">' + dm.map(function(m){return '<span>'+m+'</span>';}).join('') + '</div>');
      H.push('</div></div>');
    });
    H.push('</div></div></div>');
  });
  H.push('</div>');
}

// Summary
var sums = d.summary || [];
if (sums.length > 0) {
  H.push('<h3 class="sec-t" style="margin-top:32px">分析总结</h3><div class="smg">');
  sums.forEach(function(s) {
    var bg = (s.color || "#1E6FD9") + "22";
    H.push('<div class="smc"><div class="smi" style="background:'+bg+';color:'+s.color+'">&#9679;</div>');
    H.push('<div style="font-size:0.9rem">' + s.text + '</div></div>');
  });
  H.push('</div>');
}

// Document Links (溯源报告、运维文档)
var dls = d.docLinks || [];
if (dls.length > 0) {
  H.push('<h3 class="sec-t" style="margin-top:32px">相关文档链接</h3>');
  H.push('<div class="doc-list">');
  dls.forEach(function(dl) {
    var label = dl.url;
    if (dl.url.indexOf('yuque') >= 0) label = '语雀文档';
    else if (dl.url.indexOf('tapd') >= 0) label = 'TAPD 链接';
    else { var parts = dl.url.split("/"); if (parts.length > 0) label = parts[parts.length - 1] || dl.url; }
    H.push('<div class="doc-card"><div>');
    H.push('<a href="' + dl.url + '" target="_blank" rel="noopener">' + label + ' &rarr;</a>');
    if (dl.fromBug) H.push('<div class="doc-from">来自: ' + dl.fromBug + '</div>');
    H.push('</div></div>');
  });
  H.push('</div>');
}

// Editable: 缺陷总结 (会后补充)
H.push('<div class="edit-sec"><h4>缺陷总结</h4>');
H.push('<div class="edit-area" contenteditable="true" data-placeholder="会后在此补充缺陷总结要点...&#10;&#10;示例：&#10;1. 复合根因占比高：技术分析不足与测试覆盖不足超30%缺陷由多环节共同导致&#10;2. 发布规范问题突出&#10;3. 无效反馈仍较多，占用研发团队大量时间"></div>');
H.push('<div class="edit-hint">* 此区域可直接编辑，内容仅保存在当前页面中（建议编辑后 Ctrl+S 保存网页）</div>');
H.push('</div>');

// Editable: 改进措施 (会后补充)
H.push('<div class="edit-sec"><h4>改进措施</h4>');
H.push('<div id="improveList"></div>');
H.push('<div style="margin-top:12px;display:flex;gap:8px">');
H.push('<input id="improveInput" type="text" placeholder="输入改进措施后按 Enter 添加..." style="flex:1;background:var(--elev);border:1px solid var(--bdr);border-radius:6px;padding:8px 12px;color:var(--t1);font-size:0.85rem;outline:none">');
H.push('<select id="improveTag" style="background:var(--elev);border:1px solid var(--bdr);border-radius:6px;padding:8px;color:var(--t1);font-size:0.8rem;outline:none">');
H.push('<option value="流程">流程</option><option value="测试">测试</option><option value="监控">监控</option><option value="运维">运维</option>');
H.push('<option value="规范">规范</option><option value="安全">安全</option><option value="代码">代码</option><option value="性能">性能</option><option value="质量">质量</option>');
H.push('</select></div>');
H.push('<div class="edit-hint">* 输入改进措施后按 Enter 添加到列表，点击复选框标记完成</div>');
H.push('</div>');

H.push('</div></div>');
H.push('<footer class="ft"><div class="ctn">' + (d.generatedAt||"") + ' | 由工作流自动生成</div></footer>');

// ECharts init
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('var dom=document.getElementById("sevChart");');
H.push('if(dom&&typeof echarts!=="undefined"){');
H.push('var ch=echarts.init(dom,null,{renderer:"canvas"});');
H.push('ch.setOption({');
H.push('tooltip:{trigger:"item",backgroundColor:"rgba(22,27,34,0.95)",borderColor:"#30363D",textStyle:{color:"#E6EDF3"}},');
H.push('legend:{orient:"vertical",right:10,top:"center",textStyle:{color:"#7D8590",fontSize:12},itemGap:14},');
H.push('series:[{type:"pie",radius:["50%","75%"],center:["40%","50%"],avoidLabelOverlap:false,');
H.push('itemStyle:{borderRadius:6,borderColor:"#161B22",borderWidth:3},');
H.push('label:{show:false},emphasis:{label:{show:true,fontSize:14,fontWeight:"bold",color:"#E6EDF3"}},');
H.push('data:[');
H.push('{value:' + (sev.P0||0) + ',name:"P0 致命",itemStyle:{color:"#E84040"}},');
H.push('{value:' + (sev.P1||0) + ',name:"P1 重大",itemStyle:{color:"#F5A623"}},');
H.push('{value:' + (sev.P2||0) + ',name:"P2 严重",itemStyle:{color:"#FF6B35"}},');
H.push('{value:' + (sev.P3||0) + ',name:"P3 一般",itemStyle:{color:"#1E6FD9"}},');
H.push('{value:' + (sev.P4||0) + ',name:"P4 轻微",itemStyle:{color:"#4ECDC4"}}');
H.push(']}]});');
H.push('window.addEventListener("resize",function(){ch.resize();});');
H.push('}');
// Improvement list interaction
H.push('var iList=document.getElementById("improveList");');
H.push('var iInput=document.getElementById("improveInput");');
H.push('var iTag=document.getElementById("improveTag");');
H.push('var iCount=0;');
H.push('function addImproveItem(text,tag){');
H.push('  iCount++;var d=document.createElement("div");d.className="improve-item";');
H.push('  var cb=document.createElement("div");cb.className="improve-cb";');
H.push('  cb.onclick=function(){this.classList.toggle("checked")};');
H.push('  var tg=document.createElement("span");tg.className="improve-tag";tg.textContent="["+tag+"]";');
H.push('  var tx=document.createElement("span");tx.style.cssText="flex:1;font-size:0.85rem";tx.textContent=iCount+". "+text;');
H.push('  d.appendChild(cb);d.appendChild(tg);d.appendChild(tx);iList.appendChild(d);');
H.push('}');
H.push('if(iInput){iInput.addEventListener("keydown",function(e){');
H.push('  if(e.key==="Enter"&&this.value.trim()){addImproveItem(this.value.trim(),iTag.value);this.value="";}');
H.push('});}');
H.push('});');
H.push(SE);
H.push('</body></html>');
result = H.join("\\n");`,
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
// 注册表
// ═══════════════════════════════════════════════════════════════

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  tapdBugCollectionTemplate,
  qualityMonthlyTemplate as WorkflowTemplate,
  smartHttpTemplate,
];
