import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNER = path.join(ADMIN_ROOT, 'scripts/style-debt-report.mjs');
const RISK_SAMPLE = 'export const sample = "bg-white/5 border-white/10";';
const roots: string[] = [];
const metrics = [
  'undeclaredThemeRisk', 'adaptiveBorderRisk', 'adaptiveSurfaceRisk',
  'adaptiveHoverRisk', 'adaptiveThemeRisk', 'actionableThemeRisk',
  'ordinaryUiRisk', 'unclassifiedThemeRisk',
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-debt-source-scope-'));
  roots.push(root);
  function write(relative: string, content: string) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  write('scripts/theme-risk-classification.json', JSON.stringify({
    schemaVersion: 1, intentionalVisualFiles: [], infrastructureFiles: [],
  }));
  write('scripts/style-debt-baseline.json', JSON.stringify({
    metricVersion: 3, programBaseline: {}, milestoneTarget: {},
    currentCeiling: Object.fromEntries(metrics.map((key) => [key, 0])),
    enforcedMetrics: metrics,
  }));
  return { root, write };
}

function run(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCANNER, ...args], { cwd: root, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function report(root: string) {
  const result = run(root, '--json', '--details');
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('样式债务扫描的生产输入边界', () => {
  it('测试与夹具反例不计入产品风险，历史快照仍保留原计数', () => {
    const { root, write } = fixture();
    write('src/components/Control.tsx', 'export const control = "surface-inset border-token-subtle";');
    const samples = [
      'lib/__tests__/structuralSnapshot.test.ts',
      'components/Control.test.tsx', 'lib/control.spec.js',
      'lib/__fixtures__/sample.ts', 'lib/__tests__/fixtures/sample.css',
    ];
    for (const sample of samples) write(`src/${sample}`, RISK_SAMPLE);
    const current = report(root);
    expect(current.totals.files).toBe(1);
    expect(current.themeLayers.actionableThemeRisk).toBe(0);
    expect(current.themeLayers.ordinaryUiRisk).toBe(0);
    expect(current.themeLayers.unclassifiedThemeRisk).toBe(0);
    expect(current.adaptiveFindings).toEqual([]);
    expect(current.metricVersion).toBe(4);
    expect(current.historicalBridge).toMatchObject({
      metricVersion: 3, files: 6, actionableThemeRisk: 10,
      ordinaryUiRisk: 10, unclassifiedThemeRisk: 10,
    });
    const checked = run(root, '--check-baseline');
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('actionableThemeRisk: 0 -> 10');
  });

  it('同样风险在真实产品仍计入并被原零阈值拒绝，不按近似目录名豁免', () => {
    const { root, write } = fixture();
    write('src/components/testing-controls/Control.tsx', RISK_SAMPLE);
    const current = report(root);
    expect(current.totals.files).toBe(1);
    expect(current.themeLayers).toMatchObject({
      actionableThemeRisk: 2, ordinaryUiRisk: 2, unclassifiedThemeRisk: 2,
    });
    expect(current.adaptiveFindings.map((finding: { path: string }) => finding.path))
      .toEqual(['components/testing-controls/Control.tsx', 'components/testing-controls/Control.tsx']);
    const checked = run(root, '--check-baseline');
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('actionableThemeRisk: 0 -> 2');
  });

  it('旧版正阈值必须比较同口径样本，不能用较低的生产数值释放余量', () => {
    const { root, write } = fixture();
    write('src/components/Control.tsx', RISK_SAMPLE);
    write('src/lib/control.test.ts', RISK_SAMPLE);
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts/style-debt-baseline.json'), 'utf8'));
    baseline.currentCeiling.actionableThemeRisk = 2;
    baseline.enforcedMetrics = ['actionableThemeRisk'];
    write('scripts/style-debt-baseline.json', JSON.stringify(baseline));
    expect(report(root).themeLayers.actionableThemeRisk).toBe(2);
    const checked = run(root, '--check-baseline');
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('actionableThemeRisk: 2 -> 4');
  });

  it('更新旧基线仍写旧口径，未知版本拒绝写入而不污染原文件', () => {
    const { root, write } = fixture();
    write('src/components/Control.tsx', RISK_SAMPLE);
    write('src/lib/control.test.ts', RISK_SAMPLE);
    const current = report(root);
    expect(run(root, '--update-baseline').status).toBe(0);
    const file = path.join(root, 'scripts/style-debt-baseline.json');
    const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(updated.metricVersion).toBe(3);
    expect(updated.currentCeiling).toEqual(Object.fromEntries(
      Object.keys(updated.currentCeiling).map((key) => [key, current.historicalBridge[key]]),
    ));
    write('scripts/style-debt-baseline.json', JSON.stringify({ ...updated, metricVersion: 5 }));
    const frozen = fs.readFileSync(file, 'utf8');
    expect(run(root, '--update-baseline').status).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(frozen);
    expect(run(root, '--check-baseline').status).toBe(1);
  });

  it('显式v4基线只比较生产数值，新增真实产品风险仍越界失败', () => {
    const { root, write } = fixture();
    write('src/components/Control.tsx', RISK_SAMPLE);
    write('src/lib/control.test.ts', RISK_SAMPLE);
    const original = JSON.parse(fs.readFileSync(path.join(root, 'scripts/style-debt-baseline.json'), 'utf8'));
    write('scripts/style-debt-baseline-v4.json', JSON.stringify({
      metricVersion: 4, referenceMetricVersion: 3,
      originalCurrentCeiling: original.currentCeiling,
      currentCeiling: { ...original.currentCeiling, adaptiveBorderRisk: 1,
        adaptiveSurfaceRisk: 1, adaptiveThemeRisk: 2, actionableThemeRisk: 2,
        ordinaryUiRisk: 2, unclassifiedThemeRisk: 2 },
    }));
    expect(run(root, '--check-baseline').status).toBe(0);
    const originalFile = path.join(root, 'scripts/style-debt-baseline.json');
    const originalBytes = fs.readFileSync(originalFile, 'utf8');
    expect(run(root, '--update-baseline').status).toBe(0);
    expect(fs.readFileSync(originalFile, 'utf8')).toBe(originalBytes);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'scripts/style-debt-baseline-v4.json'), 'utf8')))
      .toMatchObject({ metricVersion: 4, referenceMetricVersion: 3 });
    write('src/components/Extra.tsx', RISK_SAMPLE);
    const checked = run(root, '--check-baseline');
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('actionableThemeRisk: 2 -> 4');
    write('scripts/style-debt-baseline.json', JSON.stringify({ ...original, currentCeiling: {} }));
    expect(run(root, '--check-baseline').status).toBe(1);
  });

  it('真实v4阈值来自原基线源码重算，不提高任何阈值或改写旧历史', () => {
    const original = JSON.parse(fs.readFileSync(path.join(ADMIN_ROOT, 'scripts/style-debt-baseline.json'), 'utf8'));
    const migrated = JSON.parse(fs.readFileSync(path.join(ADMIN_ROOT, 'scripts/style-debt-baseline-v4.json'), 'utf8'));
    expect(migrated).toMatchObject({ metricVersion: 4, referenceMetricVersion: 3,
      sourceCommit: '1de51766324f268c8b5853f76814f1b2b22e8f86',
      originalCurrentCeiling: original.currentCeiling });
    for (const key of Object.keys(original.currentCeiling)) {
      expect(migrated.currentCeiling[key]).toBe(original.currentCeiling[key] - migrated.excludedTestContribution[key]);
      expect(migrated.currentCeiling[key]).toBeLessThanOrEqual(original.currentCeiling[key]);
    }
    expect(migrated.currentCeiling).toMatchObject({ actionableThemeRisk: 0, ordinaryUiRisk: 0, unclassifiedThemeRisk: 0 });
  });

  it('排除计分不等于放弃登记核验：现存样本有效，缺失登记仍失败', () => {
    const { root, write } = fixture();
    write('src/lib/__tests__/themeSystem.test.ts', RISK_SAMPLE);
    const entry = {
      path: 'lib/__tests__/themeSystem.test.ts', category: 'test-fixture',
      scope: '主题守卫样本', rationale: '固定颜色仅用于测试反例',
    };
    const manifest = { schemaVersion: 1, intentionalVisualFiles: [], infrastructureFiles: [entry] };
    write('scripts/theme-risk-classification.json', JSON.stringify(manifest));
    expect(report(root).classification.errors).toEqual([]);
    manifest.infrastructureFiles.push({ ...entry, path: 'components/Missing.tsx' });
    write('scripts/theme-risk-classification.json', JSON.stringify(manifest));
    expect(report(root).classification.errors)
      .toEqual(['Theme classification path does not exist: components/Missing.tsx']);
    expect(run(root, '--check-baseline').status).toBe(1);
  });

  it('真实登记必须全部指向现存源文件，不删除有效产品或测试样本登记', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ADMIN_ROOT, 'scripts/theme-risk-classification.json'), 'utf8'));
    const entries = [...manifest.intentionalVisualFiles, ...manifest.infrastructureFiles];
    expect(entries.filter((entry) => !fs.existsSync(path.join(ADMIN_ROOT, 'src', entry.path)))).toEqual([]);
    expect(entries.some((entry) => entry.path === 'lib/__tests__/themeSystem.test.ts')).toBe(true);
    expect(entries.some((entry) => entry.path === 'pages/home/sections/HeroSection.tsx')).toBe(true);
    expect(entries.some((entry) => entry.path === 'pages/home/components/StaticBackdrop.tsx')).toBe(true);
  });
});
