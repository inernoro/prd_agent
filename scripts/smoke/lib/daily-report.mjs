/**
 * 每日核心功能验收 —— 结果的唯一构造器与渲染器。
 *
 * 为什么单独成模块：主脚本一 import 就会起浏览器，守卫没法真的执行它；
 * 拆出来之后，「结果长什么样、表格怎么排、缺下一步会不会被拦」都能被测试真跑一遍
 * （而不是扫源码字面量，见 predicate-and-wiring-discipline 形状 6）。
 *
 * 三条写死在这里、调用方碰不到的约束（external-cause-first 第四节：判断收敛成类型）：
 *   1. 状态是有限枚举：pass / warn / fail / not-run。没有第五种，也没有自由文本状态。
 *      warn = 功能能用，但服务自检报了隐患（缺索引、同步停了）——不算坏，也不能当没看见。
 *   2. 除 pass 外都必须带「下一步」，缺了直接抛错 —— 忘了写下一步的报告出不来，
 *      而不是出来一行「失败」让读的人自己猜该干嘛。
 *   3. 表格顺序固定：异常 → 未执行 → 需关注 → 正常。读者只看第一屏，拿到的就是要处理的那几行。
 */

export const STATUS = Object.freeze({
  fail: { label: '异常', rank: 0 },
  'not-run': { label: '未执行', rank: 1 },
  warn: { label: '需关注', rank: 2 },
  pass: { label: '正常', rank: 3 },
});

/**
 * 造一条验收结果。所有用例都只能经由这里产出结果。
 * @param {object} p
 * @param {string} p.id         稳定编号，如 DAILY-WEB-01
 * @param {string} p.featureLine 业务功能台账里的功能线 id
 * @param {string} p.title      人话验收项
 * @param {string} p.method     人话「怎么验的」
 * @param {'pass'|'warn'|'fail'|'not-run'} p.status
 * @param {string} [p.observed] 观察到了什么（给人读的一句话）
 * @param {string} [p.next]     非 pass 必填：下一步做什么
 * @param {string} [p.link]     被测环境上可点开的入口
 * @param {string} [p.shot]     截图 data URI（可选）
 * @param {string} [p.tech]     技术细节（HTTP 码、选择器等），只进折叠区
 */
export function outcome(p) {
  for (const k of ['id', 'featureLine', 'title', 'method', 'status']) {
    if (!p[k]) throw new Error(`验收结果缺字段 ${k}：${JSON.stringify({ id: p.id, title: p.title })}`);
  }
  if (!STATUS[p.status]) throw new Error(`未知状态 ${p.status}（只允许 pass / warn / fail / not-run）`);
  if (p.status !== 'pass' && !(p.next && p.next.trim())) {
    throw new Error(`${p.id}「${p.title}」判为${STATUS[p.status].label}，但没写下一步`);
  }
  return {
    id: p.id,
    featureLine: p.featureLine,
    title: p.title,
    method: p.method,
    status: p.status,
    observed: p.observed || '',
    next: p.status === 'pass' ? '' : p.next.trim(),
    link: p.link || '',
    shot: p.shot || '',
    tech: p.tech || '',
    // 只有前置项才可能是致命的：它失败意味着后面一项都没验成
    fatal: p.featureLine === 'environment' && Boolean(p.fatal),
  };
}

const worst = (statuses) => statuses.reduce(
  (acc, s) => (STATUS[s].rank < STATUS[acc].rank ? s : acc),
  'pass',
);

/**
 * 把逐条结果汇总成「功能线一行」的视图。
 * catalog 是业务功能台账（business-function-catalog.json），功能清单只认它这一份。
 * exempt 是「不进每日、交给 48 小时稳定冒烟」的功能线及理由。
 */
