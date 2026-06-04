import { describe, it, expect } from 'vitest';
import { parseMermaidTimeline } from '../UpdateTimeline';

const SAMPLE = `timeline
    title 关键更新脉络 W16 (04-13 ~ 04-19)
    section 04-13 周一
        多项目开闸 : P1到P4分段集中落地
        GitHub认证 : OAuth与环境接线补齐
        拓扑升级 : Railway风全屏编辑器持续推进
    section 04-14 周二
        团队周报分享 : 分享链接与公开页打通
        品牌更新 : 首页MAP定位与文案收敛
`;

describe('parseMermaidTimeline', () => {
  it('解析 title / section / 事件标题 + 说明', () => {
    const parsed = parseMermaidTimeline(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('关键更新脉络 W16 (04-13 ~ 04-19)');
    expect(parsed!.sections).toHaveLength(2);

    const [day1, day2] = parsed!.sections;
    expect(day1.label).toBe('04-13 周一');
    expect(day1.events).toHaveLength(3);
    expect(day1.events[0]).toEqual({ title: '多项目开闸', details: ['P1到P4分段集中落地'] });

    expect(day2.label).toBe('04-14 周二');
    expect(day2.events[1].title).toBe('品牌更新');
  });

  it('兼容全角冒号', () => {
    const parsed = parseMermaidTimeline('timeline\nsection D1\n事件 ： 说明');
    expect(parsed!.sections[0].events[0]).toEqual({ title: '事件', details: ['说明'] });
  });

  it('一条事件多个说明项', () => {
    const parsed = parseMermaidTimeline('timeline\nsection D1\nA : b : c : d');
    expect(parsed!.sections[0].events[0]).toEqual({ title: 'A', details: ['b', 'c', 'd'] });
  });

  it('没有 section 的散事件归入隐式分组', () => {
    const parsed = parseMermaidTimeline('timeline\n2021 : 事件甲\n2022 : 事件乙');
    expect(parsed).not.toBeNull();
    expect(parsed!.sections).toHaveLength(1);
    expect(parsed!.sections[0].label).toBe('');
    expect(parsed!.sections[0].events).toHaveLength(2);
  });

  it('mermaid 接续事件语法（冒号开头行）归属到上一条事件', () => {
    const parsed = parseMermaidTimeline(
      'timeline\nsection D1\n时间点 : 事件甲\n    : 事件乙\n    : 事件丙',
    );
    expect(parsed!.sections[0].events).toHaveLength(1);
    expect(parsed!.sections[0].events[0]).toEqual({
      title: '时间点',
      details: ['事件甲', '事件乙', '事件丙'],
    });
  });

  it('接续行无前置事件时降级为普通事件，不丢内容', () => {
    const parsed = parseMermaidTimeline('timeline\nsection D1\n : 孤立事件');
    expect(parsed!.sections[0].events).toHaveLength(1);
    expect(parsed!.sections[0].events[0].title).toBe('孤立事件');
  });

  it('非 timeline（flowchart）返回 null，交回 MermaidDiagram', () => {
    expect(parseMermaidTimeline('flowchart TD\n A --> B')).toBeNull();
    expect(parseMermaidTimeline('graph LR\n A-->B')).toBeNull();
  });

  it('忽略注释行与空行', () => {
    const parsed = parseMermaidTimeline('timeline\n%% 注释\n\nsection D1\nA : b');
    expect(parsed!.sections).toHaveLength(1);
    expect(parsed!.sections[0].events[0].title).toBe('A');
  });

  it('空输入返回 null', () => {
    expect(parseMermaidTimeline('')).toBeNull();
    expect(parseMermaidTimeline('   ')).toBeNull();
  });
});
