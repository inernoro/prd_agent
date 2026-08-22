import { describe, expect, it } from 'vitest';
import { buildLibraryHeadline, countRecent } from './libraryHeadline';
import { availableGroupModes, buildSiteGroups, normalizeGroupMode } from './siteGrouping';
import type { HostedSite, WebPageGroup } from '@/services/real/webPages';

const site = (o: Partial<HostedSite> & { id: string }): HostedSite => ({
  title: o.id, description: '', sourceType: 'upload', cosPrefix: '', entryFile: 'index.html',
  siteUrl: '', files: [], totalSize: 0, tags: [], ownerUserId: 'u', sharedTeamIds: [],
  viewCount: 0, commentsEnabled: true, createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z', ...o,
} as HostedSite);

describe('主控台结论行', () => {
  const base = { mode: 'time' as const, total: 184, loaded: 184, recentCount: 12, shown: 184, filtered: false };

  it('主句写清「按什么组织 · 看的哪一批」', () => {
    expect(buildLibraryHeadline(base).lead).toBe('按时间 · 全部');
    expect(buildLibraryHeadline({ ...base, mode: 'folder', scopeLabel: '验收报告' }).lead).toBe('按文件夹 · 验收报告');
    expect(buildLibraryHeadline({ ...base, mode: 'source', scopeLabel: '工作流生成' }).lead).toBe('按来源 · 工作流生成');
  });

  it('全部加载完才报「最近 7 天新增」', () => {
    expect(buildLibraryHeadline(base).stats).toBe('184 个站点 · 最近 7 天 12 个新增');
  });

  it('分页没取完就不报新增数 —— 200 条里数出来的不能当 1,208 条的结论', () => {
    const v = buildLibraryHeadline({ ...base, total: 1208, loaded: 200, shown: 200, recentCount: 9 });
    expect(v.stats).toBe('1,208 个站点');
    expect(v.stats).not.toContain('新增');
  });

  it('筛选之后单列一段实际条数', () => {
    expect(buildLibraryHeadline({ ...base, shown: 7, filtered: true }).stats).toContain('当前筛出 7 个');
  });

  it('没加筛选就不报「筛出多少」—— 空间自身的条数差不是筛选结果', () => {
    // 个人空间会把已进团队的站点在客户端剔掉，shown 天然小于 loaded，
    // 这不是用户筛的，报出来会让人以为自己开着一个不存在的筛选
    expect(buildLibraryHeadline({ ...base, shown: 5, loaded: 8, filtered: false }).stats).not.toContain('筛出');
  });

  it('新增为 0 时不写一句「0 个新增」', () => {
    expect(buildLibraryHeadline({ ...base, recentCount: 0 }).stats).toBe('184 个站点');
  });

  it('countRecent 只数窗口内的，脏时间不计', () => {
    const now = Date.parse('2026-08-22T00:00:00.000Z');
    const items = [
      { createdAt: '2026-08-21T00:00:00.000Z' },
      { createdAt: '2026-08-10T00:00:00.000Z' },
      { createdAt: 'not-a-date' },
    ];
    expect(countRecent(items, 7, now)).toBe(1);
  });
});

describe('组织方式四档', () => {
  const groups: WebPageGroup[] = [
    { id: 'g1', teamId: 't1', name: '验收报告', kind: 'topic', visibility: 'inherit', sortOrder: 0, createdBy: 'u', createdAt: '', updatedAt: '' } as WebPageGroup,
  ];
  const items = [
    site({ id: 'a', sourceType: 'workflow', folder: '周报', groupId: 'g1' }),
    site({ id: 'b', sourceType: 'upload', folder: '周报' }),
    site({ id: 'c', sourceType: 'workflow' }),
  ];

  it('按来源分节，标签走来源注册表', () => {
    expect(buildSiteGroups(items, 'source').map((g) => [g.label, g.items.length])).toEqual([
      ['工作流生成', 2], ['手动上传', 1],
    ]);
  });

  it('按文件夹与按分组是两档，各自的空值有各自的说法', () => {
    expect(buildSiteGroups(items, 'folder').map((g) => g.label)).toEqual(['周报', '未分类']);
    expect(buildSiteGroups(items, 'group', groups).map((g) => g.label)).toEqual(['专题 · 验收报告', '未分组']);
  });

  it('分节保持传入顺序 —— 排序决定顺序，分组只插标题', () => {
    const reversed = [...items].reverse();
    expect(buildSiteGroups(reversed, 'source')[0].label).toBe('工作流生成');
    expect(buildSiteGroups(reversed, 'source')[0].items[0].id).toBe('c');
  });

  it('每个空间只露成立的档位，不摆没得选的按钮', () => {
    expect(availableGroupModes('personal')).toEqual(['time', 'folder', 'source']);
    expect(availableGroupModes('team')).toEqual(['time', 'group', 'source']);
  });

  it('切空间后旧档位不成立就落回按时间，不留一个空列表', () => {
    expect(normalizeGroupMode('folder', 'team')).toBe('time');
    expect(normalizeGroupMode('group', 'personal')).toBe('time');
    expect(normalizeGroupMode('source', 'team')).toBe('source');
  });
});