export function summarize({ results, catalog, exempt = {}, extraLines = [], base, at, env }) {
  const byLine = new Map();
  for (const r of results) {
    if (!byLine.has(r.featureLine)) byLine.set(r.featureLine, []);
    byLine.get(r.featureLine).push(r);
  }
  // extraLines：每日在验、但 48 小时台账还没收录的功能线（如缺陷管理）。
  // 单独标出来而不是硬塞进某条台账功能线下——挂错功能线等于谎报覆盖面。
  const allLines = [
    ...catalog.featureLines,
    ...extraLines.map((x) => ({ ...x, dailyOnly: true })),
  ];
  const known = new Set(allLines.map((f) => f.id));
  const stray = [...byLine.keys()].filter((k) => !known.has(k) && k !== 'environment');
  if (stray.length) throw new Error(`这些结果挂在台账里不存在的功能线上：${stray.join(', ')}`);

  const lines = allLines.map((f) => {
    const rs = byLine.get(f.id) || [];
    const isExempt = !rs.length && exempt[f.id];
    return {
      id: f.id,
      label: f.label,
      dailyOnly: Boolean(f.dailyOnly),
      criticality: f.criticality,
      breadcrumb: f.breadcrumb.join(' / '),
      entryPath: f.entryPath,
      status: isExempt ? 'exempt' : (rs.length ? worst(rs.map((r) => r.status)) : 'not-run'),
      exemptReason: isExempt ? exempt[f.id] : '',
      total: rs.length,
      passed: rs.filter((r) => r.status === 'pass').length,
      problems: rs.filter((r) => r.status !== 'pass'),
      results: rs,
    };
  });

  const envRows = byLine.get('environment') || [];
  const counted = lines.filter((l) => l.status !== 'exempt');
  const count = (s) => counted.filter((l) => l.status === s).length;
  const checks = results.filter((r) => r.featureLine !== 'environment');
  const verdict = envRows.some((r) => r.status !== 'pass') || count('fail') ? 'fail'
    : count('not-run') || count('warn') ? 'conditional' : 'pass';

  return {
    base, at, env, verdict,
    environment: envRows,
    lines: [...lines].sort((a, b) => rankLine(a) - rankLine(b)),
    counts: {
      lines: counted.length,
      pass: count('pass'),
      warn: count('warn'),
      fail: count('fail'),
      notRun: count('not-run'),
      exempt: lines.length - counted.length,
      checks: checks.length,
      checksPass: checks.filter((r) => r.status === 'pass').length,
    },
    results: [...results].sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank),
  };
}

function rankLine(l) {
  if (l.status === 'exempt') return 9;
  const crit = l.criticality === 'P0' ? 0 : 1;
  return STATUS[l.status].rank * 2 + crit;
}

/** 第一句话：先给结论（conclusion-before-numbers）。 */
export function headline(s) {
  const c = s.counts;
  // 只有「被测环境可达」这一项失败（ENV-01，致命）才能说「都没能验」。对象存储、账号这类
  // 非致命前置项失败时其余检查照样跑了，这么说会和表格自相矛盾（Codex 在 PR #1655 指出）。
  const envBad = s.environment.find((r) => r.status !== 'pass' && r.fatal);
  if (envBad) {
    // 写实际没验成的条数：「稳定性基线」那一行查的是 CDS，不依赖被测环境，照样验了
    return `被测环境本身不可用，${c.notRun} 条核心功能没能验：${envBad.observed}。下一步：${envBad.next}`;
  }
  if (s.verdict === 'pass') {
    return `${c.lines} 条核心功能全部正常（${c.checksPass}/${c.checks} 项检查通过）。`;
  }
  const bad = s.lines.filter((l) => l.status === 'fail').map((l) => l.label);
  const nr = s.lines.filter((l) => l.status === 'not-run').map((l) => l.label);
  const wn = s.lines.filter((l) => l.status === 'warn').map((l) => l.label);
  const parts = [];
  const envIssues = s.environment.filter((r) => r.status !== 'pass').map((r) => r.title);
  if (envIssues.length) parts.push(`前置项有问题：${envIssues.join('、')}`);
  if (bad.length) parts.push(`${bad.length} 条异常：${bad.join('、')}`);
  if (nr.length) parts.push(`${nr.length} 条没验成：${nr.join('、')}`);
  if (wn.length) parts.push(`${wn.length} 条需关注：${wn.join('、')}`);
  return `${c.lines} 条核心功能里 ${c.pass} 条正常，${parts.join('；')}。`;
}

