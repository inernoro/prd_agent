// 实战证明: MD→PPT 用 CDS Agent 引擎生成,采集 diag 时间线 + HTML 产出
import { loadConfig, launch, login, gotoByClick, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_cdseng';
const { browser, page } = await launch(cfg);
const MD = '# AI 编程的信息损耗\n\n- 传统流程四层信息衰减\n- 端到端编程减少漂移\n\n---\n\n# 行业集体幻觉\n\n- 新工具循环\n- 守门员效应';
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  // 切到 CDS Agent 引擎
  const eng = page.locator('button:has-text("CDS Agent")').first();
  const switched = await eng.count();
  if (switched) await eng.click({ timeout: 5000 }).catch(e=>console.log('SWITCH_ERR',e.message));
  await page.waitForTimeout(500);
  await page.locator('textarea').first().fill(MD);
  await shot(page, OUT, '01-agent-engine-input', 'CDS Agent 引擎已选 + 输入');
  await page.locator('button:has-text("生成")').first().click({ timeout: 8000 }).catch(e=>console.log('GEN_ERR',e.message));
  // 等结果(CDS Agent 链路),最多 150s,期间每 20s 截一张看 diag/进度
  let done=false, errored=false;
  for (let i=0;i<30;i++){
    await page.waitForTimeout(5000);
    const st = await page.evaluate(()=>({
      hasIframe: !!(document.querySelector('iframe')&&(document.querySelector('iframe').getAttribute('srcdoc')||'').length>200),
      hasErr: /生成失败|HTTP 5\d\d|错误/.test(document.body.innerText),
      streamLen: (document.body.innerText.match(/<section|<!DOCTYPE|reveal/gi)||[]).length,
      diagCount: (document.body.innerText.match(/elapsedMs|stage|TOOL_LOOP|text_delta|tool_call|会话创建|首个事件/gi)||[]).length,
    }));
    if (i%4===0) await shot(page, OUT, `02-progress-${i}`, `CDS Agent 进度 ${i*5}s`);
    if (st.hasIframe){done=true;break;}
    if (st.hasErr){errored=true;break;}
  }
  await page.waitForTimeout(1500);
  await shot(page, OUT, '03-agent-final', 'CDS Agent 最终态(HTML 或错误或诊断)');
  const probe = await page.evaluate(()=>{
    const f=document.querySelector('iframe');
    const txt=document.body.innerText;
    // 抓诊断面板里的关键行
    const diagLines=(txt.match(/[^\n]*(elapsedMs|stage|TOOL_LOOP|text_delta|tool_call|首个事件|会话|alarm)[^\n]*/gi)||[]).slice(0,15);
    return { iframeHasHtml: !!(f&&(f.getAttribute('srcdoc')||'').includes('reveal')), srcdocLen: f?(f.getAttribute('srcdoc')||'').length:0, hasError:/生成失败|HTTP 5\d\d/.test(txt), diagLines };
  });
  console.log('CDSENG_PROOF', JSON.stringify({ switched: !!switched, done, errored, probe }, null, 1));
  writeManifest(OUT);
} catch(e){ console.error('ERR', e.message); try{await shot(page,OUT,'99-err',e.message);}catch{} }
finally { await browser.close(); }
