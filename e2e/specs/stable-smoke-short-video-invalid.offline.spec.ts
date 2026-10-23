import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { installInvalidShortVideoRunGuard, observeInvalidShortVideoInput } from '../utils/stableSmokeInvalidShortVideo.mjs';

// 本地真实DOM判据，不连接部署、不读取账号，不计入业务115项。
for (const mode of ['valid', 'request', 'leak', 'clear'] as const) {
  test(`非法短视频输入离线DOM：${mode}`, async ({ page, context }) => {
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const scope = await installInvalidShortVideoRunGuard(page, 'stsmk-20261024-offline');
    try {
      await page.setContent('<textarea aria-label="链接"></textarea><button>解析</button><p id="title" hidden>没有识别到短视频链接</p><p id="detail" hidden>请粘贴抖音、TikTok、快手或 B 站等短视频链接</p>');
      await page.evaluate(mode => {
        document.querySelector('button')!.onclick = () => {
          document.getElementById('title')!.hidden = false;
          document.getElementById('detail')!.hidden = false;
          if (mode === 'clear') document.querySelector('textarea')!.value = '';
          if (mode === 'leak') document.getElementById('detail')!.textContent += ' Provider HTTP 502';
          if (mode === 'request') void fetch('https://offline.invalid/api/short-video-materials/runs', { method: 'POST', body: '{}' }).catch(() => {});
        };
      }, mode);
      const action = () => observeInvalidShortVideoInput({
        input: page.getByRole('textbox', { name: '链接' }), submit: page.getByRole('button', { name: '解析' }),
        errorTitle: page.locator('#title'), errorDetail: page.locator('#detail'), scope,
      });
      if (mode === 'valid') {
        const proof = await action();
        assert.equal(proof.runCreateRequests, 0);
        assert.equal(proof.inputValue, '这不是链接');
      } else {
        await assert.rejects(action(), mode === 'request' ? /任何任务创建请求/ : mode === 'clear' ? /保留原输入/ : /HTTP|Provider/);
      }
    } finally {
      await scope.dispose();
    }
  });
}
