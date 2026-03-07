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
        handler: i["处理人"] || i["当前处理人"] || ""
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

// P0/P1 警告
var critAlerts = [];
p0.forEach(function(i) { critAlerts.push({level:"P0",title:i["标题"]||i.title||"",desc:i["逻辑归因"]||""}); });
p1.forEach(function(i) { critAlerts.push({level:"P1",title:i["标题"]||i.title||"",desc:i["逻辑归因"]||""}); });

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
  defectDetails: defectDetails,
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
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/chart.js">') + SE);
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
H.push('.alert-t{font-weight:600;color:var(--red)}.alert-d{font-size:0.8rem;color:var(--t2);margin-top:2px}');
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
    H.push('<div class="alert"><span class="alert-b">' + a.level + '</span><div>');
    H.push('<div class="alert-t">' + a.title + '</div>');
    if (a.desc) H.push('<div class="alert-d">' + a.desc + '</div>');
    H.push('</div></div>');
  });
}

// Charts
var sev = d.severity || {};
H.push('<div class="cg">');
H.push('<div class="cc"><h3>缺陷级别分布</h3><div style="max-width:350px;margin:0 auto"><canvas id="sevChart"></canvas></div></div>');
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
      H.push('<div class="di">' + (ii+1) + '</div><div>');
      H.push('<div>' + item.desc + '</div>');
      if (item.cause) H.push('<div class="dc">' + item.cause + '</div>');
      if (item.handler) H.push('<span class="dh">' + item.handler + '</span>');
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

H.push('</div></div>');
H.push('<footer class="ft"><div class="ctn">' + (d.generatedAt||"") + ' | 由工作流自动生成</div></footer>');

// Chart.js init
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('var ctx=document.getElementById("sevChart");');
H.push('if(ctx){new Chart(ctx,{type:"doughnut",data:{');
H.push('labels:["P0 致命","P1 重大","P2 严重","P3 一般","P4 轻微"],');
H.push('datasets:[{data:[' + (sev.P0||0)+','+(sev.P1||0)+','+(sev.P2||0)+','+(sev.P3||0)+','+(sev.P4||0) + '],');
H.push('backgroundColor:["#E84040","#F5A623","#FF6B35","#1E6FD9","#4ECDC4"],borderColor:"#161B22",borderWidth:3}]},');
H.push('options:{responsive:true,cutout:"60%",plugins:{legend:{position:"right",labels:{color:"#7D8590",usePointStyle:true,padding:12}}}}');
H.push('});}});');
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
// 注册表
// ═══════════════════════════════════════════════════════════════

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  tapdBugCollectionTemplate,
  smartHttpTemplate,
  smartHttpAcceptanceTemplate,
  apiReviewWorkflowTemplate,
];
