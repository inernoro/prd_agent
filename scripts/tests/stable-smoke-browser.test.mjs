import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { blockStableSmokeServiceWorkerRegistration } from '../../e2e/utils/stableSmokeBrowser.mjs';

test('opaque srcDoc 的 SecurityError 可容忍，其它错误仍失败', () => {
  const navigator = {};
  Object.defineProperty(navigator, 'serviceWorker', { get() { const e = Error('opaque'); e.name = 'SecurityError'; throw e; } });
  assert.doesNotThrow(() => runInNewContext(`(${blockStableSmokeServiceWorkerRegistration})()`, { navigator }));
  const bad = {};
  Object.defineProperty(bad, 'serviceWorker', { get() { throw Error('unexpected'); } });
  assert.throws(() => runInNewContext(`(${blockStableSmokeServiceWorkerRegistration})()`, { navigator: bad }), /unexpected/);
});
test('普通主页面注册不能绕过请求拦截', async () => {
  let called = false; const worker = { register() { called = true; } };
  runInNewContext(`(${blockStableSmokeServiceWorkerRegistration})()`, { navigator: { serviceWorker: worker }, console: { warn() {} } });
  await worker.register('/synthetic-sw.js'); assert.equal(called, false);
});
test('只在精确开关下替换原生阻断，所有独立context必须先安装安全阻断', () => {
  const config = readFileSync(new URL('../../e2e/playwright.config.ts', import.meta.url), 'utf8');
  assert.match(config, /const STABLE_SMOKE_RUN = process.env.STABLE_SMOKE_RUN === '1'/);
  assert.doesNotMatch(config, /Boolean\(process.env.STABLE_SMOKE_RUN\)/);
  assert.match(config, /serviceWorkers: 'block'/);
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  assert.match(source, /test.use\(\{ serviceWorkers: process.env.STABLE_SMOKE_RUN === '1' \? 'allow' : 'block' \}\)/);
  assert.match(source, /context.addInitScript\(blockStableSmokeServiceWorkerRegistration\)/);
  for (const block of source.split('browser.newContext(').slice(1)) {
    assert.ok(block.indexOf('addInitScript(blockStableSmokeServiceWorkerRegistration)') >= 0);
    assert.ok(block.indexOf('addInitScript(blockStableSmokeServiceWorkerRegistration)') < block.indexOf('.newPage()'));
  }
});
