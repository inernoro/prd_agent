import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { renderVisualGateReport, renderVisualTechnicalAppendix, validateVisualEvidence } from '../stable-smoke-visual-gate.mjs';

const catalog = {
  statusVocabulary: ['通过', '不通过', '部分通过', '未执行', '需干预'],
  allowedTestTypes: ['冒烟', '功能', '视觉', '回归'],
  evidenceItemRequiredFields: ['slotId', 'primaryState', 'coverageStates', 'testType', 'status', 'theme', 'viewportClass', 'methodAnchor', 'breadcrumb', 'path'],
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

const evidenceRoot = mkdtempSync(join(tmpdir(), 'visual-gate-fixtures-'));
let evidenceSequence = 0;
after(() => rmSync(evidenceRoot, { recursive: true, force: true }));

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function pngFixture(seed) {
  const color = createHash('sha256').update(String(seed)).digest().subarray(0, 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, ...color, 255]))),
    pngChunk('IEND'),
  ]);
}

function evidence(overrides = {}) {
  const hasExplicitPath = Object.prototype.hasOwnProperty.call(overrides, 'path');
  const contentKey = String(overrides.sha256 ?? 'hash-a');
  const path = hasExplicitPath
    ? overrides.path
    : join(evidenceRoot, `evidence-${String(evidenceSequence += 1).padStart(3, '0')}.png`);
  const content = pngFixture(contentKey);
  if (!hasExplicitPath) writeFileSync(path, content);
  const sha256 = hasExplicitPath
    ? overrides.sha256
    : createHash('sha256').update(content).digest('hex');
  return {
    name: '入口图',
    module: '视觉创作',
    slotId: 'VISUAL-VISUAL-01',
    sha256,
    primaryState: '入口',
    coverageStates: ['入口'],
    testType: '冒烟',
    status: '通过',
    automatedStatus: '通过',
    manualStatus: '通过',
    methodAnchor: '#visual-method-visual',
    breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 入口',
    path,
    theme: 'light',
    viewportClass: 'desktop',
    ...overrides,
    path,
    sha256,
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
  const content = pngFixture('same-image');
  writeFileSync(first, content);
  writeFileSync(second, content);
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

test('截图文件缺失时即使声明哈希也不能形成可审核证据', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({
      path: join(evidenceRoot, 'missing.png'),
      sha256: 'a'.repeat(64),
    }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);

  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].invalidEvidenceCount, 1);
  assert.match(result.modules[0].fieldErrors.join('；'), /截图文件不存在或无法读取/);
});

test('声明哈希与实际截图不一致时不能形成可审核证据', () => {
  const screenshot = join(evidenceRoot, 'tampered.png');
  writeFileSync(screenshot, 'actual-image');
  const result = validateVisualEvidence(catalog, [
    evidence({ path: screenshot, sha256: 'b'.repeat(64) }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);

  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].invalidEvidenceCount, 1);
  assert.match(result.modules[0].fieldErrors.join('；'), /sha256 与实际截图文件不一致/);
});

test('任意文本即使扩展名和声明哈希正确也不能冒充截图', () => {
  const screenshot = join(evidenceRoot, 'fake.png');
  const content = Buffer.from('not-an-image');
  writeFileSync(screenshot, content);
  const result = validateVisualEvidence(catalog, [
    evidence({ path: screenshot, sha256: createHash('sha256').update(content).digest('hex') }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);

  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].invalidEvidenceCount, 1);
  assert.match(result.modules[0].fieldErrors.join('；'), /不是可解码的 PNG 截图/);
});

