import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSseTypingText } from '../../e2e/utils/stableSmokeSse.mjs';

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const answer = (...parts) => frame('phase', { phase: 'preparing' })
  + parts.map(text => frame('typing', { text })).join('') + frame('done', { elapsedMs: 5 });

test('[REG-web-ask-stream-001] typing分片只拼业务text，不把JSON协议字段夹进答案', () => {
  assert.equal(readSseTypingText(answer('白', '桃，浅', '粉色')), '白桃，浅粉色');
  assert.equal(readSseTypingText(answer('白桃').replaceAll('\n', '\r\n')), '白桃');
});

test('[REG-web-ask-stream-001] 损坏typing不能被静默丢弃后判成功', () => {
  assert.throws(() => readSseTypingText(frame('phase', {})
    + 'event: typing\ndata: {bad-json}\n\n' + answer('白桃')), /typing/);
});

test('[REG-web-ask-stream-001] 缺完成态、完成后继续写、错误流都必须红', () => {
  assert.throws(() => readSseTypingText(frame('phase', {}) + frame('typing', { text: '白桃' })), /done/);
  assert.throws(() => readSseTypingText(answer('白桃') + frame('typing', { text: '浅粉' })), /done/);
  assert.throws(() => readSseTypingText(answer('白桃') + frame('error', { code: 'ASK_FAILED' })), /error/);
});

test('[REG-web-ask-stream-001] 心跳不是答案，空答案与非字符串text不得冒充通过', () => {
  assert.equal(readSseTypingText(frame('heartbeat', { elapsedSeconds: 2 }) + answer('白桃')), '白桃');
  assert.throws(() => readSseTypingText(answer('')), /答案/);
  assert.throws(() => readSseTypingText(frame('phase', {}) + frame('typing', { text: 12 }) + frame('done', {})), /text/);
});

test('[REG-web-ask-stream-001] 永久判据必须接真实UI用例，不能复制解析器或回退问答API', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ readSseTypingText \} from '..\/utils\/stableSmokeSse\.mjs'/);
  assert.doesNotMatch(source, /function readSseTypingText\(/);
  const helper = source.slice(source.indexOf('async function expectAnonymousShareAnswer('), source.indexOf('async function loginAndReadToken('));
  assert.match(helper, /getByRole\('button', \{ name: '发送'/);
  assert.match(helper, /readSseTypingText\(stream\)/);
  assert.doesNotMatch(helper, /request\.post\(/);
  assert.match(source, /\[WEB-005\][^']*\[REG-web-ask-stream-001\]/);
  for (const title of ['创建空文件夹并高亮拖入站点后刷新保持归属', '分享页片段留在 srcDoc 且页面提问可读正文']) {
    const start = source.lastIndexOf('  test(', source.indexOf(title));
    const end = source.indexOf('\n  test(', start + 1);
    const block = source.slice(start, end);
    assert.match(block, /openWebHostingFromHome\(page, request\)/);
    assert.doesNotMatch(block, /page\.goto\('\/web-pages'/);
    assert.match(block, /requiredEnv\('STABLE_SMOKE_RUN_ID'\)/);
  }
});
