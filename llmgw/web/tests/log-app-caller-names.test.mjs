import assert from 'node:assert/strict';
import test from 'node:test';
import { appDisplayName } from '../src/lib/logsHelpers.ts';

test('App labels use a known name or mark the App as unnamed', () => {
  const appCallerCode = 'example.summary::chat';
  assert.equal(appDisplayName({ appCallerCode, appCallerCodeDisplayName: '网页托管-向我提问', appCallerTitle: '请求标题' }), '网页托管-向我提问');
  assert.equal(appDisplayName({ appCallerCode, appCallerCodeDisplayName: appCallerCode.toUpperCase(), appCallerTitle: '请求标题' }), '请求标题');
  assert.equal(appDisplayName({ appCallerCode, appCallerTitle: appCallerCode }), '未命名 App');
  assert.equal(appDisplayName({}), '—');
});
