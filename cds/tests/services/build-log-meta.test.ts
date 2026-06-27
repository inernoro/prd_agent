import { describe, it, expect } from 'vitest';
import {
  classifyTriggerSource,
  deriveDeployMode,
  deriveCommitMeta,
  computeDeployDurationDisplay,
  STUCK_DEPLOY_THRESHOLD_MS,
} from '../../src/services/build-log-meta.js';

/**
 * 构建历史元数据纯函数单测（2026-06-27）。
 * 覆盖：触发器归类（webhook/manual/retry/cooldown-rewarm/system）、部署模式解析、
 * commit 短哈希派生、卡死耗时封顶（进行中超阈值封顶 + 已结束照实）。
 */
describe('classifyTriggerSource', () => {
  it('webhook 无重试 → webhook', () => {
    expect(classifyTriggerSource('webhook', 0)).toBe('webhook');
    expect(classifyTriggerSource('webhook', undefined)).toBe('webhook');
  });

  it('webhook + 已重试（retryCount>0）→ retry', () => {
    expect(classifyTriggerSource('webhook', 1)).toBe('retry');
    expect(classifyTriggerSource('webhook', 3)).toBe('retry');
  });

  it('scheduler → cooldown-rewarm', () => {
    expect(classifyTriggerSource('scheduler', 0)).toBe('cooldown-rewarm');
  });

  it('manual / null / 空串 → manual', () => {
    expect(classifyTriggerSource('manual', 0)).toBe('manual');
    expect(classifyTriggerSource(null, 0)).toBe('manual');
    expect(classifyTriggerSource(undefined, 0)).toBe('manual');
    expect(classifyTriggerSource('', 0)).toBe('manual');
  });

  it('auto-lifecycle / janitor / system → system', () => {
    expect(classifyTriggerSource('auto-lifecycle', 0)).toBe('system');
    expect(classifyTriggerSource('janitor', 0)).toBe('system');
    expect(classifyTriggerSource('system', 0)).toBe('system');
  });
});

describe('deriveDeployMode', () => {
  it('取第一个非空 activeDeployMode', () => {
    expect(deriveDeployMode([{ activeDeployMode: '' }, { activeDeployMode: 'express' }])).toBe('express');
  });

  it('都为空 → 空串（源码/默认模式）', () => {
    expect(deriveDeployMode([{ activeDeployMode: '' }, { activeDeployMode: undefined }])).toBe('');
    expect(deriveDeployMode([])).toBe('');
  });

  it('trim 前后空白', () => {
    expect(deriveDeployMode([{ activeDeployMode: '  static  ' }])).toBe('static');
  });
});

describe('deriveCommitMeta', () => {
  it('显式 SHA 优先', () => {
    expect(deriveCommitMeta({ githubCommitSha: 'aaaaaaa0000' }, 'bbbbbbb1111')).toEqual({
      commitSha: 'bbbbbbb1111',
      shortCommit: 'bbbbbbb',
    });
  });

  it('退回 branch.githubCommitSha', () => {
    expect(deriveCommitMeta({ githubCommitSha: 'abcdef1234567' })).toEqual({
      commitSha: 'abcdef1234567',
      shortCommit: 'abcdef1',
    });
  });

  it('都没有 → 空对象（不编造）', () => {
    expect(deriveCommitMeta({ githubCommitSha: undefined })).toEqual({});
    expect(deriveCommitMeta({ githubCommitSha: '' }, null)).toEqual({});
  });
});

describe('computeDeployDurationDisplay', () => {
  const start = 1_000_000;

  it('已结束：照实显示真实耗时，不判卡住', () => {
    const finished = start + 90 * 60 * 1000; // 90 分钟（即使超阈值也照实）
    const now = finished + 10_000;
    const r = computeDeployDurationDisplay(start, finished, now);
    expect(r.stuck).toBe(false);
    expect(r.cappedMs).toBe(90 * 60 * 1000);
    expect(r.elapsedMs).toBe(90 * 60 * 1000);
  });

  it('进行中且未超阈值：照实显示', () => {
    const now = start + 5 * 60 * 1000; // 5 分钟
    const r = computeDeployDurationDisplay(start, undefined, now);
    expect(r.stuck).toBe(false);
    expect(r.cappedMs).toBe(5 * 60 * 1000);
  });

  it('进行中且超阈值（如 772m 幽灵）：封顶 + stuck', () => {
    const now = start + 772 * 60 * 1000; // 772 分钟，历史幽灵值
    const r = computeDeployDurationDisplay(start, undefined, now);
    expect(r.stuck).toBe(true);
    expect(r.cappedMs).toBe(STUCK_DEPLOY_THRESHOLD_MS);
    expect(r.elapsedMs).toBe(772 * 60 * 1000); // 原始值仍可读，仅展示封顶
  });

  it('边界：恰好等于阈值不算卡住', () => {
    const now = start + STUCK_DEPLOY_THRESHOLD_MS;
    const r = computeDeployDurationDisplay(start, undefined, now);
    expect(r.stuck).toBe(false);
    expect(r.cappedMs).toBe(STUCK_DEPLOY_THRESHOLD_MS);
  });
});
