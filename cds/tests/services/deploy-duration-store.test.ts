import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 部署耗时样本台账（state.ts recordDeployDuration / getDeployEstimate）单测。
 * 覆盖：中位计算（奇偶）、ring buffer 上限、模式分桶隔离、非法值忽略、
 * 估算窗口（近 N 次）、持久化往返、BranchSummary 摘要。
 */
describe('StateService deploy duration store', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dur-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    service = new StateService(stateFile);
    service.load();
  });

  afterEach(() => {
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('returns null estimate when no samples recorded', () => {
    const est = service.getDeployEstimate('proj', 'release');
    expect(est.medianMs).toBeNull();
    expect(est.sampleCount).toBe(0);
  });

  it('computes median p50 for odd sample count', () => {
    // 升序中位 = 20000
    [10000, 30000, 20000].forEach((ms) => service.recordDeployDuration('proj', 'source', ms));
    const est = service.getDeployEstimate('proj', 'source');
    expect(est.medianMs).toBe(20000);
    expect(est.sampleCount).toBe(3);
  });

  it('computes median (average of two middle) for even sample count', () => {
    // 排序 [10000,20000,30000,40000] → (20000+30000)/2 = 25000
    [10000, 40000, 20000, 30000].forEach((ms) => service.recordDeployDuration('proj', 'source', ms));
    const est = service.getDeployEstimate('proj', 'source');
    expect(est.medianMs).toBe(25000);
    expect(est.sampleCount).toBe(4);
  });

  it('keeps release and source buckets independent', () => {
    [5000, 5000, 5000].forEach((ms) => service.recordDeployDuration('proj', 'release', ms));
    [99000, 99000].forEach((ms) => service.recordDeployDuration('proj', 'source', ms));
    expect(service.getDeployEstimate('proj', 'release').medianMs).toBe(5000);
    expect(service.getDeployEstimate('proj', 'source').medianMs).toBe(99000);
  });

  it('keeps different projects independent', () => {
    service.recordDeployDuration('a', 'release', 1000);
    service.recordDeployDuration('b', 'release', 8000);
    expect(service.getDeployEstimate('a', 'release').medianMs).toBe(1000);
    expect(service.getDeployEstimate('b', 'release').medianMs).toBe(8000);
  });

  it('ignores non-positive and non-finite values', () => {
    service.recordDeployDuration('proj', 'release', 0);
    service.recordDeployDuration('proj', 'release', -5);
    service.recordDeployDuration('proj', 'release', Number.NaN);
    service.recordDeployDuration('proj', 'release', Number.POSITIVE_INFINITY);
    expect(service.getDeployEstimate('proj', 'release').sampleCount).toBe(0);
  });

  it('ignores absurdly large values beyond the reasonable cap', () => {
    // 上界 10s → 20s 的样本应被丢弃，5s 的保留
    service.recordDeployDuration('proj', 'release', 5000, 10000);
    service.recordDeployDuration('proj', 'release', 20000, 10000);
    const est = service.getDeployEstimate('proj', 'release');
    expect(est.sampleCount).toBe(1);
    expect(est.medianMs).toBe(5000);
  });

  it('caps the bucket at DEPLOY_DURATION_SAMPLES_MAX (drops oldest)', () => {
    const max = StateService.DEPLOY_DURATION_SAMPLES_MAX;
    // 推入 max+10 条，全部 1000，多出来的从头丢弃 → 长度恒为 max
    for (let i = 0; i < max + 10; i += 1) service.recordDeployDuration('proj', 'source', 1000);
    const bucket = service.getState().deployDurationSamples?.buckets?.['proj::source'] || [];
    expect(bucket.length).toBe(max);
  });

  it('estimate only uses the most recent ESTIMATE_WINDOW samples', () => {
    const win = StateService.DEPLOY_DURATION_ESTIMATE_WINDOW;
    // 先灌一批小值占满超过窗口，再灌窗口大小条大值 → 中位应反映近窗口的大值
    for (let i = 0; i < win; i += 1) service.recordDeployDuration('proj', 'release', 1000);
    for (let i = 0; i < win; i += 1) service.recordDeployDuration('proj', 'release', 90000);
    const est = service.getDeployEstimate('proj', 'release');
    expect(est.sampleCount).toBe(win);
    expect(est.medianMs).toBe(90000);
  });

  it('getBranchDeployEstimate returns both modes', () => {
    [4000, 4000, 4000].forEach((ms) => service.recordDeployDuration('proj', 'release', ms));
    service.recordDeployDuration('proj', 'source', 7000);
    const summary = service.getBranchDeployEstimate('proj');
    expect(summary.releaseMedianMs).toBe(4000);
    expect(summary.releaseSamples).toBe(3);
    expect(summary.sourceMedianMs).toBe(7000);
    expect(summary.sourceSamples).toBe(1);
  });

  it('persists samples across reload', () => {
    [2000, 6000, 4000].forEach((ms) => service.recordDeployDuration('proj', 'release', ms));
    const reloaded = new StateService(stateFile);
    reloaded.load();
    const est = reloaded.getDeployEstimate('proj', 'release');
    expect(est.medianMs).toBe(4000);
    expect(est.sampleCount).toBe(3);
  });

  it('falls back to "default" project key when projectId empty', () => {
    service.recordDeployDuration('', 'source', 3000);
    expect(service.getDeployEstimate('default', 'source').medianMs).toBe(3000);
    expect(service.getDeployEstimate('', 'source').medianMs).toBe(3000);
  });
});
