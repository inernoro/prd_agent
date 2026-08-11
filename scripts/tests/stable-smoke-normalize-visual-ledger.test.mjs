import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    environment: 'cds',
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
  assert.equal(row.environment, 'cds');
  assert.deepEqual(row.coverageStates, ['登录']);
  assert.equal(row.caption, '按钮被遮挡');
});

test('最终状态缺失或误填通过时仍采用自动与人工中的更严格结论', () => {
  const rows = normalizeVisualLedger([
    {
      slotId: 'VISUAL-IDENTITY-PROFILE-01',
      automatedStatus: '不通过',
      manualStatus: '通过',
    },
    {
      slotId: 'VISUAL-IDENTITY-PROFILE-02',
      automatedStatus: '通过',
      manualStatus: '不通过',
      finalStatus: '通过',
    },
  ]);

  assert.deepEqual(rows.map((row) => row.status), ['不通过', '不通过']);
  assert.deepEqual(rows.map((row) => row.failureEvidence), [true, true]);
});

test('复制后的截图继承原始取证清单中的真实移动端元数据', () => {
  const root = mkdtempSync(join(tmpdir(), 'visual-normalize-'));
  const sourceDir = join(root, 'source');
  mkdirSync(sourceDir);
  const sourceScreenshot = join(sourceDir, 'mobile-state.png');
  writeFileSync(sourceScreenshot, 'image-bytes');
  writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify([{
    name: 'mobile-state',
    path: sourceScreenshot,
    annotated: true,
    viewport: { width: 390, height: 664 },
    touchPoints: 1,
    isMobile: true,
    mobilePathId: 'visual-mobile',
    mobileStage: 'result',
    environment: 'production',
  }]));
  try {
    const [row] = normalizeVisualLedger([{
      slotId: 'VISUAL-IDENTITY-PROFILE-11',
      module: '登录、权限与头像',
      primaryState: '移动端',
      testType: '视觉',
      finalStatus: '通过',
      theme: 'dark',
      viewportClass: 'mobile',
      methodAnchor: '#visual-method-identity-profile',
      breadcrumb: '登录 → 首页 → 头像 → 移动端',
      screenshot: join(root, 'copied.png'),
      sourceScreenshot,
    }]);
    assert.equal(row.annotated, true);
    assert.deepEqual(row.viewport, { width: 390, height: 664 });
    assert.equal(row.touchPoints, 1);
    assert.equal(row.isMobile, true);
    assert.equal(row.mobilePathId, 'visual-mobile');
    assert.equal(row.mobileStage, 'result');
    assert.equal(row.environment, 'production');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