test('像素压缩数据损坏的 PNG 不能形成可审核证据', () => {
  const screenshot = join(evidenceRoot, 'corrupt.png');
  const content = pngFixture('corrupt');
  const idatOffset = content.indexOf(Buffer.from('IDAT')) + 4;
  content[idatOffset] ^= 0xff;
  writeFileSync(screenshot, content);
  const result = validateVisualEvidence(catalog, [
    evidence({ path: screenshot, sha256: createHash('sha256').update(content).digest('hex') }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);

  assert.equal(result.verdict, '不通过');
  assert.equal(result.modules[0].invalidEvidenceCount, 1);
  assert.match(result.modules[0].fieldErrors.join('；'), /不是可解码的 PNG 截图/);
});

test('数量、状态、路径和方法全部绑定后才通过', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  assert.equal(result.verdict, '通过');
  assert.equal(result.modules[0].coveredStateCount, 2);
});

test('双环境门禁要求每个环境分别提供唯一证据', () => {
  const cdsOnly = [
    evidence({ name: 'CDS 入口', environment: 'cds', slotId: 'CDS-VISUAL-VISUAL-01', breadcrumb: 'CDS 环境 → 首页 → 视觉创作 → 生成进度 → 图片结果 → 入口' }),
    evidence({ name: 'CDS 结果', sha256: 'cds-result', environment: 'cds', slotId: 'CDS-VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: 'CDS 环境 → 首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ];
  const cdsResult = validateVisualEvidence(catalog, cdsOnly, ['cds', 'production']);
  assert.equal(cdsResult.verdict, '不通过');
  assert.equal(cdsResult.screenshotFloor, 4);
  assert.ok(cdsResult.modules[0].missingSlots.every((slot) => slot.slotId.startsWith('PRODUCTION-')));

  const both = [
    ...cdsOnly,
    evidence({ name: '正式入口', sha256: 'production-entry', environment: 'production', slotId: 'PRODUCTION-VISUAL-VISUAL-01', breadcrumb: '正式环境 → 首页 → 视觉创作 → 生成进度 → 图片结果 → 入口' }),
    evidence({ name: '正式结果', sha256: 'production-result', environment: 'production', slotId: 'PRODUCTION-VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '正式环境 → 首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ];
  const result = validateVisualEvidence(catalog, both, ['cds', 'production']);
  assert.equal(result.verdict, '通过');
  assert.equal(result.screenshotCount, 4);
  assert.deepEqual(result.environments, ['cds', 'production']);
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
  assert.match(report, /自动检查 \| 人工视觉 \| 严格结论 \| 是否需干预/);
  assert.match(report, /通过 \| 通过 \| 通过/);
  assert.match(report, /能否发布 \| 可以/);
  assert.match(report, /首页 → 视觉创作/);
  assert.match(report, /\[查看\]\(#fig-结果图\)/);
  assert.match(report, /\[查看\]\(#visual-method-visual\)/);
  assert.match(report, /## 视觉证据图片/);
  assert.match(report, /!\[视觉创作-结果\]\(<.*visual-gate-fixtures-.*\/evidence-\d+\.png>\)/);
  assert.match(report, /## 视觉测试方法/);
});

test('异常项在模块总览前提前展示并给出干预动作', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口失败', sha256: 'hash-a', status: '不通过', manualStatus: '不通过' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  const report = renderVisualGateReport(result);
  assert.match(report, /能否发布 \| 不可以/);
  assert.match(report, /## 需处理的 1 项异常/);
  assert.ok(report.indexOf('## 需处理的 1 项异常') < report.indexOf('## 模块覆盖'));
  assert.match(report, /是：模块负责人修复后复测/);
});

test('技术路径只进入独立附录', () => {
  const result = validateVisualEvidence(catalog, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({ name: '结果图', sha256: 'hash-b', slotId: 'VISUAL-VISUAL-02', primaryState: '结果', coverageStates: ['结果'], testType: '视觉', theme: 'dark', viewportClass: 'desktop', breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果' }),
  ]);
  const appendix = renderVisualTechnicalAppendix(result, {
    manifestPath: '/tmp/run/manifest.json',
    catalogPath: '/workspace/visual-evidence-catalog.json',
  });
  assert.match(appendix, /# 视觉验收技术附录/);
  assert.match(appendix, /\/tmp\/run\/manifest\.json/);
  assert.match(appendix, /VISUAL-VISUAL-01/);
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
  assert.match(report, /可审核证据 \| 0\/2/);
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

test('证据需要补证时模块不得判为通过', () => {
  const result = validateVisualEvidence({
    ...catalog,
    statusVocabulary: [...catalog.statusVocabulary, '需补证'],
  }, [
    evidence({ name: '入口图', sha256: 'hash-a' }),
    evidence({
      name: '结果图',
      sha256: 'hash-b',
      slotId: 'VISUAL-VISUAL-02',
      primaryState: '结果',
      coverageStates: ['结果'],
      testType: '视觉',
      status: '需补证',
      theme: 'dark',
      viewportClass: 'desktop',
      breadcrumb: '首页 → 视觉创作 → 生成进度 → 图片结果 → 结果',
    }),
  ]);
  assert.equal(result.modules[0].verdict, '部分通过');
  assert.equal(result.verdict, '不通过');
});
