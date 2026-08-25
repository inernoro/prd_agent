import { describe, it, expect } from 'vitest';
import { describeOrganizeCards, formatAgo, CUSTOM_STYLE_KEY } from '../organizeStyles';

const STYLES = [
  { key: 'general', label: '智能摘要', description: '一段话概述 + 要点' },
  { key: 'meeting', label: '会议纪要', description: '议题、观点、结论、待办' },
  { key: 'todo', label: '待办清单', description: '只提取行动项' },
  { key: 'interview', label: '访谈整理', description: '按问答对整理' },
  { key: CUSTOM_STYLE_KEY, label: '自定义', description: '自己描述' },
];

const NOW = Date.parse('2026-08-25T12:00:00Z');

describe('一键整理卡片状态', () => {
  it('自定义不进网格——稿面把它单独做成一条虚线按钮', () => {
    const cards = describeOrganizeCards(STYLES, { now: NOW });
    expect(cards.map(c => c.key)).not.toContain(CUSTOM_STYLE_KEY);
    expect(cards).toHaveLength(4);
  });

  it('什么都没跑过时四张都是「点击生成」，不假装某一张已生成', () => {
    const cards = describeOrganizeCards(STYLES, { now: NOW });
    expect(cards.every(c => c.state === 'idle' && c.hint === '点击生成')).toBe(true);
  });

  it('当前摘要用的那一种标为已生成，并带上多久之前', () => {
    const cards = describeOrganizeCards(STYLES, {
      currentStyleKey: 'general',
      generatedAt: new Date(NOW - 12_000).toISOString(),
      now: NOW,
    });
    const general = cards.find(c => c.key === 'general');
    expect(general?.state).toBe('done');
    expect(general?.hint).toBe('已生成 · 12 秒前');
    // 其余三张不受影响
    expect(cards.filter(c => c.state === 'idle')).toHaveLength(3);
  });

  it('在途优先于已生成：同一种正在重跑时它此刻的真实状态是生成中', () => {
    const cards = describeOrganizeCards(STYLES, {
      currentStyleKey: 'general',
      generatedAt: new Date(NOW - 12_000).toISOString(),
      runningStyleKey: 'general',
      runningPercent: 40,
      now: NOW,
    });
    expect(cards.find(c => c.key === 'general')?.hint).toBe('生成中 40%');
  });

  it('跑的是另一种时，两张卡各自是各自的状态', () => {
    const cards = describeOrganizeCards(STYLES, {
      currentStyleKey: 'general',
      generatedAt: new Date(NOW - 90_000).toISOString(),
      runningStyleKey: 'meeting',
      runningPercent: 40,
      now: NOW,
    });
    expect(cards.find(c => c.key === 'general')?.hint).toBe('已生成 · 1 分钟前');
    expect(cards.find(c => c.key === 'meeting')?.hint).toBe('生成中 40%');
  });

  it('大小写与空格不影响匹配（后端 key 一律小写，但别让一个空格把状态判丢）', () => {
    const cards = describeOrganizeCards(STYLES, { currentStyleKey: ' General ', now: NOW });
    expect(cards.find(c => c.key === 'general')?.state).toBe('done');
  });

  it('进度值越界时夹在 0-100，不显示 -20% 或 140%', () => {
    const low = describeOrganizeCards(STYLES, { runningStyleKey: 'todo', runningPercent: -20, now: NOW });
    const high = describeOrganizeCards(STYLES, { runningStyleKey: 'todo', runningPercent: 140, now: NOW });
    expect(low.find(c => c.key === 'todo')?.hint).toBe('生成中 0%');
    expect(high.find(c => c.key === 'todo')?.hint).toBe('生成中 100%');
  });

  it('拿不到生成时间就只说「已生成」，不编一个「刚刚」', () => {
    const cards = describeOrganizeCards(STYLES, { currentStyleKey: 'todo', generatedAt: null, now: NOW });
    expect(cards.find(c => c.key === 'todo')?.hint).toBe('已生成');
  });
});

describe('formatAgo', () => {
  it('时钟回拨（服务端时间超前）时返回空串，而不是负数', () => {
    expect(formatAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe('');
  });

  it('不足一秒也说「1 秒前」，不说「0 秒前」', () => {
    expect(formatAgo(new Date(NOW - 200).toISOString(), NOW)).toBe('1 秒前');
  });

  it('跨档位：分钟 / 小时 / 天', () => {
    expect(formatAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3 分钟前');
    expect(formatAgo(new Date(NOW - 5 * 3600_000).toISOString(), NOW)).toBe('5 小时前');
    expect(formatAgo(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2 天前');
  });

  it('无效时间不抛也不显示', () => {
    expect(formatAgo('not-a-date', NOW)).toBe('');
    expect(formatAgo(undefined, NOW)).toBe('');
  });
});
