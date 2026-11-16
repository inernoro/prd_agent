import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { attachAutoCapture, box, shot, manifest, writeManifest } from '../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';
import { finalizeEvidence, reconcilePageCases } from './evidence.mjs';

test('最后一图之后真实HTTP500必须同步拒绝上层验收，原始失败保留', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'map-late-evidence-'));
  const server=createServer((request,response)=>{
    if(request.url==='/late-error') { response.writeHead(500,{'Content-Type':'application/json'});response.end('{"error":"intentional test fixture"}');return; }
    response.end('<!doctype html><meta charset="utf-8"><h1>最终证据阻断回归</h1><p>'+('这是一份用于验证测试工具的页面替身，真实HTTP错误将在最后截图之后到达，不代表产品页面。'.repeat(8))+'</p>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:process.env.PERF_CHROMIUM_PATH||undefined});
    const page=await browser.newPage({viewport:{width:1440,height:900}});attachAutoCapture(page);
    const record={id:'late-500',pass:true,requests:[],pageErrors:[]};
    page.on('response',r=>record.requests.push({stage:'saved-refresh',status:r.status()}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('heading',{name:'最终证据阻断回归'}).waitFor();
    await box(page,page.getByRole('heading'),'看这里：截图后迟到错误的工具回归');
    const first=await shot(page,directory,'01-before-late-error','内部工具：截图时尚未发生500',{skipReady:true,expectText:'最终证据阻断回归'});
    assert.equal(first.warnings,undefined);
    assert.deepEqual(reconcilePageCases([record]),[]);
    const errorResponse=page.waitForResponse(r=>r.url().endsWith('/late-error')&&r.status()===500);
    await page.evaluate(()=>fetch('/late-error'));await errorResponse;
    await browser.close();browser=null;
    assert.equal(record.pass,true,'旧中途检查在迟到错误之后仍保留通过快照');
    assert.equal(reconcilePageCases([record]).length,1);
    assert.equal(record.pass,false,'不启用标准截图时也必须核对关闭后的原始页面错误');
    const oldResult={pass:true,state:'complete'};
    writeManifest(directory,{verdict:'pass'});
    assert.equal(oldResult.pass,true,'旧调用方未联动最终证据，仍会放行');
    assert.ok(manifest().at(-1).warnings.some(w=>w.includes('HTTP 500')));
    const result={pass:true,state:'complete'};finalizeEvidence(result,directory,{target:'迟到500内部反例'});
    assert.equal(result.pass,false);assert.equal(result.state,'failed');
    assert.ok(result.evidenceBlockers.some(w=>w.includes('HTTP 500')));
    const finalized=JSON.parse(fs.readFileSync(path.join(directory,'result.json')));
    assert.equal(finalized.verdict,'fail');assert.equal(finalized.autoFindingsSummary.P0,1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')))[0].warnings.some(w=>w.includes('HTTP 500')));
  } finally {
    await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});
  }
});
