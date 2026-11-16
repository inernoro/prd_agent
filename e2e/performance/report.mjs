import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, digest, executionErrors } from './metrics.mjs';

const labels = { home:'登录后首页', 'knowledge-list':'知识库列表', 'document-open':'打开文档', write:'保存文档',
  'write-save':'保存正文', 'write-readback':'保存后回读', 'write-versions':'文档历史', journey:'整组操作' };
const seconds = ms => Number.isFinite(ms) ? `${(ms/1000).toFixed(ms>=1000?2:3)}秒` : '未取得';
const localTime = value => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date(value))+'（北京时间）' : '未取得';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function readableResult(result, baseline) {
  const normal = result.phases?.find(p=>p.name==='normal');
  const soak = result.phases?.find(p=>p.name==='soak');
  const incomplete = executionErrors(result).length || result.failure;
  const sameContract = digest(result.contract) === digest(baseline.contract);
  const positive = n => Number.isFinite(n) && n > 0;
  const names = Object.keys(normal?.metrics ?? {});
  const baselineReady = baseline.sourceRuns?.length >= 3 && names.length > 0
    && ['home','knowledge-list','document-open','write'].every(n=>positive(baseline.browserLimits?.[n]?.readyP95Ms))
    && names.every(n=>{
      const limit=baseline.limits?.[n];
      return limit && positive(limit.clientP95) && positive(limit.minThroughput)
        && Number.isFinite(limit.errorRate) && limit.errorRate>=0 && limit.errorRate<=1
        && (['write','journey'].includes(n) ? limit.appP95===null : positive(limit.appP95));
    });
  const comparison = incomplete || !sameContract || !baselineReady ? {pass:false,failures:[]} : compare(result, baseline);
  const insufficient = comparison.failures.some(line=>line.includes('样本不足'));
  const intentionalFault = Boolean(result.browserInjection?.delayMs || result.injectionMs);
  const faultUnproven = intentionalFault && comparison.pass;
  const status = incomplete || !sameContract || !baselineReady || insufficient || faultUnproven ? 'unknown' : comparison.pass ? 'healthy' : 'degraded';
  const unknownReason = incomplete ? '测试没有完整结束，不能把未测完当作通过。'
    : !sameContract ? '测试条件与正常速度对照不同，不能直接比较。'
    : !baselineReady ? '缺少完整的正常速度对照，暂时不能判断是否变慢。'
    : insufficient ? '有效操作次数不足，暂时不能判断是否变慢。'
    : faultUnproven ? '已设置故意拖慢，但没有触发超限，不能认定识别试验成功。' : '';
  const reasons = [...new Set(comparison.failures.map(line => {
    const match = /^(browser|normal|soak)\/([^:]+):/.exec(line);
    if(!match) return '缺少可比较的完整证据';
    const name = labels[match[2]] ?? '核心操作';
    const timing = /(?:ready|client|app) p95 ([\d.]+) > ([\d.]+) ms/.exec(line);
    if(timing) {
      const actual=Number(timing[1]),limit=Number(timing[2]);
      return `${name}：${match[1]==='browser'?'页面等待':line.includes('app p95')?'应用内部处理':'相关操作返回'}${seconds(actual)}，正常允许上限${seconds(limit)}，超出${seconds(actual-limit)}。`;
    }
    return line.includes('errorRate') ? `${name}：失败比例超过基线`
      : line.includes('吞吐') ? `${name}：处理速度低于基线`
      : `${name}：${match[1]==='browser'?'页面等待':line.includes('app p95')?'后台处理':'请求'}时间超过基线`;
  }))];
  const injected = result.browserInjection?.delayMs ? '故意拖慢首页的验证'
    : result.injectionMs ? '故意拖慢后台的验证' : result.execution?.profile==='all' ? '正常、并发增长和持续运行' : '正常负载检查';
  const rows = ['home','knowledge-list','document-open','write'].map(name=>({name:labels[name],
    page:seconds(result.browser?.samples?.[name]?.length ? Math.max(...result.browser.samples[name]) : null),
    limit:seconds(baseline.browserLimits?.[name]?.readyP95Ms),
    backend:seconds(normal?.metrics?.[name]?.client?.p95)}));
  const attribution = ['home','knowledge-list','document-open','write-save'].map(name=>{
    const m=normal?.metrics?.[name];
    return {name:labels[name],app:seconds(m?.app?.n?m.app.p95:null),external:seconds(m?.externalHttp?.n?m.externalHttp.p95:null)};
  });
  const resources = ['api','mongo','redis','web'].map(role=>{
    const samples=(result.resources??[]).flatMap(r=>r.samples??[]).filter(s=>s.role===role);
    return {name:{api:'应用后台',mongo:'数据库',redis:'缓存',web:'页面入口'}[role],
      cpu:samples.length?`${(Math.max(...samples.map(s=>s.cpuPercent??0))/100).toFixed(2)}个核`:'未取得',
      memory:samples.length?`${Math.round(Math.max(...samples.map(s=>s.rssBytes??0))/1024**2)}MB`:'未取得'};
  });
  const c = result.capacity;
  const capacity = c?.stages?.length ? c.firstDegradedUsers
    ? `同时进行${c.firstDegradedUsers}组操作时，部分步骤耗时已超过平时两倍或失败比例超过1%。`
    : `已测到${c.lastTestedUsers}组同时操作，尚未达到本次设定的退化边界。`
    : '本轮没有执行并发增长测试，不能据此判断承载边界。';
  const peak = c?.stages?.length ? `本次最高处理速度约为每秒${Math.round(Math.max(...c.stages.map(s=>s.journeysPerSecond)))}组完整操作。` : '';
  const count = phase => phase?.metrics?.journey
    ? `${phase.metrics.journey.attempts}组操作，${phase.metrics.journey.errors}组失败` : '未执行';
  return {status, title:status==='healthy'?'本轮检查通过：未发现超出正常范围的变慢':status==='degraded'?'本轮检查不通过：发现变慢或失败增加':'暂时不能判断本轮是否通过',
    scene:injected,reasons:status==='degraded'?reasons:[],unknownReason,attribution,resources,
    rows,normal:count(normal),soak:count(soak),capacity,peak,
    commit:result.commit,date:localTime(result.finishedAt ?? result.startedAt),
    outcome:status==='healthy'?'本轮结果可通过所设检查门槛。':status==='degraded'
      ? intentionalFault?'本次故意拖慢，出现“不通过”符合预期；正常版本是否变慢，请看正常检查报告。':'本轮检查不通过，需要处理上面的变化。'
      :unknownReason};
}
export function renderReport(v) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAP 性能检查结果</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#202a33;font:16px/1.65 system-ui,"Noto Sans CJK SC",sans-serif}main{max-width:1120px;margin:32px auto;padding:0 28px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:28px;margin:0}small,.muted{color:#66727c}.hero{margin:22px 0;padding:24px 28px;border:1px solid;border-radius:16px;background:#eff8f0;border-color:#abcdb1}.degraded{background:#fff0ec;border-color:#e0ada0}.unknown{background:#fff6df;border-color:#d8c18e}h2{font-size:25px;margin:4px 0 8px}.hero p{margin:4px 0}section{background:white;border:1px solid #dce1df;border-radius:14px;padding:20px 24px;margin:16px 0}h3{font-size:19px;margin:0 0 12px}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #e6e9e7;padding:10px 8px}th{font-size:14px;color:#55636d}tr:last-child td{border:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid section{margin:0}ul{margin:8px 0;padding-left:22px}.note{font-size:14px}footer{margin:20px 0;color:#66727c;font-size:13px}@media(max-width:700px){.grid{grid-template-columns:1fr}main{padding:0 14px}table{font-size:13px}h2{font-size:21px}}
</style><main><header><h1>MAP 性能检查</h1><small>隔离测试结果 · 不代表生产上线</small></header>
<div class="hero ${v.status}"><small>${esc(v.scene)}</small><h2>${esc(v.title)}</h2><p>${esc(v.outcome)}</p>${v.reasons.length?`<ul>${v.reasons.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</div>
<section><h3>四条用户路径，分别花了多久</h3><table><tr><th>用户操作</th><th>本次页面最慢一次</th><th>正常允许上限</th><th>后台相关操作</th></tr>${v.rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.page}</td><td>${r.limit}</td><td>${r.backend}</td></tr>`).join('')}</table><p class="muted note">页面时间来自真实点击、内容出现及保存刷新。后台一栏是95%的相关操作能够完成的时间，包含请求往返；两者不能互相替代。</p></section>
<div class="grid"><section><h3>有没有操作失败</h3><p>正常负载：${esc(v.normal)}</p><p>持续运行：${esc(v.soak)}</p></section><section><h3>从多大压力开始退化</h3><p>${esc(v.capacity)}</p><p>${esc(v.peak)}</p><small>这是本次测试机和固定数据下的结果，不是线上人数上限。</small></section></div>
<section><h3>等待时间花在哪儿</h3><table><tr><th>后台步骤</th><th>应用内部处理</th><th>外部网络服务</th></tr>${v.attribution.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.app}</td><td>${r.external}</td></tr>`).join('')}</table><p class="muted note">这里也是95%的请求耗时。应用内部包含数据库、缓存和排队；外部一栏只统计本次请求调用的外部网络服务，不把应用内部变慢归给模型服务。</p></section>
<section><h3>测试机资源消耗</h3><table><tr><th>部分</th><th>最高CPU占用</th><th>最高内存占用</th></tr>${v.resources.map(r=>`<tr><td>${r.name}</td><td>${r.cpu}</td><td>${r.memory}</td></tr>`).join('')}</table><p class="muted note">统计为各进程的峰值，内存可能重复包含共享部分。承载结果仅对本次测试机和固定数据有效。</p></section>
<section><h3>哪些结论还不能承诺</h3><p>本页只说明这轮隔离测试的结果，不表示线上已启用自动保护。是否自动触发，以对应的开发检查记录为准。所有压力仅施加在隔离测试环境，未购买资源，也未发布生产。</p></section>
<footer>实测应用版本 ${esc(v.commit)} · 记录时间 ${esc(v.date)}。详细原始记录留作追溯，无需阅读它们才能理解本页。</footer></main></html>`;
}
export function renderSummary(v) {
  return `\n### MAP 性能检查：${v.scene}\n\n**${v.title}**\n\n${v.outcome}\n\n${v.reasons.map(x=>`- ${x}`).join('\n')}\n\n| 用户操作 | 本次页面最慢一次 | 正常允许上限 |\n|---|---|---|\n${v.rows.map(r=>`| ${r.name} | ${r.page} | ${r.limit} |`).join('\n')}\n\n正常负载：${v.normal}；持续运行：${v.soak}。\n\n${v.capacity}${v.peak}\n\n仅为本轮隔离测试结果，不代表生产人数上限或线上自动保护已启用。\n`;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [resultFile,baselineFile,...rest]=process.argv.slice(2);const options={};
  for(let i=0;i<rest.length;i+=2){if(!['--out','--summary'].includes(rest[i])||!rest[i+1])throw new Error('参数: RESULT BASELINE --out work/REPORT.html [--summary FILE]');options[rest[i].slice(2)]=rest[i+1];}
  if(!resultFile||!baselineFile||!options.out)throw new Error('需要实际结果、基线及输出路径');
  const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
  const target=path.resolve(options.out);if(!target.startsWith(path.join(root,'work')+path.sep))throw new Error('报告输出仅限仓库work目录');
  const view=readableResult(JSON.parse(fs.readFileSync(resultFile)),JSON.parse(fs.readFileSync(baselineFile)));
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,renderReport(view));
  if(options.summary)fs.appendFileSync(options.summary,renderSummary(view));
  console.log(view.title);
}
