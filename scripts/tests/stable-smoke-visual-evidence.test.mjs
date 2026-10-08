import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStableSmokeVisualEvidence } from '../../e2e/utils/stableSmokeVisualEvidence.mjs';

const runId = 'stsmk-visual-evidence-test';
const commit = 'a'.repeat(40);

function slot(slotId, overrides = {}) {
  return {
    slotId,
    environment: 'cds',
    module: '视觉创作',
    moduleId: 'single-image-creation',
    primaryState: '结果',
    coverageStates: ['结果'],
    testType: '视觉',
    theme: 'dark',
    viewportClass: 'desktop',
    breadcrumb: 'CDS 环境 → 首页 → 视觉创作 → 工作区 → 结果',
    expectedProof: '真实生成结果完整可见',
    methodAnchor: '#visual-method-single-image-creation',
    pageOrigin: 'https://preview.example.test',
    entryPath: '/visual-agent',
    ...overrides,
  };
}

function fixture(slots = [slot('CDS-VISUAL-SINGLE-01')]) {
  const root = mkdtempSync(join(tmpdir(), 'stsmk-visual-evidence-'));
  const planPath = join(root, 'visual-plan.json');
  const outputPath = join(root, 'evidence');
  writeFileSync(planPath, JSON.stringify({
    runId,
    commit,
    captureStartedAt: '2026-10-08T00:00:00.000Z',
    slots,
  }));
  return {
    root,
    planPath,
    outputPath,
    environment: {
      STABLE_SMOKE_VISUAL_PLAN: planPath,
      STABLE_SMOKE_VISUAL_OUTPUT: outputPath,
      STABLE_SMOKE_RUN_ID: runId,
      STABLE_SMOKE_COMMIT: commit,
      STABLE_SMOKE_ENVIRONMENT: 'cds',
    },
  };
}

function page(url = 'https://preview.example.test/visual-agent/workspace-1') {
  return { url: () => url };
}

function target(count = 1) {
  return { waitFor: async () => undefined, count: async () => count };
}

function fakeHarness(delay = 0) {
  return {
    box: async () => undefined,
    clearBoxes: async () => undefined,
    shot: async (currentPage, outputPath, name, caption, options) => {
      if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      const location = new URL(currentPage.url());
      const { themeTarget: _themeTarget, ...serializableOptions } = options;
      const path = join(outputPath, `${name}.png`);
      writeFileSync(path, 'png');
      return {
        name,
        caption,
        path,
        capturedAt: new Date('2026-10-08T01:00:00.000Z').toISOString(),
        pageOrigin: location.origin,
        pagePath: location.pathname,
        automatedStatus: '通过',
        ...serializableOptions,
        theme: options.theme,
        viewportClass: options.mobilePathId ? 'mobile' : 'desktop',
      };
    },
  };
}

test('视觉取证未配置时是显式 no-op', async () => {
  const capture = createStableSmokeVisualEvidence({ environment: {}, harnessLoader: async () => fakeHarness() });
  assert.deepEqual(await capture(page(), undefined, { slotId: 'unused' }), {
    captured: false,
    reason: 'visual-evidence-disabled',
  });
});

test('只配置视觉计划或输出目录时拒绝静默降级', async () => {
  const capture = createStableSmokeVisualEvidence({
    environment: { STABLE_SMOKE_VISUAL_PLAN: '/tmp/plan.json' },
    harnessLoader: async () => fakeHarness(),
  });
  await assert.rejects(() => capture(page(), undefined, { slotId: 'unused' }), /必须同时配置/);
});

