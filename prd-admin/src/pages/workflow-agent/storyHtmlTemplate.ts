// ═══ TAPD 需求分析报告 HTML 渲染模板 ═══
// 消费 n-agg 输出的结构化 JSON，生成专业级需求分析报告
// 数据字段: title, generatedAt, total, kpis, statusDistribution, handlerDistribution,
//           priorityDistribution, customerAnalysis, storyDetails, summary

export const storyHtmlGenCode = `// data = upstream stats JSON
var d = Array.isArray(data) ? data[0] : data;
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';
var stMap = d.statusDistribution || {};
var hdMap = d.handlerDistribution || {};
var prMap = d.priorityDistribution || {};
var custs = d.customerAnalysis || [];
var details = d.storyDetails || [];
var sums = d.summary || [];
var kpis = d.kpis || [];

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>' + (d.title || '需求分析报告') + '</title>');
H.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
H.push('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');

// ── CSS Variables & Reset ──
H.push(':root{--bg:#F5F7FA;--card:#FFFFFF;--elev:#F0F2F5;--bdr:#E4E7ED;--t1:#1D2129;--t2:#4E5969;--t3:#86909C;--blue:#165DFF;--blue-bg:rgba(22,93,255,0.06);--orange:#FF7D00;--green:#00B42A;--red:#F53F3F;--cyan:#14C9C9;--purple:#722ED1;--header-bg:linear-gradient(135deg,#0B2447 0%,#19376D 40%,#576CBC 100%);--shadow:0 2px 8px rgba(0,0,0,0.06);--shadow-lg:0 4px 16px rgba(0,0,0,0.1)}');
H.push('*{box-sizing:border-box;margin:0;padding:0}');
H.push('body{font-family:"Noto Sans SC",-apple-system,sans-serif;background:var(--bg);color:var(--t1);line-height:1.7;min-height:100vh}');
H.push('.ctn{max-width:1200px;margin:0 auto;padding:0 32px}');

// ── Hero Header ──
H.push('.hero{background:var(--header-bg);padding:48px 0 40px;color:#fff;position:relative;overflow:hidden}');
H.push('.hero::after{content:"";position:absolute;top:0;right:0;width:300px;height:100%;background:radial-gradient(circle at 80% 50%,rgba(255,255,255,0.08) 0%,transparent 70%)}');
H.push('.hero-title{font-size:2rem;font-weight:700;letter-spacing:1px;margin-bottom:8px}');
H.push('.hero-sub{font-size:0.9rem;color:rgba(255,255,255,0.7);display:flex;gap:20px;flex-wrap:wrap}');
H.push('.hero-sub span{display:inline-flex;align-items:center;gap:6px}');
H.push('.hero-divider{width:48px;height:3px;background:linear-gradient(90deg,#A5D7E8,rgba(255,255,255,0.3));border-radius:2px;margin:16px 0}');

// ── Section ──
H.push('.sec{padding:32px 0}');
H.push('.sec-header{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid var(--blue)}');
H.push('.sec-header h2{font-size:1.25rem;font-weight:700;color:var(--t1)}');
H.push('.sec-header .sec-icon{width:28px;height:28px;background:var(--blue);border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700}');

// ── KPI Cards ──
H.push('.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:28px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:20px;text-align:center;box-shadow:var(--shadow);transition:all 0.2s}');
H.push('.kpi:hover{box-shadow:var(--shadow-lg);transform:translateY(-2px)}');
H.push('.kpi-label{font-size:0.78rem;color:var(--t3);font-weight:500;margin-bottom:8px}');
H.push('.kpi-val{font-size:2.2rem;font-weight:700;line-height:1;letter-spacing:-1px}');
H.push('.kpi-sub{font-size:0.7rem;color:var(--t3);margin-top:6px}');

// ── Card ──
H.push('.card{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:24px;box-shadow:var(--shadow);margin-bottom:16px}');
H.push('.card h3{font-size:1rem;font-weight:600;margin-bottom:16px;color:var(--t1)}');
H.push('.card-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}');

// ── Table ──
H.push('.tbl-wrap{overflow-x:auto;margin-top:12px}');
H.push('table.dtbl{width:100%;border-collapse:collapse;font-size:0.82rem}');
H.push('table.dtbl th{background:var(--elev);color:var(--t2);font-weight:600;padding:10px 12px;text-align:left;border-bottom:2px solid var(--bdr);white-space:nowrap}');
H.push('table.dtbl td{padding:10px 12px;border-bottom:1px solid var(--bdr);color:var(--t1);vertical-align:top}');
H.push('table.dtbl tr:hover td{background:var(--blue-bg)}');
H.push('table.dtbl a{color:var(--blue);text-decoration:none}table.dtbl a:hover{text-decoration:underline}');

// ── Tags ──
H.push('.tag{display:inline-block;padding:1px 8px;border-radius:4px;font-size:0.68rem;font-weight:600}');
H.push('.tag-high{background:rgba(245,63,63,0.12);color:#F53F3F}');
H.push('.tag-middle{background:rgba(255,125,0,0.12);color:#FF7D00}');
H.push('.tag-low{background:rgba(22,93,255,0.08);color:#165DFF}');
H.push('.tag-rejected{background:rgba(134,144,156,0.12);color:#86909C}');
H.push('.tag-planned{background:rgba(20,201,201,0.08);color:#14C9C9}');
H.push('.tag-done{background:rgba(0,180,42,0.12);color:#00B42A}');

// ── Summary insight ──
H.push('.insight-list{display:flex;flex-direction:column;gap:10px}');
H.push('.insight-item{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--blue-bg);border-radius:8px;border-left:3px solid var(--blue);font-size:0.88rem}');
H.push('.insight-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:7px}');

// ── Footer ──
H.push('.footer{padding:24px 0;text-align:center;font-size:0.75rem;color:var(--t3);border-top:1px solid var(--bdr)}');

H.push('</style></head><body>');

// ── Hero ──
H.push('<div class="hero"><div class="ctn">');
H.push('<div class="hero-title">' + (d.title || '月度需求分析报告') + '</div>');
H.push('<div class="hero-divider"></div>');
H.push('<div class="hero-sub">');
H.push('<span>生成时间: ' + (d.generatedAt || '-') + '</span>');
H.push('<span>需求总数: ' + (d.total || 0) + ' 个</span>');
if (d.dateRange) H.push('<span>统计周期: ' + d.dateRange + '</span>');
H.push('</div></div></div>');

// ── KPI Cards ──
H.push('<div class="ctn"><div class="sec">');
H.push('<div class="sec-header"><div class="sec-icon">K</div><h2>核心指标</h2></div>');
H.push('<div class="kpi-grid">');
kpis.forEach(function(k) {
  H.push('<div class="kpi"><div class="kpi-label">' + k.label + '</div>');
  H.push('<div class="kpi-val" style="color:' + (k.color || 'var(--t1)') + '">');
  H.push(k.format === 'percent' ? k.value + '%' : k.value);
  H.push('</div>');
  if (k.sub) H.push('<div class="kpi-sub">' + k.sub + '</div>');
  H.push('</div>');
});
H.push('</div>');

// ── Charts (Status + Priority + Handler) ──
H.push('<div class="card-grid">');
H.push('<div class="card"><h3>需求状态分布</h3><div id="chart-status" style="height:300px"></div></div>');
H.push('<div class="card"><h3>优先级分布</h3><div id="chart-priority" style="height:300px"></div></div>');
H.push('</div>');
H.push('<div class="card-grid">');
H.push('<div class="card"><h3>处理人分布</h3><div id="chart-handler" style="height:300px"></div></div>');
H.push('<div class="card"><h3>客户需求分布 TOP10</h3><div id="chart-customer" style="height:300px"></div></div>');
H.push('</div>');

// ── Customer Analysis Table ──
if (custs.length > 0) {
  H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">C</div><h2>客户需求明细</h2></div>');
  H.push('<div class="card"><div class="tbl-wrap"><table class="dtbl">');
  H.push('<thead><tr><th>客户</th><th>需求数</th><th>需求摘要</th></tr></thead><tbody>');
  custs.forEach(function(c) {
    H.push('<tr><td><strong>' + c.name + '</strong></td><td>' + c.count + '</td><td>' + (c.titles || []).join('；') + '</td></tr>');
  });
  H.push('</tbody></table></div></div>');
}

// ── Story Detail Table ──
H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">D</div><h2>需求明细列表</h2></div>');
H.push('<div class="card"><div class="tbl-wrap"><table class="dtbl">');
H.push('<thead><tr><th>#</th><th>需求标题</th><th>处理人</th><th>状态</th><th>优先级</th><th>创建时间</th><th>链接</th></tr></thead><tbody>');
details.forEach(function(s, idx) {
  var stCls = '';
  var st = (s.status || '').toLowerCase();
  if (st.indexOf('拒绝') >= 0) stCls = 'tag-rejected';
  else if (st.indexOf('完成') >= 0 || st.indexOf('关闭') >= 0) stCls = 'tag-done';
  else if (st.indexOf('规划') >= 0) stCls = 'tag-planned';
  var prCls = '';
  var pr = (s.priority || '').toUpperCase();
  if (pr === 'HIGH') prCls = 'tag-high';
  else if (pr === 'MIDDLE') prCls = 'tag-middle';
  else prCls = 'tag-low';
  H.push('<tr><td>' + (idx + 1) + '</td>');
  H.push('<td>' + (s.title || '') + '</td>');
  H.push('<td>' + (s.handler || '') + '</td>');
  H.push('<td><span class="tag ' + stCls + '">' + (s.status || '-') + '</span></td>');
  H.push('<td><span class="tag ' + prCls + '">' + (s.priority || '-') + '</span></td>');
  H.push('<td style="white-space:nowrap">' + (s.createdAt || '') + '</td>');
  H.push('<td>' + (s.url ? '<a href="' + s.url + '" target="_blank">查看</a>' : '-') + '</td>');
  H.push('</tr>');
});
H.push('</tbody></table></div></div>');

// ── Summary Insights ──
if (sums.length > 0) {
  H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">S</div><h2>分析与启发</h2></div>');
  H.push('<div class="insight-list">');
  sums.forEach(function(s) {
    H.push('<div class="insight-item"><div class="insight-dot" style="background:' + (s.color || 'var(--blue)') + '"></div><span>' + s.text + '</span></div>');
  });
  H.push('</div>');
}

H.push('</div>'); // sec
H.push('</div>'); // ctn

// ── Footer ──
H.push('<div class="footer"><div class="ctn">此报告由工作流自动生成 | ' + (d.generatedAt || '') + '</div></div>');

// ── ECharts ──
H.push(S);

// Status pie
var stKeys = Object.keys(stMap);
var stData = stKeys.map(function(k){ return {name:k, value:stMap[k]}; });
H.push('var c1=echarts.init(document.getElementById("chart-status"));');
H.push('c1.setOption({tooltip:{trigger:"item"},legend:{bottom:0},series:[{type:"pie",radius:["40%","70%"],padAngle:2,itemStyle:{borderRadius:4},label:{show:true,formatter:"{b}: {c} ({d}%)"},data:' + JSON.stringify(stData) + '}]});');

// Priority pie
var prKeys = Object.keys(prMap);
var prData = prKeys.map(function(k){ return {name:k, value:prMap[k]}; });
var prColors = [];
prKeys.forEach(function(k) {
  if (k === 'HIGH') prColors.push('#F53F3F');
  else if (k === 'MIDDLE') prColors.push('#FF7D00');
  else prColors.push('#165DFF');
});
H.push('var c2=echarts.init(document.getElementById("chart-priority"));');
H.push('c2.setOption({tooltip:{trigger:"item"},color:' + JSON.stringify(prColors) + ',legend:{bottom:0},series:[{type:"pie",radius:["40%","70%"],padAngle:2,itemStyle:{borderRadius:4},label:{show:true,formatter:"{b}: {c} ({d}%)"},data:' + JSON.stringify(prData) + '}]});');

// Handler bar
var hdKeys = Object.keys(hdMap).sort(function(a,b){ return hdMap[b]-hdMap[a]; });
var hdVals = hdKeys.map(function(k){ return hdMap[k]; });
H.push('var c3=echarts.init(document.getElementById("chart-handler"));');
H.push('c3.setOption({tooltip:{trigger:"axis"},grid:{left:"3%",right:"6%",bottom:"3%",containLabel:true},xAxis:{type:"value"},yAxis:{type:"category",data:' + JSON.stringify(hdKeys.reverse()) + ',axisLabel:{fontSize:11}},series:[{type:"bar",data:' + JSON.stringify(hdVals.reverse()) + ',itemStyle:{color:"#165DFF",borderRadius:[0,4,4,0]},barMaxWidth:24,label:{show:true,position:"right",fontSize:11}}]});');

// Customer bar
var custTop = custs.slice(0, 10);
var custNames = custTop.map(function(c){ return c.name; });
var custVals = custTop.map(function(c){ return c.count; });
H.push('var c4=echarts.init(document.getElementById("chart-customer"));');
H.push('c4.setOption({tooltip:{trigger:"axis"},grid:{left:"3%",right:"6%",bottom:"3%",containLabel:true},xAxis:{type:"value"},yAxis:{type:"category",data:' + JSON.stringify(custNames.reverse()) + ',axisLabel:{fontSize:11}},series:[{type:"bar",data:' + JSON.stringify(custVals.reverse()) + ',itemStyle:{color:"#14C9C9",borderRadius:[0,4,4,0]},barMaxWidth:24,label:{show:true,position:"right",fontSize:11}}]});');

// Responsive
H.push('window.addEventListener("resize",function(){c1.resize();c2.resize();c3.resize();c4.resize();});');
H.push(SE);

H.push('</body></html>');
result = H.join("\\n");
`;
