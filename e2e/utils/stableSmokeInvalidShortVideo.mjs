import assert from 'node:assert/strict';

export const invalidShortVideoText = '这不是链接';
const runRoute = '**/api/short-video-materials/runs**';

export async function installInvalidShortVideoRunGuard(page, inspectionRunId) {
  assert.match(inspectionRunId, /^stsmk-[a-zA-Z0-9-]+$/, '必须使用本轮stsmk-标识');
  const blockedRequests = [];
  const handler = async route => {
    const request = route.request();
    if (request.method() === 'POST'
      && /^\/api\/short-video-materials\/runs\/?$/.test(new URL(request.url()).pathname)) {
      blockedRequests.push({ method: 'POST', path: '/api/short-video-materials/runs' });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  };
  await page.route(runRoute, handler);
  return {
    snapshot: () => ({ inspectionRunId, blockedRequests: [...blockedRequests], runCreateRequests: blockedRequests.length }),
    assertNoRunRequests() {
      assert.equal(blockedRequests.length, 0, '非法文本必须在前端拒绝；任何任务创建请求均保持失败，不能用abort冒充通过');
    },
    dispose: () => page.unroute(runRoute, handler),
  };
}

export async function observeInvalidShortVideoInput({ input, submit, errorTitle, errorDetail, scope }) {
  await input.fill(invalidShortVideoText);
  await submit.click();
  await errorTitle.waitFor({ state: 'visible' });
  await errorDetail.waitFor({ state: 'visible' });
  const inputValue = await input.inputValue();
  const title = (await errorTitle.innerText()).trim();
  const detail = (await errorDetail.innerText()).trim();
  assert.equal(inputValue, invalidShortVideoText, '拒绝后必须保留原输入，允许用户重新粘贴');
  assert.match(title, /没有识别到短视频链接/);
  assert.match(detail, /请粘贴/);
  assert.match(detail, /抖音|TikTok|快手|B 站/);
  assert.doesNotMatch(`${title} ${detail}`, /\bHTTP\b|\btoken\b|\bProvider\b|API\s*key|stack\s*trace|Exception|System\./i);
  scope.assertNoRunRequests();
  return { inputValue, title, detail, ...scope.snapshot(), proofBoundary: '仅真实前端非法文本拒绝与零任务请求，不证明后端400或私有/失效链接恢复' };
}
