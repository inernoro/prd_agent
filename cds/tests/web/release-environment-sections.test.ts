import { describe, expect, it } from 'vitest';
import {
  buildEnvironmentSections,
  firstSelectableTargetId,
  resolveSelectedTargetId,
  type EnvironmentGroupLike,
  type EnvironmentRowLike,
} from '../../web/src/lib/releaseEnvironments.js';

interface Row extends EnvironmentRowLike {
  target: { id: string; name: string; isEnabled: boolean };
}

function row(id: string, name: string, isEnabled = true): Row {
  return { target: { id, name, isEnabled } };
}

const groups: EnvironmentGroupLike[] = [
  { environment: 'production', label: '生产', targetIds: ['prod-a', 'prod-b'], canonicalTargetId: 'prod-a', disabledCount: 1 },
  { environment: 'staging', label: '预发', targetIds: ['stage-a'], canonicalTargetId: 'stage-a', disabledCount: 0 },
];

describe('releaseEnvironments · 分组组装', () => {
  it('按后端给定的顺序与标签渲染，前端不再自己归一 environment', () => {
    const sections = buildEnvironmentSections(groups, [
      row('prod-a', '生产站点'),
      row('prod-b', '生产备用', false),
      row('stage-a', '预发站点'),
    ]);
    expect(sections.map((section) => section.label)).toEqual(['生产', '预发']);
    expect(sections[0].entries.map((entry) => entry.targetId)).toEqual(['prod-a']);
    expect(sections[0].disabledEntries.map((entry) => entry.targetId)).toEqual(['prod-b']);
    expect(sections[0].entries[0].isCanonical).toBe(true);
  });

  it('分组里点名了但 rows 里没有的目标被跳过，不渲染点不动的死条目', () => {
    const sections = buildEnvironmentSections(groups, [row('prod-a', '生产站点')]);
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.map((entry) => entry.targetId)).toEqual(['prod-a']);
  });

  it('rows 里有但分组漏掉的目标仍然可见，落进「未分组」段', () => {
    const sections = buildEnvironmentSections(groups, [
      row('prod-a', '生产站点'),
      row('stage-a', '预发站点'),
      row('orphan', '没人管的目标'),
    ]);
    expect(sections.map((section) => section.label)).toEqual(['生产', '预发', '未分组']);
    expect(sections[2].entries.map((entry) => entry.targetId)).toEqual(['orphan']);
    expect(sections[2].degraded).toBe(true);
  });

  it('老后端不下发 environments 时退化成一个不分组的列表，而不是自己按字段再归一一次', () => {
    const sections = buildEnvironmentSections(undefined, [row('a', 'A'), row('b', 'B', false)]);
    expect(sections).toHaveLength(1);
    expect(sections[0].degraded).toBe(true);
    expect(sections[0].label).toBe('发布目标');
    expect(sections[0].entries.map((entry) => entry.targetId)).toEqual(['a']);
    expect(sections[0].disabledEntries.map((entry) => entry.targetId)).toEqual(['b']);
    // 关键：退化路径没有生造出「生产 / 预发」这种分组结论。
    expect(sections.some((section) => section.label === '生产')).toBe(false);
  });

  it('一个目标都没有时不渲染任何段落', () => {
    expect(buildEnvironmentSections(undefined, [])).toEqual([]);
    expect(buildEnvironmentSections([], [])).toEqual([]);
  });

  it('整段都空的分组不出现在结果里', () => {
    const sections = buildEnvironmentSections(groups, [row('stage-a', '预发站点')]);
    expect(sections.map((section) => section.label)).toEqual(['预发']);
  });
});

describe('releaseEnvironments · 选中态收敛', () => {
  const sections = buildEnvironmentSections(groups, [
    row('prod-a', '生产站点'),
    row('prod-b', '生产备用', false),
    row('stage-a', '预发站点'),
  ]);

  it('默认选第一个启用中的目标', () => {
    expect(firstSelectableTargetId(sections)).toBe('prod-a');
  });

  it('全都停用时退到第一个停用的，而不是空选', () => {
    const allDisabled = buildEnvironmentSections(groups, [row('prod-a', 'A', false), row('stage-a', 'B', false)]);
    expect(firstSelectableTargetId(allDisabled)).toBe('prod-a');
  });

  it('用户选过的还在就保留——刷新后选中项自己跳走是最招人烦的闪烁', () => {
    expect(resolveSelectedTargetId(sections, 'stage-a')).toBe('stage-a');
    expect(resolveSelectedTargetId(sections, 'prod-b')).toBe('prod-b');
  });

  it('选中的目标不在了才回到第一个可选的', () => {
    expect(resolveSelectedTargetId(sections, 'gone')).toBe('prod-a');
    expect(resolveSelectedTargetId(sections, '')).toBe('prod-a');
  });

  it('一个目标都没有时返回空串', () => {
    expect(resolveSelectedTargetId([], 'anything')).toBe('');
  });
});
