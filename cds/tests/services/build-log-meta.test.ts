import { describe, it, expect } from 'vitest';
import {
  classifyTriggerSource,
  deriveDeployMode,
  deriveCommitMeta,
  computeDeployDurationDisplay,
  parsePulledSha,
  commitShaDiffers,
  shouldRefreshCommitSha,
  STUCK_DEPLOY_THRESHOLD_MS,
} from '../../src/services/build-log-meta.js';

describe('shouldRefreshCommitSha', () => {
  const full = '18ffd0c44dd38b98d2e806b22205580545ff547d';
  it('短→全升级（同 commit、pulled 更完整）→ 刷新', () => {
    expect(shouldRefreshCommitSha('18ffd0c', full)).toBe(true);
  });
  it('全→短同 commit → 不降级', () => {
    expect(shouldRefreshCommitSha(full, '18ffd0c')).toBe(false);
  });
  it('完全一致 → 不动', () => {
    expect(shouldRefreshCommitSha(full, full)).toBe(false);
    expect(shouldRefreshCommitSha('18ffd0c', '18ffd0c')).toBe(false);
  });
  it('不同 commit → 刷新', () => {
    expect(shouldRefreshCommitSha('18ffd0c', 'abc1234')).toBe(true);
  });
  it('旧值空 → 刷新；新值空 → 不刷新', () => {
    expect(shouldRefreshCommitSha('', 'abc1234')).toBe(true);
    expect(shouldRefreshCommitSha('abc1234', '')).toBe(false);
    expect(shouldRefreshCommitSha(undefined, full)).toBe(true);
  });
});

describe('parsePulledSha', () => {
  it('优先取 afterFull（完整 40 位 SHA，避免截断外部集成用的 commit）', () => {
    const full = '18ffd0c44dd38b98d2e806b22205580545ff547d';
    expect(parsePulledSha({ afterFull: full, after: '18ffd0c', head: '18ffd0c msg' })).toBe(full);
  });
  it('无 afterFull 时退而取 after（裸短 SHA）', () => {
    expect(parsePulledSha({ after: 'abc1234', head: 'abc1234 some commit message' })).toBe('abc1234');
  });
  it('after 缺失时解析 head 第一个 token（治 head 带标题不匹配裸 SHA 正则）', () => {
    expect(parsePulledSha({ head: 'deadbee fix something' })).toBe('deadbee');
  });
  it('after 非法（带标题）回退 head token', () => {
    expect(parsePulledSha({ after: 'not a sha', head: 'cafe123 msg' })).toBe('cafe123');
  });
  it('都无有效 SHA → 空串', () => {
    expect(parsePulledSha({ head: 'no-sha here' })).toBe('');
    expect(parsePulledSha({})).toBe('');
    expect(parsePulledSha(null)).toBe('');
  });
});

describe('commitShaDiffers', () => {
  it('短 SHA 与全 SHA 互为前缀 ⇒ 同一 commit，不算变化', () => {
    expect(commitShaDiffers('18ffd0c44dd38b98d2e806b22205580545ff547d', '18ffd0c')).toBe(false);
    expect(commitShaDiffers('18ffd0c', '18ffd0c44dd38b98d2e806b22205580545ff547d')).toBe(false);
  });
  it('不同 commit ⇒ 算变化', () => {
    expect(commitShaDiffers('18ffd0c', 'abc1234')).toBe(true);
  });
  it('任一为空 ⇒ 不算变化（不触发刷新）', () => {
    expect(commitShaDiffers('', 'abc1234')).toBe(false);
    expect(commitShaDiffers('abc1234', undefined)).toBe(false);
  });
});

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
