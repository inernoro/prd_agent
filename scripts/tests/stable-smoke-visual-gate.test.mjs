import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVisualEvidence } from '../stable-smoke-visual-gate.mjs';

const catalog = {
  statusVocabulary: ['通过', '不通过', '部分通过', '未执行', '需干预'],
  allowedTestTypes: ['冒烟', '功能', '视觉', '回归'],
  evidenceItemRequiredFields: ['coverageStates', 'testType', 'status', 'methodAnchor', 'breadcrumb'],
  uniqueScreenshotFloor: 2,
  modules: [{
    id: 'visual',
    name: '视觉创作',
    breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果',
    uniqueScreenshotFloor: 2,
    requiredStates: ['入口', '结果'],
  }],
};

function evidence(overrides) {
  return {
    name: '入口图',
    module: '视觉创作',
    sha256: 'hash-a',
    coverageStates: ['入口'],
    testType: '视觉',
    status: '通过',
    methodAnchor: '#视觉测试方法',
    breadcrumb: '首页 → 视觉创作',
    ...overrides,
  };
}

test('截图数量达到下限但关键状态缺失时不能通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图一', sha256: 'hash-a' }),
    evidence({ name: '入口图二', sha256: 'hash-b' }),
  ]);
  assert.equal(result.verdict, '不通过');
  assert.deepEqual(result.modules[0].missingStates, ['结果']);
});

test('重复图片不计入视觉证据数量', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'same' }),
    evidence({ name: '结果图', sha256: 'same', coverageStates: ['结果'] }),
  ]);
  assert.equal(result.screenshotCount, 1);
  assert.deepEqual(result.duplicateNames, ['结果图']);
});

test('数量、状态、路径和方法全部绑定后才通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({ name: '结果图', sha256: 'hash-b', coverageStates: ['结果'] }),
  ]);
  assert.equal(result.verdict, '通过');
  assert.equal(result.modules[0].coveredStateCount, 2);
});

test('缺少测试方法与面包屑时不能通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a', methodAnchor: '' }),
    evidence({ name: '结果图', sha256: 'hash-b', coverageStates: ['结果'], breadcrumb: '' }),
  ]);
  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].metadataPassed, false);
});
