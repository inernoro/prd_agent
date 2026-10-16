import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertRealLiteraryMarkerStream, assertLiteraryWorkspacePersisted, deleteAndVerifyLiteraryWorkspace } from '../../e2e/utils/stableSmokeLiterary.mjs';

const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const mobileStart = source.indexOf("test('[LIT-009]");
const mobileEnd = source.indexOf("test('[PARSE-001]", mobileStart);
assert.ok(mobileStart >= 0 && mobileEnd > mobileStart);
const mobile = source.slice(mobileStart, mobileEnd);

test('LIT-009 必须从真实手机首页触控进入，不得伪造或节流成功流', () => {
  assert.match(mobile, /loginAndReadToken\(page, request, '\/'\)/);
  assert.match(mobile, /getByRole\('button', \{ name: '文学创作', exact: true \}\)[\s\S]*?\.tap\(\)/);
  assert.doesNotMatch(mobile, /installLiteraryMarkerStream|resumeLiteraryMarkerStream|mock-success|page\.route\(|\.fulfill\(|window\.fetch\s*=|addInitScript/);
  assert.doesNotMatch(mobile, /page\.request\.(?:post|put|patch)\(|\.selectOption\(/, '业务只能由原页面提交，不能API代造或改选模型');
  assert.match(mobile, /requiredEnv\('STABLE_SMOKE_RUN_ID'\)[\s\S]*?testInfo\.retry/);
  assert.match(mobile, /waitForResponse[\s\S]*?generate-markers[\s\S]*?生成配图标记[\s\S]*?\.tap\(\)/);
  assert.match(mobile, /assertRealLiteraryMarkerStream/);
});

test('LIT-009 原文和完整真实标记必须在保存与同空间刷新后两次严格回读', () => {
  assert.match(mobile, /setInputFiles[\s\S]*?Buffer\.from\(article, 'utf8'\)/);
  assert.equal((mobile.match(/assertLiteraryWorkspacePersisted\(/g) ?? []).length, 2);
  assert.match(mobile, /assertLiteraryWorkspacePersisted[\s\S]*?page\.reload[\s\S]*?assertLiteraryWorkspacePersisted/);
  assert.match(mobile, /waitForURL[\s\S]*?workspaceId/);
  assert.match(mobile, /不证明实际插图/);
});

test('LIT-009 finally必须真实删除且独立详情404，再关闭手机上下文', () => {
  assert.match(mobile, /catch \(error\)[\s\S]*?literary-mobile-original-hard-failure[\s\S]*?redactStableSmokeDiagnosticText[\s\S]*?throw error;[\s\S]*?finally/);
  assert.match(mobile, /finally[\s\S]*?deleteAndVerifyLiteraryWorkspace\(page\.request,[\s\S]*?finally[\s\S]*?mobileContext\.close\(\)/);
  assert.match(source, /import \{[^}]*deleteAndVerifyLiteraryWorkspace[^}]*\} from '\.\.\/utils\/stableSmokeLiterary\.mjs'/);
});

const article = '# 移动文章\n\n白桃放在蓝色长椅上。';
const fullText = `${article}\n\n[插图]: 白桃与长椅`;
const events = [
  { type: 'progress', message: '正在准备文章配图标记' },
  { type: 'delta', text: '正在识别正文中的场景' },
  { type: 'marker', index: 0, text: '白桃与长椅', anchor: '白桃放在蓝色长椅上。' },
  { type: 'done', fullText, markerCount: 1 },
];
const sse = items => items.map(item => `data: ${JSON.stringify(item)}\r\n\r\n`).join('');

test('LIT-009 读取原生SSE的真实阶段、增量与完整终态，不把配图标记称图片', () => {
  assert.deepEqual(assertRealLiteraryMarkerStream(sse(events), article), {
    fullText, markerCount: 1, eventTypes: ['progress', 'delta', 'marker', 'done'],
  });
  for (const broken of [
    events.slice(1), events.filter(event => !['delta', 'marker'].includes(event.type)),
    events.slice(0, -1), [...events, events.at(-1)], [...events, { type: 'delta', text: '过晚正文' }],
    [...events.slice(0, -1), { type: 'error', message: '不可用' }],
    [...events.slice(0, -1), { type: 'done', fullText: article }],
    [...events.slice(0, -1), { type: 'done', fullText: '[插图]: 另一篇正文' }],
    [...events.slice(0, -1), { type: 'done', fullText, markerCount: 0 }],
    [...events.slice(0, -1), { type: 'done', fullText }],
  ]) assert.throws(() => assertRealLiteraryMarkerStream(sse(broken), article), /LIT-009/);
  assert.throws(() => assertRealLiteraryMarkerStream('data: invalid\n\n', article), /无法解析/);
});

const workspaceId = 'abcdef0123456789abcdef0123456789';
const title = 'stsmk-own-run-移动文学-r0';
const expected = { workspaceId, title, article, fullText };
const workspace = { id: workspaceId, title, articleContent: article, articleContentWithMarkers: fullText };
test('LIT-009 同workspace、标题、原文、标记全文必须精确相等，截断或别的作品均红', () => {
  assert.equal(assertLiteraryWorkspacePersisted({ workspace }, expected), workspace);
  for (const mutation of [
    { id: 'other' }, { title: '旧作品' }, { articleContent: article.slice(0, -1) },
    { articleContentWithMarkers: fullText.slice(0, -1) }, { articleContentWithMarkers: '' },
  ]) assert.throws(() => assertLiteraryWorkspacePersisted({ workspace: { ...workspace, ...mutation } }, expected), /LIT-009/);
  assert.throws(() => assertLiteraryWorkspacePersisted({}, expected), /同一工作区/);
});

function cleanupFixture({ deleteOk = true, success = true, deleted = true, status = 404 } = {}) {
  const calls = [];
  const request = {
    delete: async (path, options) => {
      calls.push({ method: 'DELETE', path, options });
      return { ok: () => deleteOk, json: async () => ({ success, data: { deleted } }) };
    },
    get: async (path, options) => { calls.push({ method: 'GET', path, options }); return { status: () => status }; },
  };
  return { request, calls };
}

test('LIT-009 清理真实调用DELETE与独立detail GET，200删除回执不能替代404', async () => {
  const options = { workspaceId, headers: { Authorization: 'fixture-only' }, timeout: 60_000 };
  const { request, calls } = cleanupFixture();
  assert.deepEqual(await deleteAndVerifyLiteraryWorkspace(request, options), { workspaceId, deleted: true, detailStatus: 404 });
  assert.deepEqual(calls, [
    { method: 'DELETE', path: `/api/literary-agent/workspaces/${workspaceId}`, options: { headers: options.headers, timeout: 60_000 } },
    { method: 'GET', path: `/api/literary-agent/workspaces/${workspaceId}/detail`, options: { headers: options.headers, timeout: 60_000 } },
  ]);
  for (const broken of [{ deleteOk: false }, { success: false }, { deleted: false }, { status: 200 }, { status: 403 }, { status: 500 }]) {
    await assert.rejects(() => deleteAndVerifyLiteraryWorkspace(cleanupFixture(broken).request, options), /LIT-009/);
  }
  await assert.rejects(() => deleteAndVerifyLiteraryWorkspace(request, { ...options, workspaceId: '../other' }), /标识无效/);
});