/**
 * 归档标题：CDS 列表里最先被看到的就是它，必须和结论一致。
 * 环境 / 前置项出问题时功能线大多是「未执行」，按异常条数写会变成「0 条功能线异常」，
 * 恰好把一次几乎什么都没验成的运行说成没问题（Codex 在 PR #1655 指出）。
 */
export function archiveTitle(s) {
  const day = s.at.slice(0, 10);
  const c = s.counts;
  let tail;
  if (s.environment.some((r) => r.status !== 'pass' && r.fatal)) tail = `被测环境不可用，${c.notRun} 条功能线没验成`;
  else if (s.environment.some((r) => r.status !== 'pass')) tail = `前置项有问题，${c.fail} 条异常、${c.notRun} 条没验成`;
  else if (s.verdict === 'pass') tail = '全部正常';
  else if (c.fail) tail = `${c.fail} 条功能线异常`;
  else tail = [c.notRun ? `${c.notRun} 条没验成` : '', c.warn ? `${c.warn} 条需关注` : ''].filter(Boolean).join('、');
  return `每日核心功能验收 · ${day} · ${tail}`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const lineStatusLabel = (st) => (st === 'exempt' ? '不在每日范围' : STATUS[st].label);
// 归档版的状态徽标：CDS 用 marked 渲染，表格里的行内 HTML 会原样保留。颜色只是加强，文字照样在。
const BADGE = { fail: '#cf222e;color:#fff', 'not-run': '#fff4d6;color:#9a6700', warn: '#fff4d6;color:#9a6700', pass: '#e6f4ea;color:#1a7f37', exempt: '#eef0f2;color:#57606a' };
const badge = (st) => `<span style="display:inline-block;white-space:nowrap;padding:1px 8px;border-radius:999px;font-weight:600;font-size:12px;background:${BADGE[st]}">${lineStatusLabel(st)}</span>`;

/**
 * Markdown 版。
 *   默认（短版）：给 Routine 最终回复与推送用，只放结论 + 功能线一张表。
 *   full：归档进 CDS 验收中心的完整报告（CDS 对执行类 HTML 有模板准入，Markdown 走 marked 渲染），
 *         再加逐项明细表（验了什么、怎么验的、看到了什么）与异常项截图。
 */
export function renderMarkdown(s, { reportUrl, full = false } = {}) {
  const out = [];
  out.push(`## 每日核心功能验收 · ${s.at.slice(0, 10)}`);
  out.push('');
  out.push(`**${headline(s)}**`);
  out.push('');
  out.push(`被测环境：${s.base}${reportUrl ? ` · [完整报告（含截图）](${reportUrl})` : ''}`);
  out.push('');
  out.push('| 状态 | 核心功能 | 级别 | 今日检查通过 | 问题与下一步 |');
  out.push('|---|---|---|---|---|');
  for (const l of s.lines) {
    const note = l.status === 'exempt' ? l.exemptReason
      : l.problems.map((p) => `${p.title}：${p.observed}（下一步：${p.next}）`).join('；') || '—';
    out.push(`| ${full ? badge(l.status) : lineStatusLabel(l.status)} | ${mdCell(l.label)} | ${l.criticality} | ${l.status === 'exempt' ? '—' : `${l.passed}/${l.total}`} | ${mdCell(note)} |`);
  }
  if (s.environment.some((r) => r.status !== 'pass')) {
    out.push('');
    out.push('| 前置 | 结果 | 观察 | 下一步 |');
    out.push('|---|---|---|---|');
    for (const r of s.environment) out.push(`| ${mdCell(r.title)} | ${STATUS[r.status].label} | ${mdCell(r.observed)} | ${mdCell(r.next || '—')} |`);
  }
  if (!full) return out.join('\n');

  const label = new Map(s.lines.map((l) => [l.id, l.label]));
  label.set('environment', '前置：被测环境');
  out.push('');
  out.push('### 逐项明细：验了什么、怎么验的（异常置顶）');
  out.push('');
  out.push('| 结果 | 功能 | 验收项 | 怎么验 | 观察到的 | 入口 |');
  out.push('|---|---|---|---|---|---|');
  for (const r of [...s.environment, ...s.results.filter((x) => x.featureLine !== 'environment')]) {
    const seen = r.next ? `${r.observed}<br>**下一步：${r.next}**` : r.observed;
    out.push(`| ${badge(r.status)} | ${mdCell(label.get(r.featureLine) || r.featureLine)} | ${mdCell(r.title)} | ${mdCell(r.method)} | ${mdCell(seen)} | ${r.link ? `[打开](${r.link})` : '—'} |`);
  }
  const shots = s.results.filter((r) => r.status !== 'pass' && r.shot);
  if (shots.length) {
    out.push('');
    out.push('### 异常与需关注项的现场截图');
    for (const r of shots) {
      out.push('');
      out.push(`**${STATUS[r.status].label} · ${r.title}**：${r.observed}`);
      out.push('');
      out.push(`<img src="${r.shot}" alt="${esc(r.title)}" style="max-width:100%;border:1px solid #8884;border-radius:6px">`);
    }
  }
  out.push('');
  out.push('---');
  out.push('每日例程只跑只读、零成本的检查；真生成（出图、出视频、转录、解析）的完整闭环交给 48 小时稳定冒烟，「稳定性基线自身」那一行盯着它有没有按时跑。');
  return out.join('\n');
}

/** HTML 版：归档进 CDS 验收中心的完整报告，自包含（截图内联）。 */
export function renderHtml(s) {
  const pill = (st) => `<span class="pill ${st}">${esc(lineStatusLabel(st))}</span>`;
  const verdictLabel = { pass: '全部正常', conditional: '没有异常，但有没验成或需关注的项', fail: '有异常' }[s.verdict];

  const lineRows = s.lines.map((l) => {
    const note = l.status === 'exempt'
      ? `<span class="muted">${esc(l.exemptReason)}</span>`
      : (l.problems.length
        ? l.problems.map((p) => `<div><b>${esc(p.title)}</b>：${esc(p.observed)}<div class="next">下一步：${esc(p.next)}</div></div>`).join('')
        : '<span class="muted">无</span>');
    return `<tr class="row-${l.status}">
<td>${pill(l.status)}</td>
<td><b>${esc(l.label)}</b><div class="muted small">${esc(l.breadcrumb)}${l.dailyOnly ? ' · 48 小时台账未收录' : ''}</div></td>
<td>${esc(l.criticality)}</td>
<td class="num">${l.status === 'exempt' ? '—' : `${l.passed}/${l.total}`}</td>
<td>${note}</td></tr>`;
  }).join('\n');

  const label = new Map(s.lines.map((l) => [l.id, l.label]));
  label.set('environment', '前置：被测环境');
  const detailRows = [...s.environment, ...s.results.filter((r) => r.featureLine !== 'environment')].map((r) => `<tr class="row-${r.status}">
<td>${pill(r.status)}</td>
<td>${esc(label.get(r.featureLine) || r.featureLine)}</td>
<td><b>${esc(r.title)}</b>${r.link ? `<div class="small"><a href="${esc(r.link)}" target="_blank" rel="noopener">打开这一屏</a></div>` : ''}</td>
<td class="small">${esc(r.method)}</td>
<td class="small">${esc(r.observed)}${r.next ? `<div class="next">下一步：${esc(r.next)}</div>` : ''}${r.tech ? `<details><summary>技术细节</summary><code>${esc(r.tech)}</code></details>` : ''}</td>
<td>${r.shot ? `<a href="${r.shot}" target="_blank"><img src="${r.shot}" alt="${esc(r.title)} 截图"></a>` : '<span class="muted small">无</span>'}</td>
</tr>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>每日核心功能验收</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--muted:#6a737d;--line:#e3e6ea;
--ok:#1a7f37;--ok-bg:#e6f4ea;--bad:#cf222e;--bad-bg:#fdecec;--warn:#9a6700;--warn-bg:#fff4d6;--off:#57606a;--off-bg:#eef0f2}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1115;--card:#171a21;--fg:#e6e8eb;--muted:#9aa4af;--line:#2a2f38;
--ok:#4ac26b;--ok-bg:#12261a;--bad:#ff6b6b;--bad-bg:#2c1416;--warn:#e3b341;--warn-bg:#2b230f;--off:#9aa4af;--off-bg:#1f232b}}
:root[data-theme="dark"]{--bg:#0f1115;--card:#171a21;--fg:#e6e8eb;--muted:#9aa4af;--line:#2a2f38;
--ok:#4ac26b;--ok-bg:#12261a;--bad:#ff6b6b;--bad-bg:#2c1416;--warn:#e3b341;--warn-bg:#2b230f;--off:#9aa4af;--off-bg:#1f232b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 10px}
.meta{color:var(--muted);font-size:12px}
.hero{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--off);border-radius:10px;padding:16px 18px;margin:16px 0}
.hero.pass{border-left-color:var(--ok)}.hero.fail{border-left-color:var(--bad)}.hero.conditional{border-left-color:var(--warn)}
.hero .v{font-size:13px;color:var(--muted)}.hero .h{font-size:17px;font-weight:600;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:14px}
.kpi{background:var(--bg);border-radius:8px;padding:10px 12px}.kpi b{display:block;font-size:22px}.kpi span{font-size:12px;color:var(--muted)}
.kpi.fail b{color:var(--bad)}.kpi.warn b{color:var(--warn)}.kpi.pass b{color:var(--ok)}.kpi.not-run b{color:var(--warn)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;min-width:720px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:500;background:var(--bg);white-space:nowrap}
tr.row-fail td{background:var(--bad-bg)}tr.row-not-run td{background:var(--warn-bg)}
.pill{display:inline-block;white-space:nowrap;font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px}
.pill.pass{color:var(--ok);background:var(--ok-bg)}.pill.fail{color:#fff;background:var(--bad)}
.pill.not-run{color:var(--warn);background:var(--warn-bg);border:1px dashed var(--warn)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.exempt{color:var(--off);background:var(--off-bg)}
.muted{color:var(--muted)}.small{font-size:12px}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.next{margin-top:4px;font-size:12px;font-weight:600}
img{width:160px;max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}
a{color:inherit}details{margin-top:4px}code{font-size:11px;word-break:break-all;white-space:pre-wrap}
</style></head><body><main>
<h1>每日核心功能验收</h1>
<div class="meta">被测环境 ${esc(s.base)} · ${esc(s.at)}${s.env ? ` · ${esc(s.env)}` : ''}</div>
<section class="hero ${s.verdict}">
<div class="v">今日结论：${esc(verdictLabel)}</div>
<div class="h">${esc(headline(s))}</div>
<div class="kpis">
<div class="kpi fail"><b>${s.counts.fail}</b><span>异常</span></div>
<div class="kpi not-run"><b>${s.counts.notRun}</b><span>未执行</span></div>
<div class="kpi warn"><b>${s.counts.warn}</b><span>需关注</span></div>
<div class="kpi pass"><b>${s.counts.pass}</b><span>正常</span></div>
<div class="kpi"><b>${s.counts.checksPass}/${s.counts.checks}</b><span>检查项通过</span></div>
</div></section>
<h2>核心功能一览（异常置顶）</h2>
<div class="wrap"><table><thead><tr><th>状态</th><th>核心功能</th><th>级别</th><th>今日检查通过</th><th>问题与下一步</th></tr></thead>
<tbody>${lineRows}</tbody></table></div>
<h2>逐项明细：验了什么、怎么验的</h2>
<div class="wrap"><table><thead><tr><th>结果</th><th>功能</th><th>验收项</th><th>怎么验</th><th>观察到的</th><th>截图</th></tr></thead>
<tbody>${detailRows}</tbody></table></div>
<p class="meta">每日例程只跑只读、零成本的检查；生成类（真出图、真出视频、真转录）的完整闭环交给 48 小时稳定冒烟，见「不在每日范围」那几行的说明。</p>
</main></body></html>`;
}
