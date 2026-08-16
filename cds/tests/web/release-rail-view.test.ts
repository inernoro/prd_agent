import { describe, expect, it } from 'vitest';
import {
  buildRailNodeViews,
  describeCommitPosition,
  describeOldestUnreleased,
  formatAgo,
  formatRelativeFromNow,
  markersOffRail,
  railIsVisible,
  sameCommit,
  type RailMarker,
  type ReleaseCommitRail,
  type ReleaseTargetCommitPosition,
} from '../../web/src/lib/releaseRail.js';

const NOW = Date.parse('2026-07-29T16:00:00Z');

function railOf(overrides: Partial<ReleaseCommitRail> = {}): ReleaseCommitRail {
  return {
    branch: 'main',
    ref: 'origin/main',
    nodes: [
      { sha: 'aaaaaaa1111111111111111111111111111111', shortSha: 'aaaaaaa', subject: '修复知识库正文链接', committedAt: '2026-07-29T10:00:00Z' },
      { sha: 'bbbbbbb2222222222222222222222222222222', shortSha: 'bbbbbbb', subject: '周报技能 v2', committedAt: '2026-07-28T22:00:00Z' },
      { sha: 'ccccccc3333333333333333333333333333333', shortSha: 'ccccccc', subject: '分片生命周期', committedAt: '2026-07-24T05:00:00Z' },
    ],
    refsAsOf: '2026-07-29T15:30:00Z',
    ...overrides,
  };
}

function positionOf(overrides: Partial<ReleaseTargetCommitPosition> = {}): ReleaseTargetCommitPosition {
  return {
    commitSha: 'ccccccc3333333333333333333333333333333',
    behindCount: 2,
    aheadCount: 0,
    inRail: true,
    ...overrides,
  };
}

describe('releaseRail · 落点文案', () => {
  it('落后就说落后几个', () => {
    expect(describeCommitPosition(positionOf(), 'main')).toEqual({ text: '落后 main 2 个提交', tone: 'warn' });
  });

  it('齐平只在 behind 与 ahead 都为 0 时才说', () => {
    expect(describeCommitPosition(positionOf({ behindCount: 0, aheadCount: 0 }), 'main'))
      .toEqual({ text: '与 main 齐平', tone: 'ok' });
  });

  it('分叉时两个方向都说，不只报一个', () => {
    const text = describeCommitPosition(positionOf({ behindCount: 3, aheadCount: 2 }), 'main').text;
    expect(text).toContain('落后 3 个');
    expect(text).toContain('领先 2 个');
  });

  it('领先主干也如实说（从别处直接发上去的版本）', () => {
    expect(describeCommitPosition(positionOf({ behindCount: 0, aheadCount: 4 }), 'main').text)
      .toBe('领先 main 4 个提交');
  });

  it('算不出就说算不出，绝不退化成「齐平」', () => {
    const described = describeCommitPosition(
      positionOf({ behindCount: null, aheadCount: null, reason: '本地仓库不可读' }),
      'main',
    );
    expect(described.tone).toBe('unknown');
    expect(described.text).toContain('无法与 main 比较');
    expect(described.text).toContain('本地仓库不可读');
    expect(described.text).not.toContain('齐平');
  });

  it('从没发布过是另一句话，不是「齐平」也不是「无法比较」', () => {
    expect(describeCommitPosition(undefined, 'main')).toEqual({ text: '还没有发布过版本', tone: 'unknown' });
    expect(describeCommitPosition(positionOf({ commitSha: '' }), 'main').text).toBe('还没有发布过版本');
  });

  it('分支名缺省时退到「主干」，不出现 "落后  2 个提交" 这种断句', () => {
    expect(describeCommitPosition(positionOf(), '').text).toBe('落后 主干 2 个提交');
  });
});

