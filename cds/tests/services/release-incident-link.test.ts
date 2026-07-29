/**
 * 故障 ↔ 发布归因的时间窗判定回归。
 *
 * 这是一个「宁可少说，不可说错」的判定：归因一旦写进故障流水就再也洗不掉，
 * 把一个机房问题记成某次发布的锅，比没有归因更伤人。
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS,
  linkIncidentToRelease,
  releaseIncidentLinkWindowMs,
  type ReleaseIncidentLinkRunLike,
} from '../../src/services/release-incident-link.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const MIN = 60_000;

function run(overrides: Partial<ReleaseIncidentLinkRunLike> & { releaseId: string }): ReleaseIncidentLinkRunLike {
  return { targetId: 'tgt-prod', status: 'success', ...overrides };
}

describe('linkIncidentToRelease', () => {
  it('发布后 8 分钟出故障 → 归因，并给出间隔', () => {
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-1', finishedAt: new Date(NOW - 8 * MIN).toISOString() }),
    ]);
    expect(link).toEqual({ releaseId: 'rel-1', ageMs: 8 * MIN });
  });

  it('超出时间窗的发布一律不归因', () => {
    // 事故值：去掉窗口判定后，一条挂了三天才被发现的故障会被无条件归给
    // 「最近一次发布」——那次发布可能是三天前的，与故障毫无关系，
    // 而这个锅一旦进了流水就再也摘不掉。
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-old', finishedAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString() }),
    ]);
    expect(link).toBeNull();
  });

  it('窗口边界内取最近的那一次，不是第一次', () => {
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-1', finishedAt: new Date(NOW - 25 * MIN).toISOString() }),
      run({ releaseId: 'rel-2', finishedAt: new Date(NOW - 3 * MIN).toISOString() }),
    ]);
    expect(link?.releaseId).toBe('rel-2');
  });

  it('还在跑的发布不参与归因', () => {
    // 非终态 = 还没落到生产上，不可能是这次故障的成因。
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-running', status: 'running', finishedAt: new Date(NOW - 2 * MIN).toISOString() }),
    ]);
    expect(link).toBeNull();
  });

  it('失败的发布也可能是成因（部分变更已经落到生产上）', () => {
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-failed', status: 'failed', finishedAt: new Date(NOW - 2 * MIN).toISOString() }),
    ]);
    expect(link?.releaseId).toBe('rel-failed');
  });

  it('故障之后才完成的发布不参与归因', () => {
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'rel-after', finishedAt: new Date(NOW + 5 * MIN).toISOString() }),
    ]);
    expect(link).toBeNull();
  });

  it('没有 finishedAt / 时间戳损坏的 run 直接跳过', () => {
    const link = linkIncidentToRelease(NOW, [
      run({ releaseId: 'no-finish' }),
      run({ releaseId: 'broken', finishedAt: 'not-a-date' }),
    ]);
    expect(link).toBeNull();
  });

  it('空列表 / 非法时刻不炸', () => {
    expect(linkIncidentToRelease(NOW, [])).toBeNull();
    expect(linkIncidentToRelease(Number.NaN, [run({ releaseId: 'x', finishedAt: new Date(NOW).toISOString() })])).toBeNull();
  });
});

describe('归因时间窗配置', () => {
  it('默认 30 分钟，环境变量可覆盖，脏值回落默认', () => {
    expect(releaseIncidentLinkWindowMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS);
    expect(releaseIncidentLinkWindowMs({ CDS_UPTIME_RELEASE_LINK_WINDOW_MS: '600000' } as NodeJS.ProcessEnv)).toBe(600_000);
    expect(releaseIncidentLinkWindowMs({ CDS_UPTIME_RELEASE_LINK_WINDOW_MS: 'abc' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS);
    expect(releaseIncidentLinkWindowMs({ CDS_UPTIME_RELEASE_LINK_WINDOW_MS: '-5' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS);
  });
});
