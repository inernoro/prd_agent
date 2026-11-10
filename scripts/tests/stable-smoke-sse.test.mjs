import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 执行既有消费者选择的 reader；旧内联函数仅去掉 TypeScript 类型标注。
const consumer = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const local = consumer.match(/function readSseTypingText\(stream: string\) \{([\s\S]*?)\n\}\n/);
const reader = local
  ? new Function('stream', local[1].replace(' as { text?: unknown }', ''))
  : (await import('../../e2e/utils/stableSmokeSse.mjs')).readSseTypingText;
if (!local) assert.match(consumer, /import \{ readSseTypingText \} from ['"]\.\.\/utils\/stableSmokeSse\.mjs['"]/);

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const phase = frame('phase', { phase: 'answer' });
const typing = frame('typing', { text: '本地合成答案' });
const done = frame('done', {});

test('正常阶段、逐字答案和完成事件保留原答案及CRLF', () => {
  assert.equal(reader((phase + typing + done).replaceAll('\n', '\r\n')), '本地合成答案');
});
for (const [name, input] of [
  ['缺少done的截断流', phase + typing],
  ['带业务错误的流', phase + typing + frame('error', { message: '拒绝执行' }) + done],
  ['重复完成事件', phase + typing + done + done],
  ['完成后继续答案', phase + typing + done + typing],
  ['阶段前先返回答案', typing + phase + done],
  ['非字符串答案', phase + frame('typing', { text: { value: '不能当答案' } }) + done],
  ['无法解析的typing', phase + 'event: typing\ndata: {bad}\n\n' + done],
  ['没有实际答案', phase + frame('typing', { text: '  ' }) + done],
  ['答案中伪造完成字样', phase + frame('typing', { text: 'event: done' })],
]) {
  test(`${name}不得通过稳定验收`, () => assert.throws(() => reader(input)));
}
