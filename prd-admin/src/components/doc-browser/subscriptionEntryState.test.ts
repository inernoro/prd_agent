import { describe, it, expect } from 'vitest';
import {
  canOpenSubscriptionPanel,
  subscriptionSyncTone,
  githubDirectoryStatusLabel,
  githubSyncingSignature,
  mergeWatchedParents,
  GITHUB_DIRECTORY_SOURCE,
} from './subscriptionEntryState';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';

describe('订阅条目状态判据（2026-09-09 验收 P1/P2 的回归锁）', () => {
  it('GitHub 目录父条目必须有订阅面板入口', () => {
    // 目录条目才是「立即同步」真正作用的对象；漏掉它 = 同步失败后无处可点
    expect(canOpenSubscriptionPanel(GITHUB_DIRECTORY_SOURCE)).toBe(true);
    expect(canOpenSubscriptionPanel('subscription')).toBe(true);
  });

  it('普通上传文档没有订阅面板', () => {
    expect(canOpenSubscriptionPanel('upload')).toBe(false);
    expect(canOpenSubscriptionPanel(undefined)).toBe(false);
  });

  it('同步失败的优先级高于暂停与同步中', () => {
    expect(subscriptionSyncTone({ syncStatus: 'error', isPaused: true })).toBe('error');
    expect(subscriptionSyncTone({ syncStatus: 'syncing', isPaused: true })).toBe('paused');
    expect(subscriptionSyncTone({ syncStatus: 'syncing' })).toBe('syncing');
    expect(subscriptionSyncTone({ syncStatus: 'idle' })).toBe('idle');
    expect(subscriptionSyncTone({})).toBe('idle');
  });

  it('状态直接写进悬浮文案，不让用户猜颜色', () => {
    expect(githubDirectoryStatusLabel('error')).toContain('同步失败');
    expect(githubDirectoryStatusLabel('paused')).toContain('已暂停');
    expect(githubDirectoryStatusLabel('syncing')).toContain('同步中');
    expect(githubDirectoryStatusLabel('idle')).toBe('GitHub 目录订阅');
  });
});

describe('子文档手动同步的引导语必须原样到达用户', () => {
  it('专属错误码不会被兜底文案吃掉', () => {
    // 参数与 apiClient 真实调用一致，否则测的不是用户实际看到的那条路径
    const message = toUserReadableErrorMessage(
      { code: 'GITHUB_CHILD_ENTRY_SYNC', message: '该文档由所属的 GitHub 目录订阅统一同步，请对该目录条目触发同步' },
      { code: 'GITHUB_CHILD_ENTRY_SYNC', fallbackMessage: '操作未完成', recoveryMessage: '请检查输入后重试。' },
    );

    expect(message).toContain('目录');
    expect(message).not.toContain('操作未完成');
  });

  it('对照：挂在通用校验码上就会退化成兜底文案（这正是当初的缺陷）', () => {
    const message = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: '该文档由所属的 GitHub 目录订阅统一同步，请对该目录条目触发同步' },
      { code: 'INVALID_FORMAT', fallbackMessage: '操作未完成', recoveryMessage: '请检查输入后重试。' },
    );

    expect(message).not.toContain('目录条目触发同步');
  });
});

describe('同步中签名（驱动页面轮询）', () => {
  const entries = [
    { id: 'p1', sourceType: GITHUB_DIRECTORY_SOURCE, syncStatus: 'syncing' },
    { id: 'p0', sourceType: GITHUB_DIRECTORY_SOURCE, syncStatus: 'syncing' },
    { id: 'p2', sourceType: GITHUB_DIRECTORY_SOURCE, syncStatus: 'idle' },
    // 暂停优先于同步中：暂停的条目后台不会再推进，轮询没有意义
    { id: 'p3', sourceType: GITHUB_DIRECTORY_SOURCE, syncStatus: 'syncing', isPaused: true },
    // 子文档是 subscription，不该把轮询拖住（它们由父目录统一同步）
    { id: 'c1', sourceType: 'subscription', syncStatus: 'syncing' },
  ];

  it('只认在同步的 GitHub 目录父条目，且顺序稳定', () => {
    expect(githubSyncingSignature(entries)).toBe('p0|p1');
  });

  it('没有在同步的就返回空串——轮询必须能停下来', () => {
    expect(githubSyncingSignature([])).toBe('');
    expect(githubSyncingSignature(entries.filter((e) => e.syncStatus !== 'syncing'))).toBe('');
  });
});

describe('把在盯的父条目并回当前页', () => {
  const page = [{ id: 'a' }, { id: 'b' }];

  it('在页里就替换成最新状态', () => {
    expect(mergeWatchedParents(page, [{ id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
    const fresh = { id: 'b', syncStatus: 'idle' };
    expect(mergeWatchedParents(page, [fresh])[1]).toBe(fresh);
  });

  it('被自己的子文档挤出这一页时要补回来——否则轮询会提前停', () => {
    const parent = { id: 'p', syncStatus: 'syncing' };
    const merged = mergeWatchedParents(page, [parent]);
    expect(merged).toHaveLength(3);
    expect(merged).toContain(parent);
  });

  it('没有在盯的条目时原样返回', () => {
    expect(mergeWatchedParents(page, [])).toEqual(page);
  });
});
