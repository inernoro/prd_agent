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

describe('releaseRail · 可见性', () => {
  it('有节点且无不可用原因才画', () => {
    expect(railIsVisible(railOf())).toBe(true);
  });

  it('数据缺省时整块隐藏，不留一个空壳骨架', () => {
    expect(railIsVisible(undefined)).toBe(false);
    expect(railIsVisible(railOf({ nodes: [] }))).toBe(false);
    expect(railIsVisible(railOf({ unavailableReason: '本地仓库不可读' }))).toBe(false);
    // 有原因就一定没有节点：即便后端同时给了节点，也按不可用处理。
    expect(railIsVisible(railOf({ unavailableReason: '项目没有记过远端默认分支' }))).toBe(false);
  });
});

describe('releaseRail · 环境插旗', () => {
  const markers: RailMarker[] = [
    { targetId: 't-prod', label: '生产', environment: 'production', commitSha: 'ccccccc3333333333333333333333333333333' },
    { targetId: 't-stage', label: '预发', environment: 'staging', commitSha: 'bbbbbbb' },
  ];

  it('短 sha 与全 sha 混用照样能对上', () => {
    expect(sameCommit('bbbbbbb2222222222222222222222222222222', 'bbbbbbb')).toBe(true);
    expect(sameCommit('bbbbbbb', 'ccccccc')).toBe(false);
    expect(sameCommit('', 'ccccccc')).toBe(false);
  });

  it('旗插在正确的节点上', () => {
    const views = buildRailNodeViews(railOf(), markers);
    expect(views.map((node) => node.markers.map((marker) => marker.label))).toEqual([[], ['预发'], ['生产']]);
  });

  it('不在轴上的环境单独列出，不凭空生一个节点', () => {
    const off = markersOffRail(railOf(), [
      ...markers,
      { targetId: 't-old', label: '演示', environment: 'other', commitSha: 'ddddddd4444' },
    ]);
    expect(off.map((marker) => marker.targetId)).toEqual(['t-old']);
  });
});

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

describe('releaseRail · 时间文案', () => {
  it('最早未上线提交距今 N 小时', () => {
    expect(describeOldestUnreleased(positionOf({ oldestUnreleasedAt: '2026-07-28T22:00:00Z' }), NOW))
      .toBe('最早未上线提交距今 18 小时');
  });

  it('没有这个字段就整句不出现', () => {
    expect(describeOldestUnreleased(positionOf(), NOW)).toBe('');
    expect(describeOldestUnreleased(undefined, NOW)).toBe('');
  });

  it('非法时间返回空串，让调用方整句不显示而不是渲染 Invalid Date', () => {
    expect(formatRelativeFromNow('not-a-date', NOW)).toBe('');
    expect(formatAgo(undefined, NOW)).toBe('');
  });

  it('粗粒度分级：分钟 / 小时 / 天 / 月', () => {
    expect(formatRelativeFromNow('2026-07-29T15:58:00Z', NOW)).toBe('2 分钟');
    expect(formatRelativeFromNow('2026-07-29T11:00:00Z', NOW)).toBe('5 小时');
    expect(formatRelativeFromNow('2026-07-24T16:00:00Z', NOW)).toBe('5 天');
    expect(formatRelativeFromNow('2026-05-29T16:00:00Z', NOW)).toBe('2 个月');
  });

  it('未来时间说「刚刚」而不是负数', () => {
    expect(formatAgo('2026-07-29T17:00:00Z', NOW)).toBe('刚刚');
  });

  it('formatAgo 给带后缀的说法', () => {
    expect(formatAgo('2026-07-24T16:00:00Z', NOW)).toBe('5 天前');
  });
});
