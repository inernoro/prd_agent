// ═══ TAPD 缺陷质量报告 HTML 渲染模板 ═══
// 消费 n-agg 输出的结构化 JSON，生成专业级质量分析报告
// 数据字段: title, generatedAt, total, kpis, severity, processingStatus,
//           rootCauses, criticalAlerts, problemItems, defectDetails, docLinks, summary

export const tapdHtmlGenCode = `// data = upstream stats JSON (may be wrapped in array when source ref is passed through)
var d = Array.isArray(data) ? data[0] : data;
var H = [];
var S = '<' + 'script>';
var SE = '<' + '/' + 'script>';
var sev = d.severity || {};
var rcs = d.rootCauses || [];
var stMap = d.processingStatus || {};
var sums = d.summary || [];
var dets = d.defectDetails || [];
var probs = d.problemItems || [];
var alerts = d.criticalAlerts || [];
var dls = d.docLinks || [];
var totalTech = 0;
(d.kpis || []).forEach(function(k){ if(k.label==="技术缺陷总数") totalTech=k.value; });

H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
H.push('<title>' + (d.title || 'Quality Report') + '</title>');
H.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
H.push('<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;600;700&family=DIN+Alternate:wght@700&display=swap" rel="stylesheet">');
H.push(S.replace('>', ' src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js">') + SE);
H.push('<style>');

// ── CSS Variables & Reset ──
H.push(':root{--bg:#F5F7FA;--card:#FFFFFF;--elev:#F0F2F5;--bdr:#E4E7ED;--bdr2:#DCDFE6;--t1:#1D2129;--t2:#4E5969;--t3:#86909C;--blue:#165DFF;--blue-bg:rgba(22,93,255,0.06);--orange:#FF7D00;--green:#00B42A;--red:#F53F3F;--cyan:#14C9C9;--purple:#722ED1;--header-bg:linear-gradient(135deg,#0E1C36 0%,#1A3A6B 40%,#2B5EA7 100%);--shadow:0 2px 8px rgba(0,0,0,0.06);--shadow-lg:0 4px 16px rgba(0,0,0,0.1)}');
H.push('*{box-sizing:border-box;margin:0;padding:0}');
H.push('body{font-family:"Noto Sans SC",-apple-system,sans-serif;background:var(--bg);color:var(--t1);line-height:1.7;min-height:100vh}');
H.push('.ctn{max-width:1200px;margin:0 auto;padding:0 32px}');

// ── Hero Header ──
H.push('.hero{background:var(--header-bg);padding:48px 0 40px;color:#fff;position:relative;overflow:hidden}');
H.push('.hero::after{content:"";position:absolute;top:0;right:0;width:300px;height:100%;background:radial-gradient(circle at 80% 50%,rgba(255,255,255,0.08) 0%,transparent 70%)}');
H.push('.hero-title{font-size:2rem;font-weight:700;letter-spacing:1px;margin-bottom:8px}');
H.push('.hero-sub{font-size:0.9rem;color:rgba(255,255,255,0.7);display:flex;gap:20px;flex-wrap:wrap}');
H.push('.hero-sub span{display:inline-flex;align-items:center;gap:6px}');
H.push('.hero-divider{width:48px;height:3px;background:linear-gradient(90deg,#4ECDC4,rgba(255,255,255,0.3));border-radius:2px;margin:16px 0}');

// ── Section ──
H.push('.sec{padding:32px 0}');
H.push('.sec-header{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid var(--blue)}');
H.push('.sec-header h2{font-size:1.25rem;font-weight:700;color:var(--t1)}');
H.push('.sec-header .sec-icon{width:28px;height:28px;background:var(--blue);border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700}');
H.push('.sec-desc{font-size:0.85rem;color:var(--t3);margin-bottom:20px}');
H.push('.subsec{margin-top:24px}');
H.push('.subsec-t{font-size:1rem;font-weight:600;color:var(--t1);margin-bottom:12px;display:flex;align-items:center;gap:8px}');
H.push('.subsec-t::before{content:"";width:3px;height:16px;background:var(--blue);border-radius:2px}');

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

// ── Alert ──
H.push('.alert-card{background:rgba(245,63,63,0.04);border:1px solid rgba(245,63,63,0.2);border-radius:10px;padding:16px 20px;margin-bottom:12px}');
H.push('.alert-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}');
H.push('.alert-badge{background:var(--red);color:#fff;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:700}');
H.push('.alert-title{font-weight:600;color:var(--red);font-size:0.9rem}');
H.push('.alert-title a{color:var(--red);text-decoration:underline;text-underline-offset:3px}');
H.push('.alert-desc{font-size:0.8rem;color:var(--t2)}');
H.push('.alert-meta{display:flex;gap:12px;margin-top:6px;font-size:0.75rem;color:var(--t3)}');

// ── Table ──
H.push('.tbl-wrap{overflow-x:auto;margin-top:12px}');
H.push('table.dtbl{width:100%;border-collapse:collapse;font-size:0.82rem}');
H.push('table.dtbl th{background:var(--elev);color:var(--t2);font-weight:600;padding:10px 12px;text-align:left;border-bottom:2px solid var(--bdr);white-space:nowrap}');
H.push('table.dtbl td{padding:10px 12px;border-bottom:1px solid var(--bdr);color:var(--t1);vertical-align:top}');
H.push('table.dtbl tr:hover td{background:var(--blue-bg)}');
H.push('table.dtbl a{color:var(--blue);text-decoration:none}table.dtbl a:hover{text-decoration:underline}');

// ── Tags ──
H.push('.tag{display:inline-block;padding:1px 8px;border-radius:4px;font-size:0.68rem;font-weight:600}');
H.push('.tag-p0{background:rgba(245,63,63,0.12);color:#F53F3F}.tag-p1{background:rgba(255,125,0,0.12);color:#FF7D00}');
H.push('.tag-p2{background:rgba(255,125,0,0.08);color:#F77234}.tag-p3{background:rgba(22,93,255,0.08);color:#165DFF}');
H.push('.tag-p4{background:rgba(20,201,201,0.08);color:#14C9C9}');
H.push('.tag-suspend{background:rgba(134,144,156,0.12);color:#86909C}');
H.push('.tag-tmp{background:rgba(255,125,0,0.12);color:#FF7D00}');
H.push('.tag-overdue{background:rgba(245,63,63,0.12);color:#F53F3F}');
H.push('.tag-untimely{background:rgba(247,114,52,0.12);color:#F77234}');

// ── Summary insight ──
H.push('.insight-list{display:flex;flex-direction:column;gap:10px}');
H.push('.insight-item{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--blue-bg);border-radius:8px;border-left:3px solid var(--blue);font-size:0.88rem}');
H.push('.insight-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:7px}');

// ── Editable ──
H.push('.edit-sec{background:var(--card);border:1px solid var(--bdr);border-radius:10px;padding:24px;box-shadow:var(--shadow);margin-bottom:20px}');
H.push('.edit-sec h4{font-size:1rem;font-weight:700;margin-bottom:12px}');
H.push('.edit-area{min-height:100px;padding:14px;background:var(--elev);border:1px dashed var(--bdr2);border-radius:8px;color:var(--t1);font-size:0.88rem;line-height:1.8;outline:none}');
H.push('.edit-area:focus{border-color:var(--blue);background:#fff}');
H.push('.edit-area:empty::before{content:attr(data-placeholder);color:var(--t3)}');
H.push('.edit-hint{font-size:0.72rem;color:var(--t3);margin-top:8px;font-style:italic}');

// ── Improve ──
H.push('.improve-item{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--bdr)}');
H.push('.improve-cb{width:18px;height:18px;border:2px solid var(--bdr2);border-radius:4px;flex-shrink:0;margin-top:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s}');
H.push('.improve-cb.checked{background:var(--green);border-color:var(--green)}.improve-cb.checked::after{content:"\\\\2713";color:#fff;font-size:11px}');
H.push('.improve-tag{padding:1px 8px;border-radius:4px;font-size:0.68rem;font-weight:600;background:var(--blue-bg);color:var(--blue);flex-shrink:0}');

// ── Doc links ──
H.push('.doc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}');
H.push('.doc-card{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:10px;transition:0.2s;box-shadow:var(--shadow)}');
H.push('.doc-card:hover{border-color:var(--blue);transform:translateY(-2px)}');
H.push('.doc-icon{width:32px;height:32px;background:var(--blue-bg);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--blue);font-size:14px;flex-shrink:0}');
H.push('.doc-card a{color:var(--blue);text-decoration:none;font-size:0.85rem;font-weight:500}');
H.push('.doc-card a:hover{text-decoration:underline}');
H.push('.doc-from{font-size:0.7rem;color:var(--t3);margin-top:2px}');

// ── Footer ──
H.push('.ft{text-align:center;padding:28px 0;border-top:1px solid var(--bdr);color:var(--t3);font-size:0.78rem;margin-top:20px}');

// ── Responsive ──
H.push('@media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.card-grid{grid-template-columns:1fr}.hero-title{font-size:1.5rem}.ctn{padding:0 16px}}');
H.push('@media print{.hero{background:#1A3A6B !important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.edit-sec{break-inside:avoid}}');
H.push('</style></head><body>');

// ═══════════════════════════════════════════════════════════════
// HERO HEADER
// ═══════════════════════════════════════════════════════════════
H.push('<header class="hero"><div class="ctn">');
H.push('<div class="hero-title">' + (d.title || "TAPD 缺陷质量分析报告") + '</div>');
H.push('<div class="hero-divider"></div>');
H.push('<div class="hero-sub">');
H.push('<span>&#128197; 生成时间：' + (d.generatedAt || "") + '</span>');
H.push('<span>&#128202; 缺陷总数：' + (d.total || 0) + ' 条</span>');
H.push('<span>&#128295; 技术缺陷：' + totalTech + ' 条</span>');
H.push('</div></div></header>');

// ═══════════════════════════════════════════════════════════════
// 1. 数据概览
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">1</div><h2>数据概览</h2></div>');
H.push('<div class="sec-desc">核心质量指标一览，展示本周期缺陷总体情况。</div>');

// KPI cards
H.push('<div class="kpi-grid">');
(d.kpis || []).forEach(function(k) {
  var val = k.format === "percent" ? k.value + "%" : k.value;
  H.push('<div class="kpi"><div class="kpi-label">' + k.label + '</div>');
  H.push('<div class="kpi-val" style="color:' + (k.color||"#165DFF") + '">' + val + '</div></div>');
});
H.push('</div>');

// Severity bar chart + Status donut side by side
H.push('<div class="card-grid">');
H.push('<div class="card"><h3>缺陷级别分布</h3><div id="sevBarChart" style="width:100%;height:280px"></div></div>');
H.push('<div class="card"><h3>处理状态分布</h3><div id="statusPieChart" style="width:100%;height:280px"></div></div>');
H.push('</div>');
H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 2. 缺陷分析
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec" style="background:#fff;border-top:1px solid var(--bdr);border-bottom:1px solid var(--bdr)"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">2</div><h2>缺陷分析</h2></div>');

// 2.1 整体概述 (auto insights)
H.push('<div class="subsec"><div class="subsec-t">整体概述</div>');
H.push('<div class="insight-list">');
sums.forEach(function(s) {
  H.push('<div class="insight-item"><div class="insight-dot" style="background:' + (s.color||"#165DFF") + '"></div>');
  H.push('<div>' + s.text + '</div></div>');
});
H.push('</div></div>');

// 2.2 P0/P1 重点问题
if (alerts.length > 0) {
  H.push('<div class="subsec"><div class="subsec-t">P0/P1 重点问题 (' + alerts.length + ')</div>');
  alerts.forEach(function(a) {
    H.push('<div class="alert-card"><div class="alert-top">');
    H.push('<span class="alert-badge">' + a.level + '</span>');
    if (a.url) {
      H.push('<span class="alert-title"><a href="' + a.url + '" target="_blank" rel="noopener">' + a.title + ' &rarr;</a></span>');
    } else {
      H.push('<span class="alert-title">' + a.title + '</span>');
    }
    H.push('</div>');
    if (a.desc) H.push('<div class="alert-desc">根因：' + a.desc + '</div>');
    var mp = [];
    if (a.handler) mp.push('<span>&#9881; ' + a.handler + '</span>');
    if (a.reporter) mp.push('<span>&#9998; ' + a.reporter + '</span>');
    if (a.bugId) mp.push('<span>#' + a.bugId + '</span>');
    if (mp.length > 0) H.push('<div class="alert-meta">' + mp.join('') + '</div>');
    H.push('</div>');
  });
  H.push('</div>');
}

// 2.3 根因分布 chart
H.push('<div class="subsec"><div class="subsec-t">缺陷根因分布</div>');
H.push('<div class="card" style="margin-bottom:0"><div id="rcBarChart" style="width:100%;height:' + Math.max(rcs.length * 40 + 60, 200) + 'px"></div></div>');
H.push('</div>');

H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 3. 缺陷详情
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">3</div><h2>缺陷详情</h2></div>');

// Defect details as table (grouped by root cause)
if (dets.length > 0) {
  dets.forEach(function(grp) {
    H.push('<div class="subsec"><div class="subsec-t" style="margin-bottom:8px">');
    H.push('<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + (grp.color||"#165DFF") + '"></span> ');
    H.push(grp.category + ' (' + grp.items.length + ')</div>');
    H.push('<div class="card" style="padding:0;overflow:hidden"><div class="tbl-wrap"><table class="dtbl">');
    H.push('<thead><tr><th style="width:40px">#</th><th>缺陷标题</th><th style="width:80px">等级</th><th>根因/归因</th><th style="width:80px">处理人</th><th style="width:80px">创建人</th></tr></thead><tbody>');
    grp.items.forEach(function(item, ii) {
      var lvTag = item.level ? '<span class="tag tag-' + item.level.toLowerCase() + '">' + item.level + '</span>' : '-';
      var titleHtml = item.desc;
      if (item.url) titleHtml = '<a href="' + item.url + '" target="_blank" rel="noopener">' + item.desc + '</a>';
      H.push('<tr><td>' + (ii+1) + '</td><td>' + titleHtml + '</td><td>' + lvTag + '</td>');
      H.push('<td style="color:var(--t2);font-size:0.8rem">' + (item.cause || '-') + '</td>');
      H.push('<td>' + (item.handler || '-') + '</td><td>' + (item.reporter || '-') + '</td></tr>');
    });
    H.push('</tbody></table></div></div></div>');
  });
}

H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 4. 处理状态与跟进
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec" style="background:#fff;border-top:1px solid var(--bdr);border-bottom:1px solid var(--bdr)"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">4</div><h2>处理状态与跟进</h2></div>');

// Status number cards
var stColors = {"已修复":"#00B42A","临时解决":"#FF7D00","处理中":"#165DFF","挂起":"#86909C","逾期":"#F53F3F"};
H.push('<div class="kpi-grid" style="margin-bottom:24px">');
Object.keys(stMap).forEach(function(k) {
  H.push('<div class="kpi"><div class="kpi-label">' + k + '</div>');
  H.push('<div class="kpi-val" style="color:' + (stColors[k]||"#165DFF") + '">' + stMap[k] + '</div></div>');
});
H.push('</div>');

// Problem items table
if (probs.length > 0) {
  H.push('<div class="subsec"><div class="subsec-t">需跟进问题清单 (' + probs.length + ')</div>');
  H.push('<div class="card" style="padding:0;overflow:hidden"><div class="tbl-wrap"><table class="dtbl">');
  H.push('<thead><tr><th style="width:40px">#</th><th>缺陷标题</th><th style="width:70px">等级</th><th style="width:140px">问题标签</th><th style="width:80px">处理人</th><th style="width:80px">责任人</th></tr></thead><tbody>');
  var tagClassMap = {"挂起":"tag-suspend","临时解决":"tag-tmp","逾期":"tag-overdue","未及时处理":"tag-untimely"};
  probs.forEach(function(p, pi) {
    var titleHtml = p.title;
    if (p.url) titleHtml = '<a href="' + p.url + '" target="_blank" rel="noopener">' + p.title + '</a>';
    var lvTag = p.level ? '<span class="tag tag-' + p.level.toLowerCase() + '">' + p.level + '</span>' : '-';
    var tagHtml = p.tags.map(function(t){ return '<span class="tag ' + (tagClassMap[t]||"") + '">' + t + '</span>'; }).join(' ');
    H.push('<tr><td>' + (pi+1) + '</td><td>' + titleHtml + '</td><td>' + lvTag + '</td>');
    H.push('<td>' + tagHtml + '</td><td>' + (p.handler||"-") + '</td><td>' + (p.responsible||p.reporter||"-") + '</td></tr>');
  });
  H.push('</tbody></table></div></div></div>');
}

H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 5. 缺陷总结
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">5</div><h2>缺陷总结</h2></div>');

// Pre-filled summary
H.push('<div class="edit-sec"><h4>数据摘要（自动生成）</h4>');
H.push('<div style="padding:14px;background:var(--elev);border-radius:8px;font-size:0.88rem;line-height:2;color:var(--t2)">');
sums.forEach(function(s, si) {
  H.push('<div>' + (si+1) + '. ' + s.text + '</div>');
});
if (rcs.length > 0) {
  H.push('<div style="margin-top:8px">根因 TOP3：');
  rcs.slice(0,3).forEach(function(r, ri) {
    H.push((ri>0?'、':'') + '<strong style="color:var(--t1)">' + r.name + '</strong>(' + r.count + '个)');
  });
  H.push('</div>');
}
H.push('</div></div>');

// Editable area
H.push('<div class="edit-sec"><h4>补充说明（会后编辑）</h4>');
H.push('<div class="edit-area" contenteditable="true" data-placeholder="在此补充缺陷总结要点...&#10;&#10;示例：&#10;1. 复合根因占比高：技术分析不足与测试覆盖不足超30%缺陷由多环节共同导致&#10;2. 发布规范问题突出&#10;3. 无效反馈仍较多，占用研发团队大量时间"></div>');
H.push('<div class="edit-hint">* 此区域可直接编辑，内容仅保存在当前页面中（建议编辑后 Ctrl+S 保存网页）</div>');
H.push('</div>');

H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 6. 改进计划
// ═══════════════════════════════════════════════════════════════
H.push('<div class="sec" style="background:#fff;border-top:1px solid var(--bdr);border-bottom:1px solid var(--bdr)"><div class="ctn">');
H.push('<div class="sec-header"><div class="sec-icon">6</div><h2>改进计划</h2></div>');

H.push('<div class="edit-sec" style="box-shadow:none;border:none;padding:0">');
H.push('<div id="improveList"></div>');
H.push('<div style="margin-top:14px;display:flex;gap:8px">');
H.push('<input id="improveInput" type="text" placeholder="输入改进措施后按 Enter 添加..." style="flex:1;background:var(--elev);border:1px solid var(--bdr);border-radius:8px;padding:10px 14px;color:var(--t1);font-size:0.85rem;outline:none">');
H.push('<select id="improveTag" style="background:var(--elev);border:1px solid var(--bdr);border-radius:8px;padding:10px;color:var(--t1);font-size:0.82rem;outline:none">');
H.push('<option value="流程">流程</option><option value="测试">测试</option><option value="监控">监控</option><option value="运维">运维</option>');
H.push('<option value="规范">规范</option><option value="安全">安全</option><option value="代码">代码</option><option value="性能">性能</option><option value="质量">质量</option>');
H.push('</select></div>');
H.push('<div class="edit-hint">* 输入改进措施后按 Enter 添加到列表，点击复选框标记完成</div>');
H.push('</div>');

H.push('</div></div>');

// ═══════════════════════════════════════════════════════════════
// 7. 相关文档
// ═══════════════════════════════════════════════════════════════
if (dls.length > 0) {
  H.push('<div class="sec"><div class="ctn">');
  H.push('<div class="sec-header"><div class="sec-icon">7</div><h2>相关文档链接</h2></div>');
  H.push('<div class="doc-grid">');
  dls.forEach(function(dl) {
    var label = dl.url;
    if (dl.url.indexOf('yuque') >= 0) label = '语雀文档';
    else if (dl.url.indexOf('tapd') >= 0) label = 'TAPD 链接';
    else if (dl.url.indexOf('confluence') >= 0) label = 'Confluence';
    else { var parts = dl.url.split("/"); label = parts[parts.length - 1] || dl.url; }
    H.push('<div class="doc-card"><div class="doc-icon">&#128196;</div><div>');
    H.push('<a href="' + dl.url + '" target="_blank" rel="noopener">' + label + ' &rarr;</a>');
    if (dl.fromBug) H.push('<div class="doc-from">来源: ' + dl.fromBug + '</div>');
    H.push('</div></div>');
  });
  H.push('</div></div></div>');
}

// ── Footer ──
H.push('<footer class="ft"><div class="ctn">' + (d.generatedAt||"") + ' | 由工作流自动生成 | ' + (d.total||0) + ' 条缺陷数据</div></footer>');

// ═══════════════════════════════════════════════════════════════
// ECharts Init
// ═══════════════════════════════════════════════════════════════
H.push(S);
H.push('document.addEventListener("DOMContentLoaded",function(){');
H.push('var tt={backgroundColor:"rgba(255,255,255,0.96)",borderColor:"#E4E7ED",textStyle:{color:"#1D2129",fontSize:12}};');

// Chart 1: Severity Bar
H.push('var c1=document.getElementById("sevBarChart");');
H.push('if(c1&&typeof echarts!=="undefined"){');
H.push('var ch1=echarts.init(c1);');
H.push('ch1.setOption({');
H.push('tooltip:Object.assign({trigger:"axis"},tt),');
H.push('grid:{left:60,right:20,top:20,bottom:40},');
H.push('xAxis:{type:"category",data:["P0 致命","P1 重大","P2 严重","P3 一般","P4 轻微"],axisLabel:{color:"#4E5969"},axisLine:{lineStyle:{color:"#E4E7ED"}}},');
H.push('yAxis:{type:"value",minInterval:1,axisLabel:{color:"#86909C"},splitLine:{lineStyle:{color:"#F0F2F5"}}},');
H.push('series:[{type:"bar",barWidth:36,data:[');
H.push('{value:' + (sev.P0||0) + ',itemStyle:{color:"#F53F3F"}},');
H.push('{value:' + (sev.P1||0) + ',itemStyle:{color:"#FF7D00"}},');
H.push('{value:' + (sev.P2||0) + ',itemStyle:{color:"#F77234"}},');
H.push('{value:' + (sev.P3||0) + ',itemStyle:{color:"#165DFF"}},');
H.push('{value:' + (sev.P4||0) + ',itemStyle:{color:"#14C9C9"}}');
H.push('],itemStyle:{borderRadius:[4,4,0,0]},label:{show:true,position:"top",color:"#4E5969",fontSize:12,fontWeight:600}}]});');
H.push('window.addEventListener("resize",function(){ch1.resize()});}');

// Chart 2: Status Donut
H.push('var c2=document.getElementById("statusPieChart");');
H.push('if(c2){');
H.push('var ch2=echarts.init(c2);');
var stArr = [];
var stChartColors = {"已修复":"#00B42A","临时解决":"#FF7D00","处理中":"#165DFF","挂起":"#86909C","逾期":"#F53F3F"};
Object.keys(stMap).forEach(function(k) {
  stArr.push('{value:' + stMap[k] + ',name:"' + k + '",itemStyle:{color:"' + (stChartColors[k]||"#165DFF") + '"}}');
});
H.push('ch2.setOption({');
H.push('tooltip:Object.assign({trigger:"item"},tt),');
H.push('legend:{orient:"vertical",right:10,top:"center",textStyle:{color:"#4E5969",fontSize:12},itemGap:12},');
H.push('series:[{type:"pie",radius:["45%","72%"],center:["38%","50%"],avoidLabelOverlap:false,');
H.push('itemStyle:{borderRadius:4,borderColor:"#fff",borderWidth:2},');
H.push('label:{show:false},emphasis:{label:{show:true,fontSize:13,fontWeight:"bold",color:"#1D2129"}},');
H.push('data:[' + stArr.join(',') + ']}]});');
H.push('window.addEventListener("resize",function(){ch2.resize()});}');

// Chart 3: Root Cause Horizontal Bar
H.push('var c3=document.getElementById("rcBarChart");');
H.push('if(c3){');
H.push('var ch3=echarts.init(c3);');
var rcNames = [];
var rcVals = [];
var rcColorArr = [];
// Reverse for horizontal bar (bottom to top)
for (var ri = rcs.length - 1; ri >= 0; ri--) {
  rcNames.push('"' + rcs[ri].name + '"');
  rcVals.push(rcs[ri].count);
  rcColorArr.push('"' + (rcs[ri].color||"#165DFF") + '"');
}
H.push('ch3.setOption({');
H.push('tooltip:Object.assign({trigger:"axis"},tt),');
H.push('grid:{left:140,right:40,top:10,bottom:20},');
H.push('xAxis:{type:"value",minInterval:1,axisLabel:{color:"#86909C"},splitLine:{lineStyle:{color:"#F0F2F5"}}},');
H.push('yAxis:{type:"category",data:[' + rcNames.join(',') + '],axisLabel:{color:"#4E5969",fontSize:12},axisLine:{lineStyle:{color:"#E4E7ED"}}},');
H.push('series:[{type:"bar",barWidth:20,data:[' + rcVals.join(',') + '],');
H.push('itemStyle:{borderRadius:[0,4,4,0],color:function(p){var cs=[' + rcColorArr.join(',') + '];return cs[p.dataIndex]||"#165DFF";}},');
H.push('label:{show:true,position:"right",color:"#4E5969",fontSize:12,fontWeight:600}}]});');
H.push('window.addEventListener("resize",function(){ch3.resize()});}');

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
result = H.join("\\n");`;
