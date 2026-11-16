import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { openFixtureDocument, installOnboardingHandler, dismissOnboarding, classifyPageHttpErrors } from './browser-path.mjs';

test('计划重启只接受窗口内502，恢复502及其他错误都拒绝且原始响应不变', () => {
  const requests = [{stage:'api-restart',status:502},{stage:'api-recovery',status:502},
    {stage:'api-restart',status:500},{stage:'api-restart',status:401},{stage:'home',status:404}];
  const original = structuredClone(requests);
  const classified = classifyPageHttpErrors(requests);
  assert.deepEqual(classified.expectedRestartErrors,[requests[0]]);
  assert.deepEqual(classified.unexpectedHttpErrors,requests.slice(1));
  assert.deepEqual(requests,original);
});

test('同名卡片预览不能冒充实际目录点击，桌面和窄屏均打开指定文档', async () => {
  // Deterministic DOM fixture for the real card/tree identity collision.
  // This unit regression does not replace the real application's UI journey.
  const server = createServer((_, response) => response.end(`<!doctype html><meta charset="utf-8">
    <section data-store-card="store-a"><h3>性能知识库-0</h3><span>性能文档-0-0</span></section>
    <section id="reader" hidden><button data-entry-id="doc-a">性能文档-0-0</button>
    <p id="body" hidden>MAP性能样例</p></section><script>
    document.querySelector('[data-store-card]').onclick=()=>{
      reader.hidden=false;history.replaceState({},'', '?store=store-a&entry=wrong-document');
    };
    document.querySelector('[data-entry-id]').onclick=()=>{
      body.hidden=false;history.replaceState({},'', '?store=store-a&entry=doc-a');
    };
    </script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PERF_CHROMIUM_PATH || undefined });
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByText('性能知识库-0', { exact: true }).first().click();
      await page.getByText('性能文档-0-0', { exact: true }).first().click();
      assert.equal(new URL(page.url()).searchParams.get('entry'), 'wrong-document', '旧定位实际点中卡片预览');
      assert.equal(await page.getByText('MAP性能样例', { exact: true }).isVisible(), false);
      const opened = await openFixtureDocument(page, { storeId: 'store-a', entryId: 'doc-a' });
      assert.equal(new URL(opened.url).searchParams.get('entry'), 'doc-a');
      assert.equal(await page.getByText('MAP性能样例', { exact: true }).isVisible(), true);
      await page.evaluate(() => {
        const button=document.createElement('button');button.textContent='我已学会';
        button.onclick=()=>button.remove();document.body.append(button);
      });
      let dismissed=0;
      await installOnboardingHandler(page,()=>dismissed++);
      await dismissOnboarding(page);
      assert.equal(dismissed,1,'显式关闭不能被自动handler拦截两次');
      assert.equal(await page.getByRole('button',{name:'我已学会',exact:true}).count(),0);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
