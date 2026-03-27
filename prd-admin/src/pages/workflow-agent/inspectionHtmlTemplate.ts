// ═══ 月度巡检报告 HTML 渲染模板 ═══
// 消费 n-agg 输出的结构化 JSON，生成月度产品规范巡检分析报告
// 数据字段: title, generatedAt, month, items[], overallRate, summary[]

export const inspectionHtmlGenCode = `// data = upstream stats JSON
var d = Array.isArray(data) ? data[0] : data;
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';
var items = d.items || [];
var sums = d.summary || [];
var rectItems = d.rectification || [];

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>' + (d.title || '月度巡检报告') + '</title>');
H.push('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');

H.push(':root{--bg:#F5F7FA;--card:#FFFFFF;--elev:#F0F2F5;--bdr:#E4E7ED;--t1:#1D2129;--t2:#4E5969;--t3:#86909C;--blue:#165DFF;--blue-bg:rgba(22,93,255,0.06);--orange:#FF7D00;--green:#00B42A;--red:#F53F3F;--cyan:#14C9C9;--purple:#722ED1;--header-bg:linear-gradient(135deg,#1B1A55 0%,#535C91 40%,#9290C3 100%);--shadow:0 2px 8px rgba(0,0,0,0.06);--shadow-lg:0 4px 16px rgba(0,0,0,0.1)}');
H.push('*{box-sizing:border-box;margin:0;padding:0}');
H.push('body{font-family:"Noto Sans SC",-apple-system,sans-serif;background:var(--bg);color:var(--t1);line-height:1.7;min-height:100vh}');
H.push('.ctn{max-width:1200px;margin:0 auto;padding:0 32px}');

H.push('.hero{background:var(--header-bg);padding:48px 0 40px;color:#fff;position:relative;overflow:hidden}');
H.push('.hero::after{content:"";position:absolute;top:0;right:0;width:300px;height:100%;background:radial-gradient(circle at 80% 50%,rgba(255,255,255,0.08) 0%,transparent 70%)}');
H.push('.hero-title{font-size:2rem;font-weight:700;letter-spacing:1px;margin-bottom:8px}');
H.push('.hero-sub{font-size:0.9rem;color:rgba(255,255,255,0.7);display:flex;gap:20px;flex-wrap:wrap}');
H.push('.hero-sub span{display:inline-flex;align-items:center;gap:6px}');
H.push('.hero-divider{width:48px;height:3px;background:linear-gradient(90deg,#9290C3,rgba(255,255,255,0.3));border-radius:2px;margin:16px 0}');

H.push('.sec{padding:32px 0}');
H.push('.sec-header{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid var(--blue)}');
H.push('.sec-header h2{font-size:1.25rem;font-weight:700;color:var(--t1)}');
H.push('.sec-header .sec-icon{width:28px;height:28px;background:var(--blue);border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700}');

H.push('.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:28px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:20px;text-align:center;box-shadow:var(--shadow);transition:all 0.2s}');
H.push('.kpi:hover{box-shadow:var(--shadow-lg);transform:translateY(-2px)}');
H.push('.kpi-label{font-size:0.78rem;color:var(--t3);font-weight:500;margin-bottom:8px}');
H.push('.kpi-val{font-size:2.2rem;font-weight:700;line-height:1;letter-spacing:-1px}');
H.push('.kpi-sub{font-size:0.7rem;color:var(--t3);margin-top:6px}');

H.push('.card{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:24px;box-shadow:var(--shadow);margin-bottom:16px}');
H.push('.card h3{font-size:1rem;font-weight:600;margin-bottom:16px;color:var(--t1)}');
H.push('.card-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}');

H.push('.tbl-wrap{overflow-x:auto;margin-top:12px}');
H.push('table.dtbl{width:100%;border-collapse:collapse;font-size:0.82rem}');
H.push('table.dtbl th{background:var(--elev);color:var(--t2);font-weight:600;padding:10px 12px;text-align:left;border-bottom:2px solid var(--bdr);white-space:nowrap}');
H.push('table.dtbl td{padding:10px 12px;border-bottom:1px solid var(--bdr);color:var(--t1);vertical-align:top}');
H.push('table.dtbl tr:hover td{background:var(--blue-bg)}');
H.push('table.dtbl a{color:var(--blue);text-decoration:none}table.dtbl a:hover{text-decoration:underline}');

H.push('.rate-bar{display:flex;align-items:center;gap:8px}');
H.push('.rate-track{flex:1;height:8px;background:var(--elev);border-radius:4px;overflow:hidden}');
H.push('.rate-fill{height:100%;border-radius:4px;transition:width 0.5s}');
H.push('.rate-val{font-weight:700;font-size:0.9rem;min-width:52px;text-align:right}');

H.push('.insight-list{display:flex;flex-direction:column;gap:10px}');
H.push('.insight-item{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--blue-bg);border-radius:8px;border-left:3px solid var(--blue);font-size:0.88rem}');
H.push('.insight-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:7px}');

H.push('.footer{padding:24px 0;text-align:center;font-size:0.75rem;color:var(--t3);border-top:1px solid var(--bdr)}');

H.push('</style></head><body>');

// ── Hero ──
H.push('<div class="hero"><div class="ctn">');
H.push('<div class="hero-title">' + (d.title || '月度产品规范巡检报告') + '</div>');
H.push('<div class="hero-divider"></div>');
H.push('<div class="hero-sub">');
H.push('<span>统计月份: ' + (d.month || '-') + '</span>');
H.push('<span>巡检项数: ' + items.length + ' 项</span>');
H.push('<span>生成时间: ' + (d.generatedAt || '-') + '</span>');
H.push('</div></div></div>');

// ── KPI Overview ──
H.push('<div class="ctn"><div class="sec">');
H.push('<div class="sec-header"><div class="sec-icon">K</div><h2>总体达标情况</h2></div>');
H.push('<div class="kpi-grid">');
var totalTimely = 0;
var totalAll = 0;
items.forEach(function(it) {
  totalTimely += (it.timely || 0);
  totalAll += (it.total || 0);
});
var overallRate = totalAll > 0 ? (totalTimely / totalAll * 100).toFixed(1) : 0;
H.push('<div class="kpi"><div class="kpi-label">巡检项目数</div><div class="kpi-val" style="color:var(--blue)">' + items.length + '</div></div>');
H.push('<div class="kpi"><div class="kpi-label">总体及时率</div><div class="kpi-val" style="color:' + (overallRate >= 90 ? 'var(--green)' : overallRate >= 80 ? 'var(--orange)' : 'var(--red)') + '">' + overallRate + '%</div></div>');
H.push('<div class="kpi"><div class="kpi-label">及时数/总数</div><div class="kpi-val" style="color:var(--cyan)">' + totalTimely + '/' + totalAll + '</div></div>');
H.push('<div class="kpi"><div class="kpi-label">不及时数</div><div class="kpi-val" style="color:' + ((totalAll - totalTimely) > 0 ? 'var(--red)' : 'var(--green)') + '">' + (totalAll - totalTimely) + '</div></div>');
H.push('</div>');

// ── Rate Chart ──
H.push('<div class="card-grid">');
H.push('<div class="card"><h3>各项及时率对比</h3><div id="chart-rate" style="height:300px"></div></div>');
H.push('<div class="card"><h3>及时/不及时数量分布</h3><div id="chart-bar" style="height:300px"></div></div>');
H.push('</div>');

// ── Detail per inspection item ──
H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">D</div><h2>各项巡检明细</h2></div>');

items.forEach(function(it, idx) {
  var rate = it.total > 0 ? (it.timely / it.total * 100).toFixed(1) : 0;
  var rateColor = rate >= 90 ? 'var(--green)' : rate >= 80 ? 'var(--orange)' : 'var(--red)';
  H.push('<div class="card">');
  H.push('<h3>' + (idx + 1) + '. ' + it.name + '</h3>');
  H.push('<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">');
  H.push('<div class="kpi"><div class="kpi-label">总数</div><div class="kpi-val" style="font-size:1.6rem;color:var(--blue)">' + it.total + '</div></div>');
  H.push('<div class="kpi"><div class="kpi-label">及时</div><div class="kpi-val" style="font-size:1.6rem;color:var(--green)">' + it.timely + '</div></div>');
  H.push('<div class="kpi"><div class="kpi-label">不及时</div><div class="kpi-val" style="font-size:1.6rem;color:' + ((it.total - it.timely) > 0 ? 'var(--red)' : 'var(--green)') + '">' + (it.total - it.timely) + '</div></div>');
  H.push('<div class="kpi"><div class="kpi-label">及时率</div><div class="kpi-val" style="font-size:1.6rem;color:' + rateColor + '">' + rate + '%</div></div>');
  H.push('</div>');

  // Rate bar
  H.push('<div class="rate-bar"><div class="rate-track"><div class="rate-fill" style="width:' + rate + '%;background:' + rateColor + '"></div></div><div class="rate-val" style="color:' + rateColor + '">' + rate + '%</div></div>');

  // Responsibility details
  if (it.details && it.details.length > 0) {
    H.push('<div class="tbl-wrap"><table class="dtbl"><thead><tr><th>责任人</th><th>总数</th><th>及时</th><th>不及时</th><th>及时率</th></tr></thead><tbody>');
    it.details.forEach(function(dt) {
      var dRate = dt.total > 0 ? (dt.timely / dt.total * 100).toFixed(1) : '-';
      H.push('<tr><td>' + dt.person + '</td><td>' + dt.total + '</td><td>' + dt.timely + '</td><td>' + (dt.total - dt.timely) + '</td><td>' + dRate + '%</td></tr>');
    });
    H.push('</tbody></table></div>');
  }
  if (it.url) H.push('<div style="margin-top:8px;font-size:0.8rem"><a href="' + it.url + '" target="_blank" style="color:var(--blue)">查看明细表</a></div>');
  H.push('</div>');
});

// ── Rectification Section (Section 4) ──
if (rectItems.length > 0) {
  H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">R</div><h2>产品专项整改跟踪</h2></div>');
  var totalRect = rectItems.length;
  var closedRect = rectItems.filter(function(r){ return r.closed; }).length;
  H.push('<div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">');
  H.push('<div class="kpi"><div class="kpi-label">专项总数</div><div class="kpi-val" style="color:var(--blue)">' + totalRect + '</div></div>');
  H.push('<div class="kpi"><div class="kpi-label">已办结</div><div class="kpi-val" style="color:var(--green)">' + closedRect + '</div></div>');
  H.push('<div class="kpi"><div class="kpi-label">未办结</div><div class="kpi-val" style="color:' + ((totalRect - closedRect) > 0 ? 'var(--red)' : 'var(--green)') + '">' + (totalRect - closedRect) + '</div></div>');
  H.push('</div>');

  H.push('<div class="card"><div class="tbl-wrap"><table class="dtbl">');
  H.push('<thead><tr><th>#</th><th>问题(简要说明)</th><th>提出时间</th><th>逻辑归因</th><th>结构归母</th><th>责任人</th><th>解决计划</th><th>进度</th><th>办结</th><th>备注</th></tr></thead><tbody>');
  rectItems.forEach(function(r, idx) {
    var cls = r.closed ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
    H.push('<tr><td>' + (idx + 1) + '</td>');
    H.push('<td>' + (r.problem || '') + '</td>');
    H.push('<td style="white-space:nowrap">' + (r.raisedAt || '') + '</td>');
    H.push('<td>' + (r.logicCause || '') + '</td>');
    H.push('<td>' + (r.structCause || '') + '</td>');
    H.push('<td>' + (r.owner || '') + '</td>');
    H.push('<td>' + (r.plan || '') + '</td>');
    H.push('<td>' + (r.progress || '') + '</td>');
    H.push('<td ' + cls + '>' + (r.closed ? '是' : '否') + '</td>');
    H.push('<td>' + (r.remark || '') + '</td>');
    H.push('</tr>');
  });
  H.push('</tbody></table></div></div>');
}

// ── Summary ──
if (sums.length > 0) {
  H.push('<div class="sec-header" style="margin-top:24px"><div class="sec-icon">S</div><h2>分析与启发</h2></div>');
  H.push('<div class="insight-list">');
  sums.forEach(function(s) {
    H.push('<div class="insight-item"><div class="insight-dot" style="background:' + (s.color || 'var(--blue)') + '"></div><span>' + s.text + '</span></div>');
  });
  H.push('</div>');
}

H.push('</div></div>'); // sec + ctn

H.push('<div class="footer"><div class="ctn">此报告由工作流自动生成 | ' + (d.generatedAt || '') + '</div></div>');

// ── ECharts ──
H.push(S);

// Rate radar/gauge
var rateNames = items.map(function(it){ return it.name; });
var rateVals = items.map(function(it){ return it.total > 0 ? parseFloat((it.timely / it.total * 100).toFixed(1)) : 0; });
H.push('var c1=echarts.init(document.getElementById("chart-rate"));');
H.push('c1.setOption({tooltip:{trigger:"axis",formatter:function(p){return p[0].name+"<br/>及时率: "+p[0].value+"%";}},grid:{left:"3%",right:"6%",bottom:"3%",containLabel:true},xAxis:{type:"category",data:' + JSON.stringify(rateNames) + ',axisLabel:{fontSize:10,rotate:15}},yAxis:{type:"value",max:100,axisLabel:{formatter:"{value}%"}},series:[{type:"bar",data:' + JSON.stringify(rateVals) + ',itemStyle:{color:function(p){return p.value>=90?"#00B42A":p.value>=80?"#FF7D00":"#F53F3F";},borderRadius:[4,4,0,0]},barMaxWidth:40,label:{show:true,position:"top",formatter:"{c}%",fontSize:11}},{type:"line",data:' + JSON.stringify(rateVals) + ',lineStyle:{color:"#165DFF",type:"dashed"},symbol:"circle",symbolSize:6,itemStyle:{color:"#165DFF"}}],visualMap:{show:false,pieces:[{lte:80,color:"#F53F3F"},{gt:80,lte:90,color:"#FF7D00"},{gt:90,color:"#00B42A"}]}}');
H.push(');');

// Stacked bar
var timelyVals = items.map(function(it){ return it.timely || 0; });
var untimelyVals = items.map(function(it){ return (it.total || 0) - (it.timely || 0); });
H.push('var c2=echarts.init(document.getElementById("chart-bar"));');
H.push('c2.setOption({tooltip:{trigger:"axis"},legend:{bottom:0},grid:{left:"3%",right:"4%",bottom:"12%",containLabel:true},xAxis:{type:"category",data:' + JSON.stringify(rateNames) + ',axisLabel:{fontSize:10,rotate:15}},yAxis:{type:"value"},series:[{name:"及时",type:"bar",stack:"total",data:' + JSON.stringify(timelyVals) + ',itemStyle:{color:"#00B42A",borderRadius:[0,0,0,0]},barMaxWidth:40},{name:"不及时",type:"bar",stack:"total",data:' + JSON.stringify(untimelyVals) + ',itemStyle:{color:"#F53F3F",borderRadius:[4,4,0,0]},barMaxWidth:40}]});');

H.push('window.addEventListener("resize",function(){c1.resize();c2.resize();});');
H.push(SE);

H.push('</body></html>');
result = H.join("\\n");
`;
