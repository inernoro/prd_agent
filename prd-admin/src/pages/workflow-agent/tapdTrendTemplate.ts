import type { WorkflowNode, WorkflowEdge, WorkflowVariable } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// 模板: TAPD 缺陷趋势看板（多月 total_count + ECharts 折线图）
// ═══════════════════════════════════════════════════════════════
//
// 拓扑图：
//   👆 手动触发
//     ↓
//   🐛 TAPD 数据采集（趋势模式，每月 1 请求取 total_count）
//     ↓
//   📊 ECharts 看板渲染（JS 确定性生成）
//     ↓
//   💾 导出 HTML
//

let _eid = 0;
function e(src: string, ss: string, tgt: string, ts: string): WorkflowEdge {
  return { edgeId: `e-trend-${_eid++}`, sourceNodeId: src, sourceSlotId: ss, targetNodeId: tgt, targetSlotId: ts };
}

// ── 生成趋势看板 HTML 的 JS 代码 ──────────────────────────────
// data = 上游 tapd-collector 趋势模式输出的 JSON 数组:
// [{month:"2025-10", monthLabel:"10月", totalBugs:26}, ...]
const trendHtmlGenCode = `
// ═══ TAPD 缺陷趋势看板 ═══
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';

// data 是上游传入的趋势数组
var labels = data.map(function(d) { return d.monthLabel || d.month; });
var values = data.map(function(d) { return d.totalBugs || 0; });
var total = values.reduce(function(a, b) { return a + b; }, 0);
var avg = values.length > 0 ? Math.round(total / values.length * 10) / 10 : 0;
var maxVal = Math.max.apply(null, values);
var minVal = Math.min.apply(null, values);
var maxIdx = values.indexOf(maxVal);
var minIdx = values.indexOf(minVal);

// 环比变化
var changes = [];
for (var i = 0; i < values.length; i++) {
  if (i === 0) { changes.push(null); }
  else {
    var prev = values[i - 1];
    changes.push(prev > 0 ? Math.round((values[i] - prev) / prev * 1000) / 10 : null);
  }
}
var latestChange = changes.length > 1 ? changes[changes.length - 1] : null;

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>TAPD 缺陷趋势看板</title>');
H.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
H.push('<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Noto+Sans+SC:wght@400;600;700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');
H.push(':root{--bg:#0D1117;--card:#161B22;--elev:#1C2128;--bdr:#30363D;--t1:#E6EDF3;--t2:#7D8590;--blue:#1E6FD9;--orange:#F5A623;--green:#27C97F;--red:#E84040;--cyan:#4ECDC4}');
H.push('*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Noto Sans SC",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;min-height:100vh}');
H.push('.ctn{max-width:1200px;margin:0 auto;padding:0 24px}');
H.push('.nav{position:sticky;top:0;z-index:100;background:rgba(13,17,23,0.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--bdr);padding:0 24px}');
H.push('.nav-in{max-width:1200px;margin:0 auto;display:flex;align-items:center;height:56px;gap:16px}');
H.push('.logo{width:32px;height:32px;background:linear-gradient(135deg,var(--blue),var(--cyan));border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px}');
H.push('.nav-t{font-weight:700;font-size:1rem}');
H.push('.sec{padding:32px 0}');
H.push('.sec-t{font-size:1.2rem;font-weight:700;margin-bottom:20px;background:linear-gradient(135deg,var(--t1),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}');
H.push('.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}');
H.push('.kpi{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;position:relative;overflow:hidden;transition:0.3s}');
H.push('.kpi:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}');
H.push('.kpi:before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-color,var(--blue));opacity:0;transition:0.3s}.kpi:hover:before{opacity:1}');
H.push('.kpi-l{font-size:0.78rem;color:var(--t2);margin-bottom:6px;font-weight:600}');
H.push('.kpi-v{font-family:"Bebas Neue",monospace;font-size:2.4rem;line-height:1}');
H.push('.kpi-d{font-size:0.72rem;margin-top:6px;color:var(--t2)}');
H.push('.chart-card{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:24px;margin-bottom:24px}');
H.push('.chart-card h3{font-size:0.95rem;margin-bottom:16px;font-weight:600}');
H.push('.chart-box{width:100%;height:380px}');
H.push('.tbl-wrap{background:var(--card);border:1px solid var(--bdr);border-radius:12px;overflow:hidden;margin-bottom:24px}');
H.push('table{width:100%;border-collapse:collapse}');
H.push('th{background:var(--elev);padding:10px 16px;text-align:left;font-size:0.8rem;font-weight:600;color:var(--t2);border-bottom:1px solid var(--bdr)}');
H.push('td{padding:10px 16px;font-size:0.85rem;border-bottom:1px solid var(--bdr)}');
H.push('tr:last-child td{border-bottom:none}');
H.push('.chg-up{color:var(--red)}.chg-down{color:var(--green)}.chg-flat{color:var(--t2)}');
H.push('.ft{text-align:center;padding:24px 0;border-top:1px solid var(--bdr);color:var(--t2);font-size:0.8rem}');
H.push('@media(max-width:768px){.kg{grid-template-columns:repeat(2,1fr)}}');
H.push('</style></head><body>');

// Navbar
H.push('<nav class="nav"><div class="nav-in"><div class="logo">T</div>');
H.push('<span class="nav-t">TAPD 缺陷趋势看板</span>');
H.push('<span style="margin-left:auto;font-size:0.78rem;color:var(--t2)">共 ' + values.length + ' 个月 · 生成于 ' + new Date().toLocaleDateString('zh-CN') + '</span>');
H.push('</div></nav>');

// KPI Cards
H.push('<div class="sec"><div class="ctn">');
H.push('<div class="kg">');

// 累计缺陷
H.push('<div class="kpi" style="--kpi-color:var(--blue)"><div class="kpi-l">累计缺陷总数</div>');
H.push('<div class="kpi-v" style="color:var(--blue)">' + total + '</div>');
H.push('<div class="kpi-d">近 ' + values.length + ' 个月</div></div>');

// 月均
H.push('<div class="kpi" style="--kpi-color:var(--cyan)"><div class="kpi-l">月均缺陷数</div>');
H.push('<div class="kpi-v" style="color:var(--cyan)">' + avg + '</div></div>');

// 最高月
H.push('<div class="kpi" style="--kpi-color:var(--red)"><div class="kpi-l">峰值月份</div>');
H.push('<div class="kpi-v" style="color:var(--red)">' + maxVal + '</div>');
H.push('<div class="kpi-d">' + labels[maxIdx] + '</div></div>');

// 最低月
H.push('<div class="kpi" style="--kpi-color:var(--green)"><div class="kpi-l">最低月份</div>');
H.push('<div class="kpi-v" style="color:var(--green)">' + minVal + '</div>');
H.push('<div class="kpi-d">' + labels[minIdx] + '</div></div>');

// 最新环比
var changeStr = latestChange === null ? '--' : (latestChange > 0 ? '+' + latestChange + '%' : latestChange + '%');
var changeColor = latestChange === null ? 'var(--t2)' : (latestChange > 0 ? 'var(--red)' : latestChange < 0 ? 'var(--green)' : 'var(--t2)');
H.push('<div class="kpi" style="--kpi-color:' + changeColor + '"><div class="kpi-l">最新环比</div>');
H.push('<div class="kpi-v" style="color:' + changeColor + '">' + changeStr + '</div>');
H.push('<div class="kpi-d">较上月变化</div></div>');

H.push('</div>');

// Main Trend Chart
H.push('<div class="chart-card"><h3>缺陷数量趋势</h3><div class="chart-box" id="trendChart"></div></div>');

// Month-over-Month Bar Chart
H.push('<div class="chart-card"><h3>环比变化率</h3><div class="chart-box" id="momChart" style="height:280px"></div></div>');

// Data Table
H.push('<h3 class="sec-t">月度明细数据</h3>');
H.push('<div class="tbl-wrap"><table>');
H.push('<thead><tr><th>月份</th><th>缺陷总数</th><th>环比变化</th><th>趋势</th></tr></thead><tbody>');
for (var i = 0; i < data.length; i++) {
  var d = data[i];
  var chg = changes[i];
  var chgClass = chg === null ? 'chg-flat' : (chg > 0 ? 'chg-up' : chg < 0 ? 'chg-down' : 'chg-flat');
  var chgText = chg === null ? '--' : (chg > 0 ? '+' + chg + '%' : chg + '%');
  var arrow = chg === null ? '' : (chg > 0 ? ' ↑' : chg < 0 ? ' ↓' : ' →');
  H.push('<tr><td>' + (d.monthLabel || d.month) + '</td>');
  H.push('<td style="font-weight:600">' + d.totalBugs + '</td>');
  H.push('<td class="' + chgClass + '">' + chgText + '</td>');
  H.push('<td class="' + chgClass + '">' + arrow + '</td></tr>');
}
H.push('</tbody></table></div>');

H.push('</div></div>');

// Footer
H.push('<footer class="ft"><div class="ctn">TAPD 缺陷趋势看板 | 由工作流自动生成 · 数据来源: TAPD 搜索 API</div></footer>');

// ECharts Scripts
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('if(typeof echarts==="undefined")return;');
H.push('var tt={backgroundColor:"rgba(22,27,34,0.95)",borderColor:"#30363D",textStyle:{color:"#E6EDF3"}};');

// Trend line + bar chart
H.push('var labels=' + JSON.stringify(labels) + ';');
H.push('var vals=' + JSON.stringify(values) + ';');
H.push('var avg=' + avg + ';');
H.push('var ch=echarts.init(document.getElementById("trendChart"));');
H.push('ch.setOption({');
H.push('tooltip:Object.assign({trigger:"axis"},tt),');
H.push('grid:{top:40,bottom:30,left:50,right:30},');
H.push('xAxis:{type:"category",data:labels,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",axisLabel:{color:"#7D8590"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[');
H.push('{name:"缺陷数",type:"bar",data:vals,itemStyle:{color:"rgba(30,111,217,0.6)",borderRadius:[4,4,0,0]},barWidth:"40%"},');
H.push('{name:"趋势线",type:"line",data:vals,smooth:true,itemStyle:{color:"#4ECDC4"},lineStyle:{width:2.5},');
H.push('areaStyle:{color:{type:"linear",x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:"rgba(78,205,196,0.2)"},{offset:1,color:"rgba(78,205,196,0)"}]}}},');
H.push('{name:"月均",type:"line",data:labels.map(function(){return avg}),lineStyle:{type:"dashed",color:"#F5A623",width:1.5},itemStyle:{color:"#F5A623"},symbol:"none"}');
H.push(']});');
H.push('window.addEventListener("resize",function(){ch.resize()});');

// Month-over-month bar chart
H.push('var momLabels=' + JSON.stringify(labels.slice(1)) + ';');
H.push('var momVals=' + JSON.stringify(changes.slice(1)) + ';');
H.push('var ch2=echarts.init(document.getElementById("momChart"));');
H.push('ch2.setOption({');
H.push('tooltip:Object.assign({trigger:"axis",formatter:function(p){return p[0].name+"<br/>环比: "+(p[0].value>0?"+":"")+p[0].value+"%"}},tt),');
H.push('grid:{top:20,bottom:30,left:50,right:30},');
H.push('xAxis:{type:"category",data:momLabels,axisLabel:{color:"#7D8590"},axisLine:{lineStyle:{color:"#30363D"}}},');
H.push('yAxis:{type:"value",axisLabel:{color:"#7D8590",formatter:"{value}%"},splitLine:{lineStyle:{color:"rgba(48,54,61,0.5)"}}},');
H.push('series:[{type:"bar",data:momVals.map(function(v){return{value:v===null?0:v,itemStyle:{color:v===null?"#30363D":v>0?"rgba(232,64,64,0.7)":v<0?"rgba(39,201,127,0.7)":"#7D8590",borderRadius:[4,4,0,0]}}}),barWidth:"35%"}]');
H.push('});');
H.push('window.addEventListener("resize",function(){ch2.resize()});');

H.push('});');
H.push(SE);
H.push('</body></html>');

result = H.join("\\n");
`;

