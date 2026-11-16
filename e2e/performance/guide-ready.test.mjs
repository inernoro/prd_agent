import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { installOnboardingHandler, settleKnowledgeOnboarding } from './browser-path.mjs';

test('真实教程载入及可见引导完成后才报告知识库可用，桌面窄屏均覆盖', async () => {
  // Internal DOM fixture for the observed guide/bootstrap race. It does not
  // replace MAP's real login, document write/readback or mobile acceptance.
  let release, requested, responseGate, learned = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/daily-tips/visible') {
      requested(); await responseGate;
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({success:true,data:{items:[{sourceId:'document-store-page-guide',actionUrl:'/document-store',learned}]}}));
      return;
    }
    response.end(`<!doctype html><meta charset="utf-8"><h1>内部教程竞态回归</h1>
      <section data-store-card="store-a"><h2>性能知识库-0</h2></section>
      <script>window.bootstrapPending=true;window.guideClicks=0;
      fetch('/api/daily-tips/visible').then(r=>r.json()).then(body=>{
        if(!body.data.items[0].learned){
          const guide=document.createElement('div');guide.id='guide';guide.setAttribute('aria-label','关闭高亮引导');
          guide.style='position:fixed;inset:100px 0 0;z-index:9997;background:#0008';
          const button=document.createElement('button');button.textContent='我已学会';
          button.onclick=()=>{window.guideClicks++;guide.remove()};guide.append(button);document.body.append(guide);
        }
        window.bootstrapPending=false;window.bootstrapRendered=true;
      });</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:process.env.PERF_CHROMIUM_PATH||undefined});
    for(const width of [1440,390]) for(learned of [false,true]) {
      responseGate=new Promise(resolve=>release=resolve);
      const requestArrived=new Promise(resolve=>requested=resolve);
      const page=await browser.newPage({viewport:{width,height:900}});
      let dismissals=0;await installOnboardingHandler(page,()=>dismissals++);
      await page.goto(`http://127.0.0.1:${server.address().port}/document-store`);
      await requestArrived;
      let complete=false;
      const ready=settleKnowledgeOnboarding(page).then(()=>complete=true);
      // Browser protocol barriers, not a fixed delay used to infer readiness.
      await page.title();await page.evaluate(()=>window.bootstrapPending);
      assert.equal(complete,false,'真实教程尚未载入不可报告页面准备完成');
      release();await ready;
      await page.removeLocatorHandler(page.getByRole('button',{name:'我已学会',exact:true}));
      await page.waitForFunction(()=>window.bootstrapRendered===true);
      assert.equal(await page.locator('[aria-label="关闭高亮引导"]').count(),0);
      assert.equal(dismissals,learned?0:1,'实际关闭一次，不能由自己的handler重复消费');
      assert.equal(await page.evaluate(()=>window.guideClicks),learned?0:1);
      assert.equal(await page.getByText('性能知识库-0',{exact:true}).isVisible(),true);
      await page.evaluate(()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.textContent='不相关的真实异常';document.body.append(d)});
      await settleKnowledgeOnboarding(page);
      assert.equal(await page.getByRole('dialog').count(),1,'不能为变绿移除不相关弹窗');
      await page.close();
    }
  } finally {
    release?.();await browser?.close();server.closeAllConnections?.();
    await new Promise(resolve=>server.close(resolve));
  }
});
