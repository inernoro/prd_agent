import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVisualLedger } from '../stable-smoke-normalize-visual-ledger.mjs';

test('人工与自动结果分栏并由严格结论进入视觉门禁', () => {
  const [row] = normalizeVisualLedger([{
    slotId: 'VISUAL-IDENTITY-PROFILE-01',
    module: '登录、权限与头像',
    primaryState: '登录',
    testType: '冒烟',
    automatedStatus: '通过',
    manualStatus: '不通过',
    finalStatus: '不通过',
    theme: 'dark',
    viewportClass: 'desktop',
    methodAnchor: '#visual-method-identity-profile',
    breadcrumb: '登录 → 首页 → 登录',
    manualReason: '按钮被遮挡',
    screenshot: '/tmp/login.png',
    sha256: 'hash',
  }]);

  assert.equal(row.automatedStatus, '通过');
  assert.equal(row.manualStatus, '不通过');
  assert.equal(row.status, '不通过');
  assert.deepEqual(row.coverageStates, ['登录']);
  assert.equal(row.caption, '按钮被遮挡');
});
