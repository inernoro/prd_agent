import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderVisualGateReport, validateVisualEvidence } from '../stable-smoke-visual-gate.mjs';

const catalog = {
  statusVocabulary: ['通过', '不通过', '部分通过', '未执行', '需干预'],
  allowedTestTypes: ['冒烟', '功能', '视觉', '回归'],
  evidenceItemRequiredFields: ['slotId', 'primaryState', 'coverageStates', 'testType', 'status', 'theme', 'viewportClass', 'methodAnchor', 'breadcrumb'],
  allowedThemes: ['light', 'dark'],
  allowedViewportClasses: ['desktop', 'mobile'],
  uniqueScreenshotFloor: 2,
  plannedScreenshotTarget: 2,
  modules: [{
    id: 'visual',
    name: '视觉创作',
    breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果',
    uniqueScreenshotFloor: 2,
    requiredStates: ['入口', '结果'],
    requiredThemes: ['light', 'dark'],
    requiredViewportClasses: ['desktop'],
    additionalEvidenceSlots: [],
  }],
};

function evidence(overrides) {
  return {
    name: '入口图',
    module: '视觉创作',
    slotId: 'VISUAL-VISUAL-01',
    sha256: 'hash-a',
    primaryState: '入口',
    coverageStates: ['入口'],
    testType: '冒烟',
    status: '通过',
    methodAnchor: '#visual-method-visual',
    breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 入口',
    theme: 'light',
    viewportClass: 'desktop',
    ...overrides,
  };
}

test('截图数量达到下限但关键状态缺失时不能通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图一', sha256: 'hash-a' }),
    evidence({ name: '入口图二', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '入口' }),
  ]);
  assert.equal(result.verdict, '不通过');
  assert.deepEqual(result.modules[0].missingStates, ['结果']);
});

test('重复图片不计入视觉证据数量', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'same' }),
    evidence({ name: '结果图', sha256: 'same', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  assert.equal(result.screenshotCount, 1);
  assert.deepEqual(result.duplicateNames, ['结果图']);
});

test('未声明哈希时从截图文件计算并拒绝重复证据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'visual-gate-'));
  const first = join(dir, 'first.png');
  const second = join(dir, 'second.png');
  writeFileSync(first, 'same-image');
  writeFileSync(second, 'same-image');
  try {
    const result = validateVisualEvidence(catalog, [
      evidence({ name: '入口图', sha256: '', path: first }),
      evidence({ name: '结果图', sha256: '', path: second, slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
    ]);
    assert.equal(result.screenshotCount, 1);
    assert.deepEqual(result.duplicateNames, ['结果图']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('数量、状态、路径和方法全部绑定后才通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  assert.equal(result.verdict, '通过');
  assert.equal(result.modules[0].coveredStateCount, 2);
});

test('缺少测试方法与面包屑时不能通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a', methodAnchor: '' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '' }),
  ]);
  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].metadataPassed, false);
});

test('主管报告逐张列出结果、面包屑、截图和测试方法', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  const report = renderVisualGateReport(result);
  assert.match(report, /## 逐张视觉证据账本/);
  assert.match(report, /首页 → 视觉创作/);
  assert.match(report, /\[查看\]\(#fig-结果图\)/);
  assert.match(report, /\[查看\]\(#visual-method-visual\)/);
  assert.match(report, /## 视觉测试方法/);
});

test('缺少元数据的单张证据在异常区明确标为需干预', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a', methodAnchor: '' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  const report = renderVisualGateReport(result);
  assert.match(report, /## 视觉异常证据/);
  assert.match(report, /入口图 \| 需干预 \| 入口图 缺少 methodAnchor/);
});

test('带序号的中文截图名使用唯一图号锚点', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '104-gateway-nav-逻辑模型', sha256: 'hash-a' }),
    evidence({ name: '105-result', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  const report = renderVisualGateReport(result);
  assert.match(report, /\[查看\]\(#fig-104\)/);
  assert.doesNotMatch(report, /#fig-104-gateway-nav-逻辑模型/);
});

test('旧截图缺少逐项元数据时只算采集文件，不算合格证据', () => {
  const result = validateVisualEvidence(catalog, [
    { name: '旧入口图', module: '视觉创作', sha256: 'old-a' },
    { name: '旧结果图', module: '视觉创作', sha256: 'old-b' },
  ]);
  assert.equal(result.collectedScreenshotCount, 2);
  assert.equal(result.screenshotCount, 0);
  assert.equal(result.modules[0].coveredStateCount, 0);
  assert.equal(result.verdict, '不通过');
  const report = renderVisualGateReport(result);
  assert.match(report, /采集文件 \| 2/);
  assert.match(report, /合格证据 \| 0\/2/);
});

test('一张截图不能用 coverageStates 替多个主状态核销', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '多状态图', sha256: 'multi', coverageStates: ['入口', '结果'] }),
    evidence({ name: '补数量图', sha256: 'extra', slotId: 'VISUAL-VISUAL-02', primaryState: '入口', testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  assert.deepEqual(result.modules[0].missingStates, ['结果']);
  assert.equal(result.verdict, '不通过');
});

test('重复占用验收位或缺少验收位时不能通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图一', sha256: 'hash-a' }),
    evidence({ name: '入口图二', sha256: 'hash-b' }),
  ]);
  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].missingSlots.length, 1);
  assert.match(result.modules[0].fieldErrors.join('；'), /重复占用验收位/);
});
