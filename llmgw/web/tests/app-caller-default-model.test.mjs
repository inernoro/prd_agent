import test from 'node:test';
import assert from 'node:assert/strict';
import { appCallerDefaultModel, callerModelWorkspaceHref, callerWorkspaceReturnHref } from '../src/lib/appCallerDefaultModel.ts';
const model = (id, patch = {}) => ({ id, publicId: id, name: id, modelType: 'chat', enabled: true, displayOrder: 0, defaultForAppCallerCodes: [], allowedAppCallerCodes: [], isDefaultForType: false, ...patch });

test('调用方专属默认优先于用途默认，身份不区分大小写且不跨用途', () => {
  const rows = [model('global', { isDefaultForType: true }), model('assigned', { defaultForAppCallerCodes: ['App.Summary::chat'] }), model('other-purpose', { modelType: 'generation', defaultForAppCallerCodes: ['App.Summary::chat'] })];
  assert.equal(appCallerDefaultModel(rows, 'app.summary::CHAT', 'chat').model.id, 'assigned');
  assert.equal(appCallerDefaultModel(rows, 'someone-else', 'chat').model.id, 'global');
  assert.equal(appCallerDefaultModel(rows, 'someone-else', 'vision').model, undefined);
});

test('停用的专属目标不冒充生效默认；权限阻止不能自动换到全局模型', () => {
  const global = model('global', { isDefaultForType: true });
  assert.equal(appCallerDefaultModel([global, model('disabled', { enabled: false, defaultForAppCallerCodes: ['caller'] })], 'caller', 'chat').model.id, 'global');
  const restricted = appCallerDefaultModel([global, model('restricted', { defaultForAppCallerCodes: ['caller'], allowedAppCallerCodes: ['other'] })], 'caller', 'chat');
  assert.equal(restricted.model.id, 'restricted');
  assert.equal(restricted.allowed, false);
});

test('模型工作台保留调用方身份和来源筛选，返回不能被任意 URL 或嵌套跳转覆盖', () => {
  const href = callerModelWorkspaceHref('app&admin::chat', 'chat', 'search=needle&page=3&from=https://evil.test&callerReturn=%2Faccount');
  assert.ok(href.startsWith('/logical-models?'));
  const params = new URL(href, 'https://preview.test').searchParams;
  assert.equal(params.get('caller'), 'app&admin::chat');
  const back = new URL(callerWorkspaceReturnHref(params.get('caller'), 'chat', params.get('callerReturn')), 'https://preview.test');
  assert.equal(back.pathname, '/app-callers');
  assert.equal(back.searchParams.get('focus'), 'app&admin::chat');
  assert.equal(back.searchParams.get('focusType'), 'chat');
  assert.equal(back.searchParams.get('search'), 'needle');
  assert.equal(back.searchParams.get('page'), '3');
  assert.equal(back.searchParams.has('from'), false);
  assert.equal(back.searchParams.has('callerReturn'), false);
});
