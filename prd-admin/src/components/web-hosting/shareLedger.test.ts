import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLedgerConclusion, buildShareLedger, filterShareLinks, tierOf } from './shareLedger';
import type { ShareLinkItem } from '@/services/real/webPages';

const NOW = new Date('2026-08-21T00:00:00.000Z').getTime();
const inDays = (d: number) => new Date(NOW + d * 86400000).toISOString();

function link(over: Partial<ShareLinkItem> = {}): ShareLinkItem {
  return {
    id: 'l1',
    token: 't1',
    siteIds: [],
    siteId: 's1',
    shareType: 'single',
    accessLevel: 'public',
    viewCount: 0,
    createdBy: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    isRevoked: false,
    ...over,
  };
}

const text = (links: ShareLinkItem[]) => buildLedgerConclusion(links, NOW).map((s) => s.text).join('');

describe('分享档账本', () => {
  it('撤销优先于过期——两者都成立时用户只能重新分享', () => {
    expect(tierOf(link({ isRevoked: true, isExpired: true }))).toBe('revoked');
    expect(tierOf(link({ isExpired: true }))).toBe('expired');
    expect(tierOf(link())).toBe('active');
  });

  it('有效层按快到期排前面，永久链排最后', () => {
    // 必须把 NOW 注进去：到期时间是相对 NOW 造的，用真实时钟排序会随日子过去而漂
    // （这条用例 2026-08-25 就是这样红的：inDays(2) 已经变成过去时间，被当成永久链排到最后）
    const ledger = buildShareLedger([
      link({ id: 'forever', viewCount: 500 }),
      link({ id: 'far', expiresAt: inDays(30) }),
      link({ id: 'soon', expiresAt: inDays(2) }),
    ], NOW);
    expect(ledger.active.map((l) => l.id)).toEqual(['soon', 'far', 'forever']);
  });

  it('三层分开计数，不混在一个列表里', () => {
    const ledger = buildShareLedger([
      link({ id: 'a' }),
      link({ id: 'b', isExpired: true }),
      link({ id: 'c', isRevoked: true }),
      link({ id: 'd' }),
    ]);
    expect(ledger.active.map((l) => l.id).sort()).toEqual(['a', 'd']);
    expect(ledger.expired.map((l) => l.id)).toEqual(['b']);
    expect(ledger.revoked.map((l) => l.id)).toEqual(['c']);
  });

  it('一条链接都没有时给的是引导，不是 0', () => {
    expect(text([])).toContain('还没有创建过任何分享链接');
    expect(text([])).not.toContain('0 条有效');
  });

  it('全部失效时结论说清「已经没有生效中的链接」并指出过期可复活', () => {
    const links = [link({ isExpired: true }), link({ id: 'l2', isRevoked: true })];
    expect(text(links)).toContain('已经没有生效中的链接');
    expect(text(links)).toContain('续期即可复活');
  });

  it('把条数、累计访问与访客数合成一句判断', () => {
    const links = [
      link({ viewCount: 98, uniqueIpCount: 8 }),
      link({ id: 'l2', viewCount: 320, uniqueIpCount: 18 }),
    ];
    expect(text(links)).toContain('2 条有效链接累计带来 418 次访问');
    expect(text(links)).toContain('26 位访客');
  });

  it('不把累计访问说成「近 7 天」—— 这一屏只有累计值，近 7 天要访问日志聚合', () => {
    const t = text([link({ viewCount: 98, uniqueIpCount: 8 })]);
    expect(t).toContain('累计');
    expect(t).not.toContain('近 7 天');
  });

  it('拿不到访客数时不写「0 位访客」，整句不提这件事', () => {
    expect(text([link({ viewCount: 12 })])).not.toContain('位访客');
  });

  it('七天内到期要出现在结论里，并且点得动（drill 到有效层）', () => {
    const links = [
      link({ viewCount: 98, expiresAt: inDays(3), title: '客户验收' }),
      link({ id: 'l2', viewCount: 10, expiresAt: inDays(2), title: '内部评审' }),
      link({ id: 'l3', viewCount: 1, expiresAt: inDays(40) }),
    ];
    const t = text(links);
    expect(t).toContain('2 条 2 天内到期');
    // 快到期且还在被打开的那条要被点名，用户才知道先续哪条
    expect(t).toContain('「内部评审」还在被打开——先续这条');
    const warn = buildLedgerConclusion(links, NOW).find((s) => s.tone === 'warn');
    expect(warn?.drillTo).toBe('active');
  });

  it('都还很久才到期就不喊到期，改说哪条最热', () => {
    const links = [link({ viewCount: 300, title: '主推链接', expiresAt: inDays(60) }), link({ id: 'l2', viewCount: 5 })];
    const t = text(links);
    expect(t).not.toContain('到期');
    expect(t).toContain('「主推链接」占了');
  });

  it('有链接但一次都没被打开时如实说', () => {
    expect(text([link({ viewCount: 0 })])).toContain('还没有人打开过');
  });

  it('搜索能按标题、token、短链号命中', () => {
    const links = [
      link({ id: 'a', title: '客户验收', token: 'abcDEF', shortSeq: 41827 }),
      link({ id: 'b', title: '内部评审', token: 'zzz', shortSeq: 41830 }),
    ];
    expect(filterShareLinks(links, '客户').map((l) => l.id)).toEqual(['a']);
    expect(filterShareLinks(links, 'abcdef').map((l) => l.id)).toEqual(['a']);
    expect(filterShareLinks(links, '41830').map((l) => l.id)).toEqual(['b']);
    expect(filterShareLinks(links, '  ').map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('永久有效的链接不摆「续期」入口', () => {
    // 后端在 ExpiresAt 为 null 时以 now 为基准，「续期」会给永不过期的链接盖上
    // 7 天期限——点了比不点还糟。后端已改成空动作，界面也不该再给这个入口。
    const src = readFileSync(
      new URL('./SharesWorkspace.tsx', import.meta.url), 'utf-8',
    );
    // 续期按钮必须包在「有 expiresAt」的条件里
    expect(src).toMatch(/\{l\.expiresAt && \([\s\S]{0,400}onRenew/);
  });

  it('照着行里显示的站点名也能搜到', () => {
    // 输入框承诺「搜索链接或站点」，行里「指向的站点」一列显示的就是站点名。
    // 谓词原先只比 title / token / 短链号，于是照着屏幕上那个名字去搜，
    // 明明那一行就在眼前，结果却是空的。
    const links = [
      link({ id: 'a', title: '给客户的', token: 'aaa', siteTitles: ['季度复盘 PPT'] }),
      link({ id: 'b', title: '内部评审', token: 'bbb', siteTitles: ['接口设计稿'] }),
    ];

    // 站点名与分享标题不同名——这正是原先漏掉的那种
    expect(filterShareLinks(links, '季度复盘').map((l) => l.id)).toEqual(['a']);
    expect(filterShareLinks(links, '接口设计').map((l) => l.id)).toEqual(['b']);

    // 搜的是「显示什么就搜什么」：标签解析器给出的那个名字必须能命中，
    // 哪怕它来自本页 sites 的回退（siteTitles 为空时）
    const noTitles = [link({ id: 'c', title: '外发', token: 'ccc' })];
    expect(filterShareLinks(noTitles, '回退站点', () => '回退站点名').map((l) => l.id)).toEqual(['c']);
  });
});
