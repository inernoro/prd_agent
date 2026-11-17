import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { waitForEntryPreviews } from './entry-preview-readiness.mjs';

const bytes = new TextEncoder().encode('actual new portrait film');
const motion = { fileName: 'portrait-motion-000000000000.mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
const expectedCommit = 'a'.repeat(40);
function fixture({ mapReady = () => true, mapMedia = () => bytes, mapCommit = () => expectedCommit } = {}) {
  let tick = 0;
  const calls = [];
  return {
    calls,
    options: { map: new URL('https://map.test'), gateway: new URL('https://gateway.test'), motion, expectedCommit,
      now: () => tick, timeoutMs: 3, retryMs: 1, sleep: async () => { tick++; }, log: () => {},
      fetcher: async input => {
        const url = new URL(input); calls.push(url.href);
        const isMap = url.hostname === 'map.test';
        if (url.pathname === '/') return new Response(`<script type="module" src="/assets/index.js"></script><script>var BRANCH_ID='${url.hostname}'</script>`);
        if (url.pathname === '/_cds/api/branches') return Response.json({ branches: [{ id: url.hostname, runningCommitSha: isMap ? mapCommit(tick) : expectedCommit }] });
        if (url.pathname === '/assets/index.js') return new Response(`direct-night ${isMap && !mapReady(tick) ? 'portrait-motion-older.mp4' : motion.fileName}`);
        if (url.pathname === `/media/entry/${motion.fileName}`) return new Response(isMap ? mapMedia(tick) : bytes);
        return new Response('not found', { status: 404 });
      } },
  };
}
test('Gateway 已更新而 MAP 仍引用旧素材时不能放行真实登录', async () => {
  const f = fixture({ mapReady: () => false });
  await assert.rejects(waitForEntryPreviews(f.options), /map\.test: expected entry artwork not referenced/);
  assert.ok(f.calls.includes('https://gateway.test/assets/index.js'));
  assert.ok(f.calls.includes('https://map.test/assets/index.js'));
});
test('等待 MAP 完成更新后才同时交付两端的实际包与素材证据', async () => {
  const f = fixture({ mapReady: tick => tick >= 1 });
  const result = await waitForEntryPreviews(f.options);
  assert.deepEqual(result.apps.map(app => [app.app, app.ready, app.commit, app.mediaSha256]),
    [['map', true, expectedCommit, motion.sha256], ['gateway', true, expectedCommit, motion.sha256]]);
  assert.ok(f.calls.filter(url => url === 'https://map.test/assets/index.js').length >= 2);
});
test('分支版本已更新但 MAP 媒体内容仍旧时不得放行', async () => {
  const f = fixture({ mapMedia: () => new TextEncoder().encode('stale cached film') });
  await assert.rejects(waitForEntryPreviews(f.options), /map\.test: portrait media hash differs/);
});
test('两端素材都有但 MAP 尚未运行预期提交时继续等待', async () => {
  const f = fixture({ mapCommit: () => 'b'.repeat(40) });
  await assert.rejects(waitForEntryPreviews(f.options), /map\.test: expected revision not running/);
});
