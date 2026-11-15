import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readableResult, renderReport } from './report.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const baseline=read('./baseline.core-write.reference.json');
const fault=read('./evidence/core-write/injected-browser.result.json');
test('真实首页负例直接说明哪条用户路径变慢，不能生成通过结论',()=>{
  const view=readableResult(fault,baseline);
  assert.equal(view.status,'degraded');assert.ok(view.reasons.some(x=>x.includes('登录后首页')));
  assert.ok(renderReport(view).includes('本轮检查不通过'));
});
test('缺少执行终态的报告不能因原比较标签而显示通过',()=>{
  const partial=structuredClone(fault);partial.execution.state='running';partial.comparison={pass:true,failures:[]};
  assert.equal(readableResult(partial,baseline).status,'unknown');
});
test('不同基线合同不能被报告成应用性能退化',()=>{
  const other=structuredClone(baseline);other.contract={changed:true};
  assert.equal(readableResult(fault,other).status,'unknown');
});
test('正常速度对照缺少门槛时应无法判断，不能误报为应用变慢',()=>{
  const missing=structuredClone(baseline);missing.limits={};missing.browserLimits={};
  const view=readableResult(fault,missing);
  assert.equal(view.status,'unknown');
  assert.ok(view.outcome.includes('缺少完整的正常速度对照'));
  assert.equal(view.reasons.length,0);
});
test('真实首页退化必须直接说明等待多久、上限多久及超出多久',()=>{
  const view=readableResult(fault,baseline);
  assert.ok(view.reasons.some(x=>x.includes('11.07秒')&&x.includes('2.93秒')&&x.includes('8.14秒')));
});
test('设置了故意拖慢但没有检测到超限时，不能把识别试验显示为通过',()=>{
  const noEffect=structuredClone(fault);noEffect.browser.samples.home=[500,500,500];
  const view=readableResult(noEffect,baseline);
  assert.equal(view.status,'unknown');
  assert.ok(view.outcome.includes('不能认定识别试验成功'));
});
