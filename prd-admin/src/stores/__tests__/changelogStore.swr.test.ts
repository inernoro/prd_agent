/**
 * 更新中心 stale-while-revalidate 行为回归测试
 *
 * 历史背景：releases / currentWeek 之前只活在内存里（persist 仅存 lastSeenAt），
 * 每次新会话打开「更新日志」都从 null 起步、强制走一次后端 + 显示「正在加载历史发布…」，
 * 体感「每次打开都很慢」。改造后：
 *   1. 无缓存 → 显示 loading 并拉取（旧行为保留）
 *   2. 有缓存 → 不翻 loading 标志，后台静默刷新（不再闪 loading）
 *   3. 有缓存 + 刷新失败 → 保留旧数据、不写 error
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/services', () => ({
  getCurrentWeekChangelog: vi.fn(),
  getChangelogReleases: vi.fn(),
}));

import { getChangelogReleases, getCurrentWeekChangelog, type ReleasesView, type CurrentWeekView } from '@/services';
import { useChangelogStore } from '../changelogStore';

const makeReleases = (source: ReleasesView['source']): ReleasesView => ({
  dataSourceAvailable: true,
  source,
  fetchedAt: new Date().toISOString(),
  releases: [],
});

const makeCurrentWeek = (source: CurrentWeekView['source']): CurrentWeekView => ({
  weekStart: '2026-05-25',
  weekEnd: '2026-05-27',
  dataSourceAvailable: true,
  source,
  fetchedAt: new Date().toISOString(),
  fragments: [],
});

describe('changelogStore: stale-while-revalidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChangelogStore.setState({
      currentWeek: null,
      releases: null,
      loadingCurrent: false,
      loadingReleases: false,
      error: null,
    });
  });

  it('无缓存时 loadReleases 显示 loading 并写入数据', async () => {
    let resolveFn!: (v: unknown) => void;
    (getChangelogReleases as Mock).mockReturnValue(new Promise((r) => { resolveFn = r; }));

    const p = useChangelogStore.getState().loadReleases(20);
    // 无缓存：拉取过程中 loading 为 true
    expect(useChangelogStore.getState().loadingReleases).toBe(true);

    resolveFn({ success: true, data: makeReleases('github') });
    await p;

    expect(useChangelogStore.getState().loadingReleases).toBe(false);
    expect(useChangelogStore.getState().releases?.source).toBe('github');
  });

  it('有缓存时 loadReleases 后台静默刷新，全程不翻 loading', async () => {
    useChangelogStore.setState({ releases: makeReleases('local') });

    let resolveFn!: (v: unknown) => void;
    (getChangelogReleases as Mock).mockReturnValue(new Promise((r) => { resolveFn = r; }));

    const p = useChangelogStore.getState().loadReleases(20);
    // 有缓存：刷新过程中 loading 始终为 false（页面不会闪「正在加载」）
    expect(useChangelogStore.getState().loadingReleases).toBe(false);
    // 仍展示旧数据
    expect(useChangelogStore.getState().releases?.source).toBe('local');

    resolveFn({ success: true, data: makeReleases('github') });
    await p;

    // 后台刷新完成后数据被更新
    expect(useChangelogStore.getState().releases?.source).toBe('github');
    expect(useChangelogStore.getState().loadingReleases).toBe(false);
  });

  it('有缓存时后台刷新失败：保留旧数据且不写 error', async () => {
    useChangelogStore.setState({ releases: makeReleases('local') });
    (getChangelogReleases as Mock).mockResolvedValue({ success: false, error: { message: '网络错误' } });

    await useChangelogStore.getState().loadReleases(20);

    expect(useChangelogStore.getState().releases?.source).toBe('local');
    expect(useChangelogStore.getState().error).toBeNull();
    expect(useChangelogStore.getState().loadingReleases).toBe(false);
  });

  it('无缓存时 loadReleases 失败会写 error', async () => {
    (getChangelogReleases as Mock).mockResolvedValue({ success: false, error: { message: '网络错误' } });

    await useChangelogStore.getState().loadReleases(20);

    expect(useChangelogStore.getState().error).toBe('网络错误');
    expect(useChangelogStore.getState().releases).toBeNull();
  });

  it('有缓存时 loadCurrentWeek 后台静默刷新，全程不翻 loading', async () => {
    useChangelogStore.setState({ currentWeek: makeCurrentWeek('local') });

    let resolveFn!: (v: unknown) => void;
    (getCurrentWeekChangelog as Mock).mockReturnValue(new Promise((r) => { resolveFn = r; }));

    const p = useChangelogStore.getState().loadCurrentWeek();
    expect(useChangelogStore.getState().loadingCurrent).toBe(false);
    expect(useChangelogStore.getState().currentWeek?.source).toBe('local');

    resolveFn({ success: true, data: makeCurrentWeek('github') });
    await p;

    expect(useChangelogStore.getState().currentWeek?.source).toBe('github');
    expect(useChangelogStore.getState().loadingCurrent).toBe(false);
  });
});
