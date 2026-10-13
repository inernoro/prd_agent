import test from 'node:test';
import assert from 'node:assert/strict';
import { enterVisualFromHome } from '../../e2e/utils/stableSmokeNavigation.mjs';

test('手机用生图真实触控，错误桌面名称会变红，不借goto直达', async () => {
  const calls = [];
  let pathname = '/';
  const page = {
    url: () => 'https://fixture.test' + pathname,
    locator: () => ({}),
    getByText: label => entry(label),
    getByRole: (role, options) => { assert.equal(role, 'button'); assert.equal(options.exact, true); return entry(options.name); },
    waitForURL: async predicate => { assert.ok(predicate(new URL(page.url()))); },
  };
  const entry = label => ({ and: () => ({
      first: () => ({ waitFor: async () => { if (label !== '生图') throw Error('入口缺失'); } }),
      count: async () => 1,
      tap: async () => { calls.push(label); pathname = '/visual-agent'; },
      click: async () => { throw Error('不能把手机当桌面点击'); },
    }) });
  await assert.rejects(enterVisualFromHome(page, { touch: false }), /入口缺失/);
  assert.deepEqual(await enterVisualFromHome(page, { touch: true }), { label: '生图', path: '/visual-agent', realClick: true, touch: true });
  assert.deepEqual(calls, ['生图']);
  await assert.rejects(enterVisualFromHome(page, { touch: true }), /真实首页/);
});
