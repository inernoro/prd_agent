import { describe, expect, it } from 'vitest';
import { compareDesignObservations, observeDesignRules } from '../../src/services/design-acceptance-observations.js';
import { designVisualBreakdown } from '../../src/shared/design-methods.js';
import { designVisualRowForSlot } from '../../src/shared/design-visual.js';
import type { DesignRule, DesignRun, DesignScreen, DesignVersion } from '../../src/shared/design-workspace.js';

const phoneLayout: Parameters<typeof observeDesignRules>[1] = {
  layers: [], tabControls: [], headerAlignment: null, width: 375, content: 375, vertical: 1, clippedControls: 0, textControls: 5,
  height: 812, scrollHeight: 812, raw: { markdown: 0, html: 0, json: 0, credential: 0 },
  frame: null, title: null, currentStep: false, stepNumber: 0,
  causes: [], hero: false, methods: 0, overviewIssues: [], compare: [], feedback: [], columns: 1, frameworkColumns: 1, clippedCards: 0,
};
const library: DesignRule = {
  id: 'A-46', rule: '手机设计库使用两列稿件', expected: '框架单列，稿件两列。检查：docOverflow ≤ 0、overflowCount = 0',
  how: 'measure', priority: 'high', screenId: 'design-m', slots: ['phone-light'],
  probe: { type: 'horizontal-overflow', tolerance: 0 },
};

describe('program verification of declared layout rules', () => {
  it('detects a one-column library even when the document fits', () => {
    expect(observeDesignRules([library], phoneLayout)['A-46'].status).toBe('failed');
    expect(observeDesignRules([library], { ...phoneLayout, columns: 2 })['A-46'].status).toBe('unverified');
  });

  it('does not pass a compound rule based on document width alone', () => {
    const rule = { ...library, id: 'A-13', screenId: 'dsn-delivery-m' };
    expect(observeDesignRules([rule], phoneLayout)['A-13'].status).toBe('unverified');
    expect(observeDesignRules([rule], { ...phoneLayout, content: 385 })['A-13'].status).toBe('failed');
  });

  it('passes a rule that declares document width as its whole check', () => {
    const rule = { ...library, id: 'A-1', expected: '文档内容宽不能超过视口宽。' };
    expect(observeDesignRules([rule], phoneLayout)['A-1'].status).toBe('passed');
  });
});

describe('program verification of dark text', () => {
  const known = { measured: 4, low: 0, unknown: 0, media: 0, lowest: 5.35 };
  it('records the measured contrast and keeps unknown image or gradient coverage pending', () => {
    const check = (darkText: typeof known) => compareDesignObservations(phoneLayout, { ...phoneLayout, darkText }, 0)['V-07'];
    expect(check(known)).toMatchObject({ status: 'passed', evidence: expect.stringContaining('5.35') });
    expect(check({ ...known, media: 1 })).toMatchObject({ status: 'missing' });
    expect(check({ ...known, unknown: 1 })).toMatchObject({ status: 'missing' });
    expect(check({ ...known, low: 1, lowest: 2.15 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('2.15') });
  });

  it('links a light row only to the program capture of the same dark screen', () => {
    const screen: DesignScreen = { id: 'fixture', name: '测试图位', route: '#fixture', viewport: 'phone', themes: ['light', 'dark'], impl: '/design' };
    const attribution = { capturedBy: 'cds' as const, dataset: 'dataset-a', commit: 'build-a' };
    const proof = { ...attribution, digest: 'image-a', fixtureDigest: 'fixture-a', by: 'reviewer', at: '2026-11-25T00:00:00Z' };
    const row = { ...attribution, at: proof.at, by: 'CDS 程序', imageId: 'implemented-image', referenceImageId: 'reference-image' };
    const run: DesignRun = { id: 'run', version: 24, commit: attribution.commit, createdAt: proof.at, cells: [], issues: {}, verdict: 'needs_evidence', previewUrl: '/design',
      visual: {
        'fixture/phone-light': { ...row, measured: { width: 375, height: 812, path: '/design', theme: 'light' },
          checks: compareDesignObservations(phoneLayout, phoneLayout, 0, true) },
        'fixture/phone-dark': { ...row, measured: { width: 375, height: 812, path: '/design', theme: 'dark' },
          checks: compareDesignObservations(phoneLayout, { ...phoneLayout, darkText: known }, 0) },
      },
      programEvidence: { 'fixture/phone-light': proof, 'fixture/phone-dark': proof },
    };
    const read = () => designVisualRowForSlot(screen, 'phone-light', run)?.checks['V-07'];
    expect(read()).toMatchObject({ status: 'passed', evidence: expect.stringContaining('同画面深色实拍') });
    run.programEvidence!['fixture/phone-dark'] = { ...proof, fixtureDigest: 'fixture-other' };
    expect(read()).toMatchObject({ status: 'missing', useDarkCapture: true });
    delete run.programEvidence!['fixture/phone-dark'];
    expect(read()).toMatchObject({ status: 'missing', useDarkCapture: true });
  });
});

describe('declared scene coverage', () => {
  it('requires two real program images for every declared state in the same run and dataset', () => {
    const commit = 'a'.repeat(40), dataset = 'b'.repeat(64), fixtureDigest = 'c'.repeat(64);
    const screen: DesignScreen = { id: 'normal', name: '正常', route: '#normal', viewport: 'phone', themes: ['light'], impl: '/design' };
    const empty = { ...screen, id: 'empty', name: '空状态', route: '#empty' };
    const version = { version: 24, demoData: { files: [], sha256: dataset }, screens: [screen, empty], acceptance: [] } as unknown as DesignVersion;
    const attribution = { capturedBy: 'cds' as const, dataset, commit };
    const at = '2026-11-25T00:00:00Z';
    const proof = { ...attribution, digest: 'd'.repeat(64), fixtureDigest, at, by: 'capture-actor' };
    const row = { ...attribution, imageId: 'implementation-image', referenceImageId: 'prototype-image', by: 'CDS 程序', at,
      measured: { width: 375, height: 812, theme: 'light' as const, path: '/design' },
      checks: compareDesignObservations(phoneLayout, phoneLayout, 0) };
    const run: DesignRun = { id: 'run', version: 24, commit, createdAt: at, previewUrl: '/design', verdict: 'needs_evidence',
      cells: [], issues: {}, visual: { 'normal/phone-light': row, 'empty/phone-light': row },
      programEvidence: { 'normal/phone-light': proof } };
    const coverage = () => designVisualBreakdown(version, run).find(check => check.id === 'V-09')?.counts;
    expect(coverage()).toMatchObject({ passed: 0, missing: 2 });
    run.programEvidence!['empty/phone-light'] = { ...proof, fixtureDigest: 'e'.repeat(64) };
    expect(coverage()).toMatchObject({ passed: 0, missing: 2 });
    run.programEvidence!['empty/phone-light'] = proof;
    run.visual!['empty/phone-light'] = { ...row, referenceImageId: undefined };
    expect(coverage()).toMatchObject({ passed: 0, missing: 2 });
    run.visual!['empty/phone-light'] = { ...row, checks: { ...row.checks, 'V-09': {
      status: 'failed', evidence: '实际打开的是另一个状态。', useSceneCoverage: true,
    } } };
    expect(coverage()).toMatchObject({ passed: 0, failed: 1, missing: 1 });
    run.visual!['empty/phone-light'] = row;
    expect(coverage()).toMatchObject({ passed: 2, missing: 0 });
    run.version = 23;
    expect(coverage()).toMatchObject({ passed: 0, missing: 2 });
  });
});
