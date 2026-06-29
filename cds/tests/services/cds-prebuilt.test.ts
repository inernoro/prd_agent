import { describe, it, expect } from 'vitest';
import {
  isFullCommitSha,
  computeCdsPrebuiltImageRef,
  parseCdsPrebuiltManifest,
  shouldTryCdsPrebuilt,
} from '../../src/services/cds-prebuilt.js';

const FULL = '18ffd0c44dd38b98d2e806b22205580545ff547d';

describe('isFullCommitSha', () => {
  it('40 hex 通过，短 SHA / 非 hex 不通过', () => {
    expect(isFullCommitSha(FULL)).toBe(true);
    expect(isFullCommitSha('18ffd0c')).toBe(false);
    expect(isFullCommitSha('zzz')).toBe(false);
    expect(isFullCommitSha('')).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
  });
});

describe('computeCdsPrebuiltImageRef', () => {
  it('owner/repo + 全 SHA → ghcr ref（与 CI 同公式）', () => {
    expect(computeCdsPrebuiltImageRef('inernoro/prd_agent', FULL))
      .toBe(`ghcr.io/inernoro/prd_agent/cds-dist:sha-${FULL}`);
  });
  it('大小写归一 + 自定义 registry', () => {
    expect(computeCdsPrebuiltImageRef('Inernoro/Prd_Agent', FULL.toUpperCase(), 'ghcr.io/'))
      .toBe(`ghcr.io/inernoro/prd_agent/cds-dist:sha-${FULL}`);
  });
  it('仓库名非 owner/repo 或非全 SHA → null（回退现编）', () => {
    expect(computeCdsPrebuiltImageRef('prd_agent', FULL)).toBeNull();
    expect(computeCdsPrebuiltImageRef('a/b/c', FULL)).toBeNull();
    expect(computeCdsPrebuiltImageRef('inernoro/prd_agent', '18ffd0c')).toBeNull();
    expect(computeCdsPrebuiltImageRef('', FULL)).toBeNull();
  });
});

describe('parseCdsPrebuiltManifest', () => {
  it('合法 manifest（schema=1 + 全 SHA）解析成功', () => {
    const m = parseCdsPrebuiltManifest(JSON.stringify({ sha: FULL, schema: 1, builtAt: 'x', ref: 'main' }));
    expect(m?.sha).toBe(FULL);
    expect(m?.schema).toBe(1);
  });
  it('expectedSha 不匹配 → null', () => {
    expect(parseCdsPrebuiltManifest(JSON.stringify({ sha: FULL, schema: 1 }), 'a'.repeat(40))).toBeNull();
  });
  it('schema 不是 1 / sha 非全 / 非 JSON / 空 → null', () => {
    expect(parseCdsPrebuiltManifest(JSON.stringify({ sha: FULL, schema: 2 }))).toBeNull();
    expect(parseCdsPrebuiltManifest(JSON.stringify({ sha: '18ffd0c', schema: 1 }))).toBeNull();
    expect(parseCdsPrebuiltManifest('not json')).toBeNull();
    expect(parseCdsPrebuiltManifest('')).toBeNull();
    expect(parseCdsPrebuiltManifest(undefined)).toBeNull();
  });
});

describe('shouldTryCdsPrebuilt', () => {
  it('开关关 → 不用', () => {
    expect(shouldTryCdsPrebuilt({ enabled: false, repoFullName: 'inernoro/prd_agent', sha: FULL }))
      .toEqual({ use: false });
  });
  it('开关开 + 合法 → 用，带 imageRef', () => {
    expect(shouldTryCdsPrebuilt({ enabled: true, repoFullName: 'inernoro/prd_agent', sha: FULL }))
      .toEqual({ use: true, imageRef: `ghcr.io/inernoro/prd_agent/cds-dist:sha-${FULL}` });
  });
  it('开关开但 SHA 非全 → 不用（回退）', () => {
    expect(shouldTryCdsPrebuilt({ enabled: true, repoFullName: 'inernoro/prd_agent', sha: '18ffd0c' }))
      .toEqual({ use: false });
  });
});
