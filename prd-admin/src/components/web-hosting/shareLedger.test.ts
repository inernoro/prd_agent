import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLedgerConclusion, buildShareLedger, filterShareLinks, tierOf } from './shareLedger';
import { isLinkActive, isLinkExpired } from './shareStatus';
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
    // 两条链接：8 + 18 只是「每条各自去重」的和，跨链接同一个人会被算两次，
    // 所以这里只敢说人次。这条断言原先钉的是「26 位访客」——把虚高的说法钉死了。
    expect(text(links)).toContain('26 人次访客');
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

  it('加载失败不许被渲染成「你还没有创建过任何分享链接」', () => {
    // 取不回来 ≠ 没有。原先 res.success 为 false 时静默跳过，links 保持为空，
    // 界面就渲染那句斩钉截铁的空态并请他去建一条——而他的链接明明都在。
    // 判据：错误态那一支必须排在空态之前，且 refresh 失败时要留下 loadError。
    const src = readFileSync(new URL('./SharesWorkspace.tsx', import.meta.url), 'utf-8');
    expect(src).toContain('setLoadError(');
    const errBranch = src.indexOf('loadError && links.length === 0');
    const emptyBranch = src.indexOf('links.length === 0 ? (\n        <EmptyState');
    expect(errBranch, '没有错误态分支').toBeGreaterThan(0);
    expect(emptyBranch, '找不到空态分支，测试该跟着改').toBeGreaterThan(0);
    expect(errBranch, '错误态必须排在空态之前，否则失败会被渲染成「没有链接」').toBeLessThan(emptyBranch);
  });

  it('多条链接时访客数只敢说人次，不冒充人数', () => {
    // uniqueIpCount 是每条链接各自去重的，跨链接不去重：同一个人开两条，两条里各算
    // 一次。求和后渲染成「N 位访客」就是虚高——链接越多越离谱。
    const two = [
      link({ id: 'a', token: 'a1', viewCount: 10, uniqueIpCount: 3, expiresAt: '2026-12-31T00:00:00.000Z' }),
      link({ id: 'b', token: 'b1', viewCount: 5, uniqueIpCount: 2, expiresAt: '2026-12-31T00:00:00.000Z' }),
    ];
    const multi = text(two);
    expect(multi).toContain('5 人次访客');
    expect(multi).toContain('重复计');
    expect(multi).not.toContain('5 位访客');

    // 只有一条时，这个和确实等于人数，可以照说
    const one = [link({ id: 'a', token: 'a1', viewCount: 10, uniqueIpCount: 3, expiresAt: '2026-12-31T00:00:00.000Z' })];
    expect(text(one)).toContain('3 位访客');
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

describe('过期判据以时钟为准，且全站只有一份', () => {
  it('到期时刻一过就该判过期，不等服务端那次快照', () => {
    // 服务端返回的 isExpired 是**上一次请求时**的结论。面板开着不动、到期时刻过去，
    // 那条死链原先仍被算进「有效」——顶栏计数、结论句、复制按钮跟着一起错。
    const dying = link({ id: 'a', token: 'a1', expiresAt: inDays(1), isExpired: false });

    expect(tierOf(dying, NOW)).toBe('active');
    // 时钟往前推两天，同一份数据（isExpired 仍是服务端那个 false）
    expect(tierOf(dying, NOW + 2 * 86400000)).toBe('expired');

    const later = buildShareLedger([dying], NOW + 2 * 86400000);
    expect(later.active).toHaveLength(0);
    expect(later.expired.map((l) => l.id)).toEqual(['a']);

    // 结论句读同一个时钟，不会一边说「1 条有效」一边把它排进过期层
    expect(text([dying])).toContain('1 条有效链接');
    expect(buildLedgerConclusion([dying], NOW + 2 * 86400000).map((s) => s.text).join(''))
      .toContain('已经没有生效中的链接');
  });

  it('没有到期时间的永久链，仍以服务端快照兜底', () => {
    expect(isLinkExpired(link({ expiresAt: undefined, isExpired: false }), NOW)).toBe(false);
    expect(isLinkExpired(link({ expiresAt: undefined, isExpired: true }), NOW)).toBe(true);
    // 时间串解析不出来时同样退回快照，而不是当成「已过期」把活链接判死
    expect(isLinkExpired(link({ expiresAt: '不是时间', isExpired: false }), NOW)).toBe(false);
  });

  it('撤销优先于过期', () => {
    const both = link({ expiresAt: inDays(-1), isRevoked: true });
    expect(tierOf(both, NOW)).toBe('revoked');
    expect(isLinkActive(both, NOW)).toBe(false);
  });

  it('「有效」这句判断全仓只有 shareStatus 一处在写', () => {
    // 这句判断此前散在八处，每处都手写 `!l.isRevoked && !l.isExpired`。
    // 判据分裂就会漂移：这次「过期看时钟」的改动，漏掉任何一处就会一半新一半旧
    // （predicate-and-wiring-discipline 形状 3）。守卫扫的是「还有没有人另写一份」。
    const files = import.meta.glob('/src/**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const offenders = Object.entries(files)
      .filter(([path]) => !path.includes('shareStatus') && !path.includes('.test.'))
      .filter(([, src]) => /!\w+\.isRevoked\s*&&\s*!\w+\.isExpired|\w+\.isRevoked\s*\|\|\s*\w+\.isExpired/.test(src))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
    // 扫不到任何文件说明 glob 失效了，这条守卫会静默全绿——先证明它真的在扫
    expect(Object.keys(files).length).toBeGreaterThan(100);
  });
});

describe('行内操作必须读当前列表', () => {
  it('两行同时操作时后回来的那次不许抹掉先回来的结果', () => {
    // 行禁用只按 busyId 挡住其中一行，所以用户完全可以在 A 还没回来时就点 B。
    // 两个 handler 若各自闭包住自己那次渲染看到的 links，后回来的一 map 就把先回来的
    // 结果原样抹掉——计数、分层、可用操作与服务端不一致，直到刷新。
    const src = readFileSync(new URL('./SharesWorkspace.tsx', import.meta.url), 'utf-8');

    // 判据钉的是「不许再拿渲染闭包里那份 links 去 map 后回写」这件事本身，
    // 不是某一处的写法：两个 handler 将来还会增加第三个，扫的是全文。
    expect(src).not.toMatch(/onLinksChange\(\s*links\.map/);
    // 而且确实走了函数式更新（读当前值），不是把回写整个删了了事
    expect(src).toMatch(/onLinksChange\(\s*\(current\)\s*=>/);
  });
});