export const tapdTrendTemplate = {
  id: 'tapd-bug-trend',
  name: 'TAPD 缺陷趋势看板',
  description: '从 TAPD 多月采集缺陷数量 → ECharts 趋势折线图 + 环比分析 + 月度明细表',
  icon: '📈',
  tags: ['tapd', 'quality', 'trend', 'dashboard'],
  requiredInputs: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea' as const,
      placeholder: 'tapdsession=xxx; t_u=xxx; _wt=xxx; ...',
      helpTip: '浏览器登录 TAPD → F12 → Network → 点任意请求 → Headers → 找到 Cookie → 复制整段粘贴到这里',
      required: true,
    },
    {
      key: 'workspaceId',
      label: '工作空间 ID',
      type: 'text' as const,
      placeholder: '50116108',
      defaultValue: '50116108',
      helpTip: 'TAPD 项目 URL 中的数字 ID，如 tapd.cn/50116108',
      required: true,
    },
    {
      key: 'trendMonths',
      label: '追溯月数',
      type: 'select' as const,
      required: true,
      defaultValue: '6',
      options: [
        { value: '3', label: '近 3 个月' },
        { value: '6', label: '近 6 个月' },
        { value: '9', label: '近 9 个月' },
        { value: '12', label: '近 12 个月' },
      ],
    },
  ],
  build: (inputs: Record<string, string>) => {
    _eid = 0;

    const nodes: WorkflowNode[] = [
      {
        nodeId: 'n-trigger',
        name: '手动触发',
        nodeType: 'manual-trigger',
        config: { inputPrompt: '点击开始采集 TAPD 缺陷趋势数据' },
        inputSlots: [],
        outputSlots: [{ slotId: 'manual-out', name: 'input', dataType: 'json', required: true }],
        position: { x: 100, y: 300 },
      },
      {
        nodeId: 'n-tapd',
        name: 'TAPD 趋势采集',
        nodeType: 'tapd-collector',
        config: {
          authMode: 'cookie',
          workspaceId: inputs.workspaceId || '',
          cookie: inputs.cookie || '',
          dataType: 'bugs',
          trendMode: 'true',
          trendMonths: inputs.trendMonths || '6',
          fetchDetail: 'false',
        },
        inputSlots: [{ slotId: 'tapd-in', name: 'trigger', dataType: 'json', required: false }],
        outputSlots: [{ slotId: 'tapd-out', name: 'data', dataType: 'json', required: true }],
        position: { x: 400, y: 300 },
      },
      {
        nodeId: 'n-html',
        name: '趋势看板渲染（确定性）',
        nodeType: 'script-executor',
        config: {
          language: 'javascript',
          timeoutSeconds: '30',
          code: trendHtmlGenCode.trim(),
        },
        inputSlots: [{ slotId: 'script-in', name: 'input', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'script-out', name: 'output', dataType: 'text', required: true }],
        position: { x: 750, y: 300 },
      },
      {
        nodeId: 'n-export',
        name: '导出 HTML',
        nodeType: 'file-exporter',
        config: {
          fileFormat: 'html',
          fileName: 'tapd-bug-trend-{{date}}',
        },
        inputSlots: [{ slotId: 'export-in', name: 'data', dataType: 'json', required: true }],
        outputSlots: [{ slotId: 'export-out', name: 'file', dataType: 'binary', required: true }],
        position: { x: 1100, y: 300 },
      },
    ];

    const edges: WorkflowEdge[] = [
      e('n-trigger', 'manual-out', 'n-tapd', 'tapd-in'),
      e('n-tapd', 'tapd-out', 'n-html', 'script-in'),
      e('n-html', 'script-out', 'n-export', 'export-in'),
    ];

    const variables: WorkflowVariable[] = [];
    return { nodes, edges, variables };
  },
};
