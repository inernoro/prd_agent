// ═══ 产品专业委员会月报 HTML 渲染模板 ═══
// 消费合并后的 4 章节数据 + LLM 分析文本，生成完整月报
// 数据结构: { input1: "LLM分析文本", input2: { input1: storyStats, input2: defectStats, input3: inspectionData, input4: rectificationData } }

export const committeeMonthlyHtmlGenCode = `var raw = Array.isArray(data) ? data[0] : data;
// XSS 防护：所有用户来源字段（TAPD 标题、处理人、LLM 文本、CSV 内容等）拼接 HTML 前必须走 esc()
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// URL 属性防注入：只允许 http:// 或 https:// 开头，其它（javascript:/data:/vbscript:）一律返回 '#'
function escUrl(u) {
  var s = String(u == null ? "" : u).trim().toLowerCase();
  if (s.indexOf("http://") !== 0 && s.indexOf("https://") !== 0) return "#";
  return esc(String(u).trim());
}
// JSON.stringify 输出在 <script> 块中使用时，必须转义 < 为 \\u003c，
// 否则用户数据含 </script> 会跳出脚本上下文注入 HTML/JS。
function safeJson(v) { return JSON.stringify(v).replace(/</g, "\\\\u003c"); }
// merge-final 输出的 key 是 artifact Name: "报告"(LLM文本) 和 "合并结果"(统计数据)
// 兼容 input1/input2 和中文 key 两种情况
var analysis = "";
var stats = {};
var keys = Object.keys(raw || {});
keys.forEach(function(k) {
  var v = raw[k];
  if (typeof v === "string" && v.length > 20) analysis = v;
  else if (typeof v === "object" && v !== null) stats = v;
});
if (!analysis) analysis = raw.input1 || raw["报告"] || "";
if (!stats || Object.keys(stats).length === 0) stats = raw.input2 || raw["合并结果"] || {};
var story = stats.input1 || { total:0, statusDistribution:{}, handlerDistribution:{}, priorityDistribution:{}, customerAnalysis:[], details:[] };
var defect = stats.input2 || { total:0, statusDistribution:{}, categoryDistribution:{}, handlerDistribution:{}, priorityDistribution:{}, severityDistribution:{}, details:[] };
var inspection = stats.input3 || { items:[] };
var rectification = stats.input4 || { total:0, closed:0, open:0, items:[] };

// 解析 LLM 分析文本，按章节拆分
var aiSections = {};
var curKey = "";
analysis.split("\\n").forEach(function(line) {
  if (line.indexOf("## 需求分析") >= 0 || line.indexOf("## 一、") >= 0) curKey = "story";
  else if (line.indexOf("## 产品缺陷") >= 0 || line.indexOf("## 二、") >= 0) curKey = "defect";
  else if (line.indexOf("## 月度巡检") >= 0 || line.indexOf("## 三、") >= 0) curKey = "inspection";
  else if (line.indexOf("## 专项整改") >= 0 || line.indexOf("## 四、") >= 0) curKey = "rectification";
  else if (curKey) {
    if (!aiSections[curKey]) aiSections[curKey] = [];
    if (line.trim()) aiSections[curKey].push(line);
  }
});

var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>产品专业委员会月报</title>');
H.push('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');

// ── CSS ──
H.push(':root{--bg:#0D1117;--card:#161B22;--elev:#1C2128;--bdr:#30363D;--t1:#E6EDF3;--t2:#7D8590;--t3:#484F58;--blue:#1E6FD9;--orange:#F5A623;--green:#27C97F;--red:#E84040;--cyan:#4ECDC4;--purple:#8B5CF6}');
H.push('*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Noto Sans SC",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;min-height:100vh}');
H.push('.ctn{max-width:1400px;margin:0 auto;padding:0 24px}');

// Nav
H.push('.nav{position:sticky;top:0;z-index:100;background:rgba(13,17,23,0.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--bdr);padding:0 24px}');
H.push('.nav-in{max-width:1400px;margin:0 auto;display:flex;align-items:center;height:56px;gap:16px}');
H.push('.logo{width:32px;height:32px;background:linear-gradient(135deg,var(--blue),var(--cyan));border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px}');
H.push('.nav-t{font-weight:700;font-size:1rem;white-space:nowrap}');
H.push('.tabs{display:flex;gap:4px;margin-left:auto}');
H.push('.tab{padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.82rem;font-weight:600;color:var(--t2);transition:0.2s;border:1px solid transparent}');
H.push('.tab:hover{color:var(--t1);background:rgba(30,111,217,0.08)}.tab.active{color:var(--blue);background:rgba(30,111,217,0.12);border-color:rgba(30,111,217,0.3)}');

// Sections
H.push('.sec{padding:32px 0}.sec-t{font-size:1.2rem;font-weight:700;margin-bottom:20px;background:linear-gradient(135deg,var(--t1),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}');
H.push('.panel{display:none}.panel.active{display:block}');

// KPI
H.push('.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:18px;transition:0.3s;position:relative;overflow:hidden}');
H.push('.kpi:hover{transform:translateY(-3px);box-shadow:0 6px 20px rgba(0,0,0,0.3)}');
H.push('.kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-c,var(--blue));opacity:0;transition:0.3s}.kpi:hover::before{opacity:1}');
H.push('.kpi-l{font-size:0.75rem;color:var(--t2);margin-bottom:4px;font-weight:600}.kpi-v{font-size:2.4rem;font-weight:700;line-height:1}');

// Chart
H.push('.cg{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:24px}');
H.push('.cc{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px}.cc h3{font-size:0.9rem;margin-bottom:14px;font-weight:600}');
H.push('.chart-box{width:100%;height:280px}');

// Table
H.push('.tbl-wrap{overflow-x:auto;margin-bottom:20px}');
H.push('table.dt{width:100%;border-collapse:collapse;font-size:0.8rem}');
H.push('table.dt th{background:var(--elev);color:var(--t2);font-weight:600;padding:8px 10px;text-align:left;border-bottom:2px solid var(--bdr);white-space:nowrap}');
H.push('table.dt td{padding:8px 10px;border-bottom:1px solid var(--bdr);vertical-align:top}');
H.push('table.dt tr:hover td{background:rgba(30,111,217,0.06)}');
H.push('table.dt a{color:var(--blue);text-decoration:none}table.dt a:hover{text-decoration:underline}');

// Tags
H.push('.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:0.65rem;font-weight:600}');
H.push('.tag-r{background:rgba(232,64,64,0.15);color:#E84040}.tag-o{background:rgba(245,166,35,0.15);color:#F5A623}');
H.push('.tag-g{background:rgba(39,201,127,0.15);color:#27C97F}.tag-b{background:rgba(30,111,217,0.15);color:#1E6FD9}');
H.push('.tag-c{background:rgba(78,205,196,0.15);color:#4ECDC4}.tag-gr{background:rgba(125,133,144,0.15);color:#7D8590}');

// Rate bar
H.push('.rb{display:flex;align-items:center;gap:8px;margin-bottom:8px}.rb-t{flex:1;height:8px;background:var(--elev);border-radius:4px;overflow:hidden}');
H.push('.rb-f{height:100%;border-radius:4px}.rb-v{font-weight:700;font-size:0.85rem;min-width:48px;text-align:right}');

// AI insights
H.push('.ai-box{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;margin-top:20px}');
H.push('.ai-box h3{font-size:0.95rem;font-weight:700;margin-bottom:12px;color:var(--cyan)}');
H.push('.ai-line{padding:6px 0;font-size:0.85rem;color:var(--t1);line-height:1.6;border-bottom:1px solid rgba(48,54,61,0.5)}');
H.push('.ai-line:last-child{border:none}');

// Footer
H.push('.ft{text-align:center;padding:32px 0;border-top:1px solid var(--bdr);color:var(--t2);font-size:0.78rem}');
H.push('@media(max-width:900px){.cg{grid-template-columns:1fr}.kg{grid-template-columns:repeat(2,1fr)}}');

H.push('</style></head><body>');

// ── Nav ──
var sections = ["需求分析","产品缺陷","月度巡检","专项整改"];
var panelIds = ["story","defect","inspection","rectification"];
H.push('<nav class="nav"><div class="nav-in"><div class="logo">P</div>');
H.push('<span class="nav-t">产品专业委员会月报</span>');
H.push('<div class="tabs" id="tabs">');
sections.forEach(function(s,i){
  H.push('<div class="tab'+(i===0?' active':'')+'" data-panel="'+panelIds[i]+'" onclick="sw(this)">'+s+'</div>');
});
H.push('</div></div></nav>');

// ── 辅助函数 ──
function renderKpi(label, value, color) {
  H.push('<div class="kpi" style="--kpi-c:'+color+'"><div class="kpi-l">'+label+'</div><div class="kpi-v" style="color:'+color+'">'+value+'</div></div>');
}
function renderAiInsights(key) {
  var lines = aiSections[key] || [];
  if (lines.length === 0) return;
  H.push('<div class="ai-box"><h3>AI 分析与启发</h3>');
  lines.forEach(function(l) { H.push('<div class="ai-line">'+esc(l)+'</div>'); });
  H.push('</div>');
}
function mapKeys(obj) { return Object.keys(obj || {}); }
function mapVals(obj) { var ks=Object.keys(obj||{}); return ks.map(function(k){return obj[k];}); }

// ════════════════════════════════════════════
// Panel 1: 需求分析
// ════════════════════════════════════════════
H.push('<div class="panel active" id="p-story"><div class="sec"><div class="ctn">');
H.push('<h2 class="sec-t">一、需求分析</h2>');

// KPIs
var stKeys = mapKeys(story.statusDistribution);
var rejCount = 0;
stKeys.forEach(function(k) { if (k.indexOf("拒绝") >= 0) rejCount += story.statusDistribution[k]; });
H.push('<div class="kg">');
renderKpi("需求总数", story.total, "#1E6FD9");
renderKpi("状态类型数", stKeys.length, "#4ECDC4");
renderKpi("已拒绝", rejCount, rejCount > 0 ? "#E84040" : "#27C97F");
renderKpi("涉及客户数", (story.customerAnalysis || []).length, "#8B5CF6");
H.push('</div>');

// Charts
H.push('<div class="cg">');
H.push('<div class="cc"><h3>状态分布</h3><div class="chart-box" id="ch-st-status"></div></div>');
H.push('<div class="cc"><h3>优先级分布</h3><div class="chart-box" id="ch-st-priority"></div></div>');
H.push('</div>');
H.push('<div class="cg">');
H.push('<div class="cc"><h3>处理人分布</h3><div class="chart-box" id="ch-st-handler"></div></div>');
H.push('<div class="cc"><h3>客户需求 TOP10</h3><div class="chart-box" id="ch-st-customer"></div></div>');
H.push('</div>');

// Customer table
var custs = story.customerAnalysis || [];
if (custs.length > 0) {
  H.push('<h3 class="sec-t">客户需求明细</h3>');
  H.push('<div class="tbl-wrap"><table class="dt"><thead><tr><th>客户</th><th>需求数</th><th>需求摘要</th></tr></thead><tbody>');
  custs.forEach(function(c) {
    var titlesEsc = (c.titles || []).map(esc).join('；');
    H.push('<tr><td><strong>'+esc(c.name)+'</strong></td><td>'+esc(c.count)+'</td><td style="max-width:500px">'+titlesEsc+'</td></tr>');
  });
  H.push('</tbody></table></div>');
}

// Detail table
H.push('<h3 class="sec-t">需求明细列表</h3>');
H.push('<div class="tbl-wrap"><table class="dt"><thead><tr><th>#</th><th>标题</th><th>处理人</th><th>状态</th><th>优先级</th><th>创建时间</th><th>链接</th></tr></thead><tbody>');
(story.details || []).forEach(function(d, i) {
  H.push('<tr><td>'+(i+1)+'</td><td>'+esc(d.title)+'</td><td>'+esc(d.handler)+'</td>');
  H.push('<td><span class="tag tag-b">'+esc(d.status)+'</span></td>');
  H.push('<td><span class="tag tag-o">'+esc(d.priority)+'</span></td>');
  H.push('<td style="white-space:nowrap">'+esc(d.createdAt)+'</td>');
  H.push('<td>'+(d.url?'<a href="'+escUrl(d.url)+'" target="_blank" rel="noopener noreferrer">查看</a>':'-')+'</td></tr>');
});
H.push('</tbody></table></div>');
renderAiInsights("story");
H.push('</div></div></div>');

// ════════════════════════════════════════════
// Panel 2: 产品缺陷分析
// ════════════════════════════════════════════
H.push('<div class="panel" id="p-defect"><div class="sec"><div class="ctn">');
H.push('<h2 class="sec-t">二、产品缺陷分析</h2>');

H.push('<div class="kg">');
renderKpi("缺陷总数", defect.total, "#E84040");
renderKpi("分类数", mapKeys(defect.categoryDistribution).length, "#F5A623");
renderKpi("处理人数", mapKeys(defect.handlerDistribution).length, "#1E6FD9");
renderKpi("状态类型数", mapKeys(defect.statusDistribution).length, "#4ECDC4");
H.push('</div>');

H.push('<div class="cg">');
H.push('<div class="cc"><h3>产品分类分布</h3><div class="chart-box" id="ch-df-category"></div></div>');
H.push('<div class="cc"><h3>状态分布</h3><div class="chart-box" id="ch-df-status"></div></div>');
H.push('</div>');
H.push('<div class="cg">');
H.push('<div class="cc"><h3>优先级分布</h3><div class="chart-box" id="ch-df-priority"></div></div>');
H.push('<div class="cc"><h3>严重程度分布</h3><div class="chart-box" id="ch-df-severity"></div></div>');
H.push('</div>');
H.push('<div class="cg">');
H.push('<div class="cc" style="grid-column:span 2"><h3>处理人分布</h3><div class="chart-box" id="ch-df-handler"></div></div>');
H.push('</div>');

// Detail table
H.push('<h3 class="sec-t">缺陷明细列表</h3>');
H.push('<div class="tbl-wrap"><table class="dt"><thead><tr><th>#</th><th>标题</th><th>分类</th><th>处理人</th><th>状态</th><th>优先级</th><th>严重程度</th><th>创建时间</th><th>链接</th></tr></thead><tbody>');
(defect.details || []).forEach(function(d, i) {
  H.push('<tr><td>'+(i+1)+'</td><td>'+esc(d.title)+'</td><td><span class="tag tag-c">'+esc(d.category||'-')+'</span></td>');
  H.push('<td>'+esc(d.handler)+'</td><td><span class="tag tag-b">'+esc(d.status)+'</span></td>');
  H.push('<td><span class="tag tag-o">'+esc(d.priority)+'</span></td>');
  H.push('<td><span class="tag tag-r">'+esc(d.severity||'-')+'</span></td>');
  H.push('<td style="white-space:nowrap">'+esc(d.createdAt)+'</td>');
  H.push('<td>'+(d.url?'<a href="'+escUrl(d.url)+'" target="_blank" rel="noopener noreferrer">查看</a>':'-')+'</td></tr>');
});
H.push('</tbody></table></div>');
renderAiInsights("defect");
H.push('</div></div></div>');

// ════════════════════════════════════════════
// Panel 3: 月度巡检
// ════════════════════════════════════════════
H.push('<div class="panel" id="p-inspection"><div class="sec"><div class="ctn">');
H.push('<h2 class="sec-t">三、月度巡检情况</h2>');

var insItems = inspection.items || [];
var totalTimely = 0, totalAll = 0;
insItems.forEach(function(it) { totalTimely += (it.timely||0); totalAll += (it.total||0); });
var overallRate = totalAll > 0 ? parseFloat((totalTimely/totalAll*100).toFixed(1)) : 0;

H.push('<div class="kg">');
renderKpi("巡检项目数", insItems.length, "#1E6FD9");
renderKpi("总体及时率", overallRate+"%", overallRate>=90?"#27C97F":overallRate>=80?"#F5A623":"#E84040");
renderKpi("及时/总数", totalTimely+"/"+totalAll, "#4ECDC4");
renderKpi("不及时数", totalAll-totalTimely, (totalAll-totalTimely)>0?"#E84040":"#27C97F");
H.push('</div>');

H.push('<div class="cg">');
H.push('<div class="cc"><h3>各项及时率</h3><div class="chart-box" id="ch-ins-rate"></div></div>');
H.push('<div class="cc"><h3>及时/不及时分布</h3><div class="chart-box" id="ch-ins-bar"></div></div>');
H.push('</div>');

// Per-item detail
insItems.forEach(function(it, idx) {
  var rate = it.total > 0 ? parseFloat((it.timely/it.total*100).toFixed(1)) : 0;
  var rc = rate>=90?"#27C97F":rate>=80?"#F5A623":"#E84040";
  H.push('<div style="background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;margin-bottom:14px">');
  H.push('<h3 style="font-size:0.95rem;margin-bottom:12px">'+(idx+1)+'. '+esc(it.name)+'</h3>');
  H.push('<div class="kg" style="grid-template-columns:repeat(4,1fr)">');
  renderKpi("总数",it.total,"#1E6FD9");
  renderKpi("及时",it.timely,"#27C97F");
  renderKpi("不及时",it.total-it.timely,(it.total-it.timely)>0?"#E84040":"#27C97F");
  renderKpi("及时率",rate+"%",rc);
  H.push('</div>');
  H.push('<div class="rb"><div class="rb-t"><div class="rb-f" style="width:'+rate+'%;background:'+rc+'"></div></div><div class="rb-v" style="color:'+rc+'">'+rate+'%</div></div>');
  if (it.details && it.details.length > 0) {
    H.push('<div class="tbl-wrap"><table class="dt"><thead><tr><th>责任人</th><th>总数</th><th>及时</th><th>不及时</th><th>及时率</th></tr></thead><tbody>');
    it.details.forEach(function(dt) {
      var dr = dt.total>0?parseFloat((dt.timely/dt.total*100).toFixed(1)):0;
      H.push('<tr><td>'+esc(dt.person)+'</td><td>'+dt.total+'</td><td>'+dt.timely+'</td><td>'+(dt.total-dt.timely)+'</td><td>'+dr+'%</td></tr>');
    });
    H.push('</tbody></table></div>');
  }
  if (it.url) H.push('<div style="margin-top:6px;font-size:0.78rem"><a href="'+escUrl(it.url)+'" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">查看明细表</a></div>');
  H.push('</div>');
});
renderAiInsights("inspection");
H.push('</div></div></div>');

// ════════════════════════════════════════════
// Panel 4: 专项整改
// ════════════════════════════════════════════
H.push('<div class="panel" id="p-rectification"><div class="sec"><div class="ctn">');
H.push('<h2 class="sec-t">四、产品专项整改</h2>');

var rItems = rectification.items || [];
var rClosed = rItems.filter(function(r){return r.closed;}).length;
H.push('<div class="kg">');
renderKpi("专项总数", rItems.length, "#1E6FD9");
renderKpi("已办结", rClosed, "#27C97F");
renderKpi("未办结", rItems.length-rClosed, (rItems.length-rClosed)>0?"#E84040":"#27C97F");
var closedRate = rItems.length>0?parseFloat((rClosed/rItems.length*100).toFixed(1)):0;
renderKpi("办结率", closedRate+"%", closedRate>=80?"#27C97F":"#F5A623");
H.push('</div>');

H.push('<div class="tbl-wrap"><table class="dt"><thead><tr><th>#</th><th>问题(简要说明)</th><th>提出时间</th><th>逻辑归因</th><th>结构归母</th><th>责任人</th><th>解决计划</th><th>进度</th><th>办结</th><th>备注</th></tr></thead><tbody>');
rItems.forEach(function(r, i) {
  var cls = r.closed ? 'tag-g' : 'tag-r';
  H.push('<tr><td>'+(i+1)+'</td><td>'+esc(r.problem)+'</td><td style="white-space:nowrap">'+esc(r.raisedAt)+'</td>');
  H.push('<td>'+esc(r.logicCause)+'</td><td>'+esc(r.structCause)+'</td><td>'+esc(r.owner)+'</td>');
  H.push('<td>'+esc(r.plan)+'</td><td>'+esc(r.progress)+'</td>');
  H.push('<td><span class="tag '+cls+'">'+(r.closed?"是":"否")+'</span></td>');
  H.push('<td>'+esc(r.remark)+'</td></tr>');
});
H.push('</tbody></table></div>');
renderAiInsights("rectification");
H.push('</div></div></div>');

// ── Footer ──
H.push('<footer class="ft"><div class="ctn">产品专业委员会月报 | 由工作流自动生成</div></footer>');

// ── Tab Switch JS ──
H.push(S);
H.push('function sw(el){document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")});el.classList.add("active");document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active")});var p=document.getElementById("p-"+el.getAttribute("data-panel"));if(p)p.classList.add("active");}');
H.push(SE);

// ── ECharts ──
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('if(typeof echarts==="undefined")return;');
H.push('var tt={backgroundColor:"rgba(22,27,34,0.95)",borderColor:"#30363D",textStyle:{color:"#E6EDF3"}};');

// Helper: pie chart
H.push('function pie(id,d,cs){var dom=document.getElementById(id);if(!dom)return;var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"item"},tt),legend:{orient:"vertical",right:10,top:"center",textStyle:{color:"#7D8590"},itemGap:10,type:"scroll"},series:[{type:"pie",radius:["42%","72%"],center:["38%","50%"],padAngle:2,itemStyle:{borderRadius:5,borderColor:"#161B22",borderWidth:2},label:{show:false},data:d,color:cs}]});window.addEventListener("resize",function(){ch.resize()});}');

// Helper: bar chart (horizontal)
H.push('function hbar(id,names,vals,color){var dom=document.getElementById(id);if(!dom)return;var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),grid:{left:"3%",right:"8%",bottom:"3%",containLabel:true},xAxis:{type:"value",axisLabel:{color:"#7D8590"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},yAxis:{type:"category",data:names,axisLabel:{fontSize:11,color:"#7D8590"}},series:[{type:"bar",data:vals,itemStyle:{color:color,borderRadius:[0,4,4,0]},barMaxWidth:22,label:{show:true,position:"right",fontSize:10,color:"#7D8590"}}]});window.addEventListener("resize",function(){ch.resize()});}');

// ── Chapter 1 charts ──
var stStatusD = [];
var stColors = ["#1E6FD9","#27C97F","#E84040","#F5A623","#4ECDC4","#8B5CF6","#FF6B35","#7D8590"];
var stStatusKeys = Object.keys(story.statusDistribution || {});
stStatusKeys.forEach(function(k,i){ stStatusD.push({name:esc(k),value:story.statusDistribution[k]}); });
H.push('pie("ch-st-status",' + safeJson(stStatusD) + ',' + safeJson(stColors) + ');');

var stPrD = [];
var prColors = ["#E84040","#F5A623","#1E6FD9","#4ECDC4","#7D8590"];
var stPrKeys = Object.keys(story.priorityDistribution || {});
stPrKeys.forEach(function(k,i){ stPrD.push({name:esc(k),value:story.priorityDistribution[k]}); });
H.push('pie("ch-st-priority",' + safeJson(stPrD) + ',' + safeJson(prColors) + ');');

var hdRawKeys = Object.keys(story.handlerDistribution || {}).sort(function(a,b){return story.handlerDistribution[a]-story.handlerDistribution[b];});
var hdKeys = hdRawKeys.map(esc);
var hdVals = hdRawKeys.map(function(k){return story.handlerDistribution[k];});
H.push('hbar("ch-st-handler",' + safeJson(hdKeys) + ',' + safeJson(hdVals) + ',"#1E6FD9");');

var custTop = (story.customerAnalysis || []).slice(0,10);
var custNames = custTop.map(function(c){return esc(c.name);}).reverse();
var custVals = custTop.map(function(c){return c.count;}).reverse();
H.push('hbar("ch-st-customer",' + safeJson(custNames) + ',' + safeJson(custVals) + ',"#4ECDC4");');

// ── Chapter 2 charts ──
var dfCatD = [];
var dfCatKeys = Object.keys(defect.categoryDistribution || {});
dfCatKeys.forEach(function(k){ dfCatD.push({name:esc(k),value:defect.categoryDistribution[k]}); });
H.push('pie("ch-df-category",' + safeJson(dfCatD) + ',' + safeJson(stColors) + ');');

var dfStD = [];
var dfStKeys = Object.keys(defect.statusDistribution || {});
dfStKeys.forEach(function(k){ dfStD.push({name:esc(k),value:defect.statusDistribution[k]}); });
H.push('pie("ch-df-status",' + safeJson(dfStD) + ',' + safeJson(stColors) + ');');

var dfPrD = [];
var dfPrKeys = Object.keys(defect.priorityDistribution || {});
dfPrKeys.forEach(function(k){ dfPrD.push({name:esc(k),value:defect.priorityDistribution[k]}); });
H.push('pie("ch-df-priority",' + safeJson(dfPrD) + ',' + safeJson(["#E84040","#FF6B35","#27C97F","#1E6FD9","#7D8590"]) + ');');

var dfSvD = [];
var dfSvKeys = Object.keys(defect.severityDistribution || {});
dfSvKeys.forEach(function(k){ dfSvD.push({name:esc(k),value:defect.severityDistribution[k]}); });
H.push('pie("ch-df-severity",' + safeJson(dfSvD) + ',' + safeJson(["#E84040","#F5A623","#FF6B35","#1E6FD9","#4ECDC4"]) + ');');

var dfHdRawKeys = Object.keys(defect.handlerDistribution || {}).sort(function(a,b){return defect.handlerDistribution[a]-defect.handlerDistribution[b];});
var dfHdKeys = dfHdRawKeys.map(esc);
var dfHdVals = dfHdRawKeys.map(function(k){return defect.handlerDistribution[k];});
H.push('hbar("ch-df-handler",' + safeJson(dfHdKeys) + ',' + safeJson(dfHdVals) + ',"#F5A623");');

// ── Chapter 3 charts ──
var insNames = insItems.map(function(it){return esc(it.name||"");});
var insRates = insItems.map(function(it){return it.total>0?parseFloat((it.timely/it.total*100).toFixed(1)):0;});
var insTimely = insItems.map(function(it){return it.timely||0;});
var insUntimely = insItems.map(function(it){return (it.total||0)-(it.timely||0);});

// Rate bar chart
H.push('(function(){var dom=document.getElementById("ch-ins-rate");if(!dom)return;var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis",formatter:function(p){return p[0].name+"<br/>及时率: "+p[0].value+"%";}},tt),grid:{top:20,bottom:30,left:10,right:30,containLabel:true},xAxis:{type:"category",data:'+safeJson(insNames)+',axisLabel:{fontSize:10,color:"#7D8590",rotate:15}},yAxis:{type:"value",max:100,axisLabel:{color:"#7D8590",formatter:"{value}%"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},series:[{type:"bar",data:'+safeJson(insRates)+',itemStyle:{color:function(p){return p.value>=90?"#27C97F":p.value>=80?"#F5A623":"#E84040";},borderRadius:[4,4,0,0]},barMaxWidth:36,label:{show:true,position:"top",formatter:"{c}%",fontSize:10,color:"#7D8590"}}]});window.addEventListener("resize",function(){ch.resize()});})();');

// Stacked bar
H.push('(function(){var dom=document.getElementById("ch-ins-bar");if(!dom)return;var ch=echarts.init(dom);ch.setOption({tooltip:Object.assign({trigger:"axis"},tt),legend:{textStyle:{color:"#7D8590"},bottom:0},grid:{top:20,bottom:40,left:10,right:20,containLabel:true},xAxis:{type:"category",data:'+safeJson(insNames)+',axisLabel:{fontSize:10,color:"#7D8590",rotate:15}},yAxis:{type:"value",axisLabel:{color:"#7D8590"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},series:[{name:"及时",type:"bar",stack:"t",data:'+safeJson(insTimely)+',itemStyle:{color:"#27C97F"},barMaxWidth:36},{name:"不及时",type:"bar",stack:"t",data:'+safeJson(insUntimely)+',itemStyle:{color:"#E84040"},barMaxWidth:36}]});window.addEventListener("resize",function(){ch.resize()});})();');

H.push('});');
H.push(SE);

H.push('</body></html>');
result = H.join("\\n");
`;
