import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSseTypingText } from '../../e2e/utils/stableSmokeSse.mjs';
const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function expectAnonymousShareAnswer(');
const text = source.slice(start, source.indexOf('async function loginAndReadToken(', start));
const body = text.slice(text.indexOf(') {') + 3, text.lastIndexOf('}'));
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const consumer = new AsyncFunction('page', 'shareToken', 'siteId', 'marker', 'storagePath', 'testInfo',
  'expect', 'readSseTypingText', 'captureWebEvidence', 'request', body);
function check(actual) {
  return { toBe: expected => assert.equal(actual, expected), toBeUndefined: () => assert.equal(actual, undefined),
    toContain: value => assert.ok(actual.includes(value)),
    toContainText: async value => assert.ok(actual.text.includes(value), 'assistant DOM output absent'),
    not: { toContain: value => assert.ok(!actual.includes(value)) } };
}
async function run({ authorization, assistant = 'synthetic-marker：白桃，浅粉色' } = {}) {
  const events = []; let sent; const ready = new Promise(resolve => { sent = resolve; });
  const data = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const stream = data('phase', {}) + data('typing', { text: 'synthetic-marker：白桃，浅粉色' }) + data('done', {});
  const response = { request: () => ({ method: () => 'POST', headers: () => authorization ? { authorization } : {},
    postDataJSON: () => ({ siteId: 'synthetic-site' }) }), text: async () => stream,
    status: () => 200, headers: () => ({ 'content-type': 'text/event-stream' }) };
  const locator = { text: assistant, filter({ hasText }) { this.text = this.text.includes(hasText) ? this.text : ''; return this; }, last() { return this; } };
  const page = { post() { throw Error('API surrogate forbidden'); },
    getByRole(role, { name }) { return { first() { return this; }, click: async () => { events.push(name); if (name === '发送') sent(response); },
      fill: async value => { events.push(value); } }; },
    waitForResponse: () => ready, locator: () => locator };
  const info = { attach: async () => {} }; let captures = 0;
  await consumer(page, 'synthetic-share', 'synthetic-site', 'synthetic-marker', 'current', info,
    check, readSseTypingText, async () => { captures++; }, page);
  return { events, captures };
}
test('真实消费者选择问答入口、填问题、点发送，再核对助手DOM和SSE', async () => {
  const r = await run(); assert.ok(r.events.includes('向我提问')); assert.ok(r.events.includes('发送')); assert.equal(r.captures, 1);
});
test('访客请求携带所有者身份时不得核销', async () => { await assert.rejects(run({ authorization: 'synthetic-owner-token' })); });
test('只有SSE或页面正文标记、没有助手可见答案时不得核销', async () => { await assert.rejects(run({ assistant: '' })); });