test('runId、commit 与环境任一不一致都拒绝取证', async () => {
  for (const [field, value, pattern] of [
    ['STABLE_SMOKE_RUN_ID', 'wrong-run', /runId 不一致/],
    ['STABLE_SMOKE_COMMIT', 'b'.repeat(40), /commit 不一致/],
    ['STABLE_SMOKE_ENVIRONMENT', 'production', /环境不一致/],
  ]) {
    const current = fixture();
    try {
      const capture = createStableSmokeVisualEvidence({
        environment: { ...current.environment, [field]: value },
        harnessLoader: async () => fakeHarness(),
      });
      await assert.rejects(
        () => capture(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-01', target: target() }),
        pattern,
      );
    } finally {
      rmSync(current.root, { recursive: true, force: true });
    }
  }
});

test('允许视觉工作区子路由但拒绝无关页面', async () => {
  const current = fixture();
  try {
    const capture = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(),
    });
    await capture(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-01', target: target() });
    const second = fixture([slot('CDS-VISUAL-SINGLE-02')]);
    try {
      const rejectCapture = createStableSmokeVisualEvidence({
        environment: second.environment,
        harnessLoader: async () => fakeHarness(),
      });
      await assert.rejects(
        () => rejectCapture(
          page('https://preview.example.test/logs'),
          undefined,
          { slotId: 'CDS-VISUAL-SINGLE-02', target: target() },
        ),
        /页面路径不一致/,
      );
    } finally {
      rmSync(second.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('manifest 元数据只能来自计划且同轮重试幂等复用同一证据', async () => {
  const current = fixture();
  try {
    const capture = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(),
    });
    const result = await capture(page(), undefined, {
      slotId: 'CDS-VISUAL-SINGLE-01',
      target: target(),
      caption: '工作区真实生成结果已完成并回读',
    });
    assert.equal(result.captured, true);
    const manifest = JSON.parse(readFileSync(join(current.outputPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 1);
    assert.deepEqual({
      slotId: manifest[0].slotId,
      runId: manifest[0].runId,
      commit: manifest[0].commit,
      module: manifest[0].module,
      primaryState: manifest[0].primaryState,
      breadcrumb: manifest[0].breadcrumb,
    }, {
      slotId: 'CDS-VISUAL-SINGLE-01',
      runId,
      commit,
      module: '视觉创作',
      primaryState: '结果',
      breadcrumb: 'CDS 环境 → 首页 → 视觉创作 → 工作区 → 结果',
    });
    assert.equal(manifest[0].name, '001-cds-visual-single-01');
    const retried = await capture(page('https://preview.example.test/visual-agent/workspace-2'), undefined, {
      slotId: 'CDS-VISUAL-SINGLE-01',
      target: target(),
    });
    assert.equal(retried.captured, false);
    assert.equal(retried.reason, 'slot-already-captured');
    assert.equal(JSON.parse(readFileSync(join(current.outputPath, 'manifest.json'), 'utf8')).length, 1);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('移动端计划元数据与重复证据关系完整传入 manifest', async () => {
  const current = fixture([slot('CDS-VISUAL-SINGLE-01', {
    viewportClass: 'mobile',
    mobilePathId: 'single-image-creation-mobile',
    mobileStage: 'result',
  })]);
  try {
    const capture = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(),
    });
    await capture(page(), undefined, {
      slotId: 'CDS-VISUAL-SINGLE-01',
      target: target(),
      duplicateOf: '073-cds-visual-single-image-creation-01',
    });
    const [record] = JSON.parse(readFileSync(join(current.outputPath, 'manifest.json'), 'utf8'));
    assert.equal(record.mobilePathId, 'single-image-creation-mobile');
    assert.equal(record.mobileStage, 'result');
    assert.equal(record.duplicateOf, '073-cds-visual-single-image-creation-01');
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('两个新 helper 并发写入时原子合并且不丢槽位', async () => {
  const current = fixture([
    slot('CDS-VISUAL-SINGLE-01'),
    slot('CDS-VISUAL-SINGLE-02', { primaryState: '恢复', coverageStates: ['恢复'] }),
  ]);
  try {
    const first = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(30),
    });
    const second = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(5),
    });
    await Promise.all([
      first(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-01', target: target() }),
      second(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-02', target: target() }),
    ]);
    const manifest = JSON.parse(readFileSync(join(current.outputPath, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.map((record) => record.slotId).sort(), [
      'CDS-VISUAL-SINGLE-01',
      'CDS-VISUAL-SINGLE-02',
    ]);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('目标必须唯一，整体截图必须说明证明范围', async () => {
  const current = fixture();
  try {
    const capture = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => fakeHarness(),
    });
    await assert.rejects(
      () => capture(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-01', target: target(2) }),
      /可见目标必须唯一/,
    );
    await assert.rejects(
      () => capture(page(), undefined, { slotId: 'CDS-VISUAL-SINGLE-01', overviewJustification: '太短' }),
      /理由过短/,
    );
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('局部作用域皮肤可指定唯一主题测量区域并传给取证器', async () => {
  const current = fixture();
  const measuredThemeTarget = target();
  let receivedThemeTarget;
  try {
    const harness = fakeHarness();
    const capture = createStableSmokeVisualEvidence({
      environment: current.environment,
      harnessLoader: async () => ({
        ...harness,
        shot: async (...args) => {
          receivedThemeTarget = args[4].themeTarget;
          return harness.shot(...args);
        },
      }),
    });
    await capture(page(), undefined, {
      slotId: 'CDS-VISUAL-SINGLE-01',
      target: target(),
      themeTarget: measuredThemeTarget,
    });
    assert.equal(receivedThemeTarget, measuredThemeTarget);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('真实登录头像、单图、多图、录音、文件、短视频、文学与视频创作旅程接入计划槽位而不是普通附件截图', () => {
  const source = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
  for (const slotId of [
    'CDS-VISUAL-IDENTITY-PROFILE-01',
    'CDS-VISUAL-IDENTITY-PROFILE-02',
    'CDS-VISUAL-IDENTITY-PROFILE-03',
    'CDS-VISUAL-IDENTITY-PROFILE-04',
    'CDS-VISUAL-IDENTITY-PROFILE-05',
    'CDS-VISUAL-IDENTITY-PROFILE-06',
    'CDS-VISUAL-IDENTITY-PROFILE-07',
    'CDS-VISUAL-IDENTITY-PROFILE-08',
    'CDS-VISUAL-IDENTITY-PROFILE-09',
    'CDS-VISUAL-IDENTITY-PROFILE-10',
    'CDS-VISUAL-IDENTITY-PROFILE-11',
    'CDS-VISUAL-IDENTITY-PROFILE-12',
    'CDS-VISUAL-IDENTITY-PROFILE-13',
    'CDS-VISUAL-IDENTITY-PROFILE-14',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-01',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-02',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-03',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-04',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-05',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-06',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-07',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-08',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-09',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-10',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-11',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-12',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-13',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-14',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-15',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-16',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-17',
    'CDS-VISUAL-SINGLE-IMAGE-CREATION-18',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-01',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-02',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-03',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-04',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-05',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-06',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-07',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-08',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-09',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-10',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-11',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-12',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-13',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-14',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-15',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-16',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-17',
    'CDS-VISUAL-MULTI-IMAGE-CREATION-18',
    'CDS-VISUAL-RECORDING-AUDIO-01',
    'CDS-VISUAL-RECORDING-AUDIO-02',
    'CDS-VISUAL-RECORDING-AUDIO-03',
    'CDS-VISUAL-RECORDING-AUDIO-04',
    'CDS-VISUAL-RECORDING-AUDIO-05',
    'CDS-VISUAL-RECORDING-AUDIO-06',
    'CDS-VISUAL-RECORDING-AUDIO-07',
    'CDS-VISUAL-RECORDING-AUDIO-08',
    'CDS-VISUAL-RECORDING-AUDIO-09',
    'CDS-VISUAL-RECORDING-AUDIO-10',
    'CDS-VISUAL-RECORDING-AUDIO-11',
    'CDS-VISUAL-RECORDING-AUDIO-12',
    'CDS-VISUAL-RECORDING-AUDIO-13',
    'CDS-VISUAL-RECORDING-AUDIO-14',
    'CDS-VISUAL-RECORDING-AUDIO-15',
    'CDS-VISUAL-RECORDING-AUDIO-16',
    'CDS-VISUAL-FILE-PARSING-01',
    'CDS-VISUAL-FILE-PARSING-02',
    'CDS-VISUAL-FILE-PARSING-03',
    'CDS-VISUAL-FILE-PARSING-04',
    'CDS-VISUAL-FILE-PARSING-05',
    'CDS-VISUAL-FILE-PARSING-06',
    'CDS-VISUAL-FILE-PARSING-07',
    'CDS-VISUAL-FILE-PARSING-08',
    'CDS-VISUAL-FILE-PARSING-09',
    'CDS-VISUAL-FILE-PARSING-10',
    'CDS-VISUAL-FILE-PARSING-11',
    'CDS-VISUAL-FILE-PARSING-12',
    'CDS-VISUAL-FILE-PARSING-13',
    'CDS-VISUAL-FILE-PARSING-14',
    'CDS-VISUAL-FILE-PARSING-15',
    'CDS-VISUAL-FILE-PARSING-16',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-01',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-02',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-03',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-04',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-05',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-06',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-07',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-08',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-09',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-10',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-11',
    'CDS-VISUAL-SHORT-VIDEO-PARSING-12',
    'CDS-VISUAL-LITERARY-CREATION-01',
    'CDS-VISUAL-LITERARY-CREATION-02',
    'CDS-VISUAL-LITERARY-CREATION-03',
    'CDS-VISUAL-LITERARY-CREATION-04',
    'CDS-VISUAL-LITERARY-CREATION-05',
    'CDS-VISUAL-LITERARY-CREATION-06',
    'CDS-VISUAL-LITERARY-CREATION-07',
    'CDS-VISUAL-LITERARY-CREATION-08',
    'CDS-VISUAL-LITERARY-CREATION-09',
    'CDS-VISUAL-LITERARY-CREATION-10',
    'CDS-VISUAL-LITERARY-CREATION-11',
    'CDS-VISUAL-LITERARY-CREATION-12',
    'CDS-VISUAL-LITERARY-CREATION-13',
    'CDS-VISUAL-LITERARY-CREATION-14',
    'CDS-VISUAL-VIDEO-CREATION-01',
    'CDS-VISUAL-VIDEO-CREATION-02',
    'CDS-VISUAL-VIDEO-CREATION-03',
    'CDS-VISUAL-VIDEO-CREATION-04',
    'CDS-VISUAL-VIDEO-CREATION-05',
    'CDS-VISUAL-VIDEO-CREATION-06',
    'CDS-VISUAL-VIDEO-CREATION-07',
    'CDS-VISUAL-VIDEO-CREATION-08',
    'CDS-VISUAL-VIDEO-CREATION-09',
    'CDS-VISUAL-VIDEO-CREATION-10',
    'CDS-VISUAL-VIDEO-CREATION-11',
    'CDS-VISUAL-VIDEO-CREATION-12',
    'CDS-VISUAL-VIDEO-CREATION-13',
    'CDS-VISUAL-VIDEO-CREATION-14',
    'CDS-VISUAL-VIDEO-CREATION-15',
    'CDS-VISUAL-VIDEO-CREATION-16',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-01',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-02',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-03',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-04',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-05',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-06',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-07',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-08',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-09',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-10',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-11',
    'CDS-VISUAL-IMAGE-MODEL-ROUTING-12',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-01',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-02',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-03',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-04',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-05',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-06',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-07',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-08',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-09',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-10',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-11',
    'CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-12',
  ]) {
    assert.match(source, new RegExp(`slotId: '${slotId}'`));
  }
  assert.match(
    source,
    /CDS-VISUAL-IDENTITY-PROFILE-05[\s\S]*?releaseAvatarUpload\?\.\(\)[\s\S]*?CDS-VISUAL-IDENTITY-PROFILE-10/,
  );
  assert.match(
    source,
    /请描述想怎么修改头像[\s\S]*?CDS-VISUAL-IDENTITY-PROFILE-14[\s\S]*?promptInput\.fill\(/,
  );
  assert.match(
    source,
    /captureStableSmokeVisualEvidence[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-12[\s\S]*?const canvasSaveResponsePromise = page\.waitForResponse/,
  );
  assert.match(
    source,
    /contenteditable[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-01[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-03[\s\S]*?setInputFiles[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-04[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-05/,
  );
  assert.match(
    source,
    /createResponsePromise = page\.waitForResponse[\s\S]*?getByRole\('button', \{ name: '生成'[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-16[\s\S]*?waitForImageRun/,
  );
  assert.match(
    source,
    /CDS-VISUAL-SINGLE-IMAGE-CREATION-06[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-18[\s\S]*?CDS-VISUAL-SINGLE-IMAGE-CREATION-09[\s\S]*?waitForImageRun/,
  );
  assert.match(
    source,
    /CDS-VISUAL-MULTI-IMAGE-CREATION-14[\s\S]*?name: '画布'[\s\S]*?setInputFiles\(threeFiles\)[\s\S]*?toHaveCount\(3[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-16/,
  );
  assert.match(
    source,
    /CDS-VISUAL-MULTI-IMAGE-CREATION-08[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-18[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-09[\s\S]*?waitForTimeout\(1_100\)[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-10/,
  );
  assert.match(
    source,
    /CDS-VISUAL-MULTI-IMAGE-CREATION-05[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-06[\s\S]*?pressSequentially\(combinationPrompt\)[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-07[\s\S]*?CDS-VISUAL-MULTI-IMAGE-CREATION-17/,
  );
  assert.match(
    source,
    /CDS-VISUAL-RECORDING-AUDIO-06[\s\S]*?const transcribeResponsePromise = page\.waitForResponse[\s\S]*?releaseUpload\?\.\(\)/,
  );
  assert.match(source, /CDS-VISUAL-RECORDING-AUDIO-03[\s\S]*?CDS-VISUAL-RECORDING-AUDIO-14/);
  assert.match(source, /CDS-VISUAL-RECORDING-AUDIO-10[\s\S]*?retryButton\.click\(\)[\s\S]*?CDS-VISUAL-RECORDING-AUDIO-16/);
  assert.match(source, /CDS-VISUAL-RECORDING-AUDIO-15[\s\S]*?run\.status\)\.toBe\('done'\)/);
  assert.match(source, /browser\.newContext\(\{ \.\.\.devices\['iPhone 13'\]/);
  assert.match(
    source,
    /CDS-VISUAL-FILE-PARSING-04[\s\S]*?releaseRequest\?\.\(\)[\s\S]*?data-phase', 'parsing'[\s\S]*?CDS-VISUAL-FILE-PARSING-06/,
  );
  assert.match(
    source,
    /CDS-VISUAL-FILE-PARSING-08[\s\S]*?CDS-VISUAL-FILE-PARSING-09[\s\S]*?retryResponsePromise[\s\S]*?CDS-VISUAL-FILE-PARSING-10/,
  );
  assert.match(
    source,
    /CDS-VISUAL-FILE-PARSING-14[\s\S]*?retryChooserPromise[\s\S]*?page\.reload[\s\S]*?CDS-VISUAL-FILE-PARSING-16/,
  );
  assert.match(
    source,
    /CDS-VISUAL-SHORT-VIDEO-PARSING-01[\s\S]*?openDocumentStoreAction\(page, '解析短视频'\)[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-03/,
  );
  assert.match(
    source,
    /CDS-VISUAL-SHORT-VIDEO-PARSING-02[\s\S]*?setFiles[\s\S]*?video\/mp4/,
  );
  assert.match(source, /stable-smoke-video\.mp4\.b64/);
  assert.match(
    source,
    /CDS-VISUAL-SHORT-VIDEO-PARSING-04[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-05[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-06/,
  );
  assert.match(
    source,
    /CDS-VISUAL-SHORT-VIDEO-PARSING-07[\s\S]*?完整的公开视频链接[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-11/,
  );
  assert.match(
    source,
    /devices\['iPhone 13'\][\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-08[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-10[\s\S]*?CDS-VISUAL-SHORT-VIDEO-PARSING-12/,
  );
  assert.match(
    source,
    /CDS-VISUAL-LITERARY-CREATION-01[\s\S]*?literary-create[\s\S]*?CDS-VISUAL-LITERARY-CREATION-03/,
  );
  assert.match(
    source,
    /CDS-VISUAL-LITERARY-CREATION-04[\s\S]*?生成配图标记[\s\S]*?CDS-VISUAL-LITERARY-CREATION-05[\s\S]*?CDS-VISUAL-LITERARY-CREATION-06[\s\S]*?CDS-VISUAL-LITERARY-CREATION-07/,
  );
  assert.match(
    source,
    /CDS-VISUAL-LITERARY-CREATION-08[\s\S]*?page\.reload[\s\S]*?CDS-VISUAL-LITERARY-CREATION-09/,
  );
  assert.match(
    source,
    /CDS-VISUAL-LITERARY-CREATION-10[\s\S]*?devices\['iPhone 13'\][\s\S]*?CDS-VISUAL-LITERARY-CREATION-11[\s\S]*?CDS-VISUAL-LITERARY-CREATION-13/,
  );
  assert.match(
    source,
    /CDS-VISUAL-LITERARY-CREATION-12[\s\S]*?CDS-VISUAL-LITERARY-CREATION-14/,
  );
  assert.match(
    source,
    /CDS-VISUAL-VIDEO-CREATION-01[\s\S]*?新项目[\s\S]*?CDS-VISUAL-VIDEO-CREATION-02[\s\S]*?文学稿内容[\s\S]*?CDS-VISUAL-VIDEO-CREATION-03/,
  );
  assert.match(
    source,
    /CDS-VISUAL-VIDEO-CREATION-04[\s\S]*?CDS-VISUAL-VIDEO-CREATION-07[\s\S]*?CDS-VISUAL-VIDEO-CREATION-08[\s\S]*?CDS-VISUAL-VIDEO-CREATION-09/,
  );
  assert.match(
    source,
    /CDS-VISUAL-VIDEO-CREATION-05[\s\S]*?CDS-VISUAL-VIDEO-CREATION-06[\s\S]*?CDS-VISUAL-VIDEO-CREATION-13/,
  );
  assert.match(
    source,
    /CDS-VISUAL-VIDEO-CREATION-10[\s\S]*?page\.reload[\s\S]*?CDS-VISUAL-VIDEO-CREATION-11/,
  );
  assert.match(
    source,
    /devices\['iPhone 13'\][\s\S]*?CDS-VISUAL-VIDEO-CREATION-12[\s\S]*?CDS-VISUAL-VIDEO-CREATION-14/,
  );
  assert.match(
    source,
    /CDS-VISUAL-VIDEO-CREATION-15[\s\S]*?CDS-VISUAL-VIDEO-CREATION-16/,
  );
  assert.match(
    source,
    /CDS-VISUAL-IMAGE-MODEL-ROUTING-01[\s\S]*?seedGatewayConsoleSession[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-02[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-06[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-11/,
  );
  assert.match(
    source,
    /CDS-VISUAL-IMAGE-MODEL-ROUTING-07[\s\S]*?createResponsePromise[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-08/,
  );
  assert.match(
    source,
    /waitForGatewayLog[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-09/,
  );
  assert.match(
    source,
    /failedLog\.routerTrace[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-10[\s\S]*?CDS-VISUAL-IMAGE-MODEL-ROUTING-12/,
  );
  assert.match(
    source,
    /请描述想怎么修改头像[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-01[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-02[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-03/,
  );
  assert.match(
    source,
    /data-avatar-phase', 'generating'[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-04[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-05/,
  );
  assert.match(
    source,
    /CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-08[\s\S]*?scrollTop[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-09[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-07[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-11/,
  );
  assert.match(
    source,
    /documentElement\.scrollWidth - window\.innerWidth[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-10/,
  );
  assert.match(
    source,
    /devices\['iPhone 13'\][\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-06[\s\S]*?CDS-VISUAL-ERRORS-PROGRESS-RESPONSIVE-12/,
  );
});
