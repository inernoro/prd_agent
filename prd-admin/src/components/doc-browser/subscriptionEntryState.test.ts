import { describe, it, expect } from 'vitest';
import {
  canOpenSubscriptionPanel,
  subscriptionSyncTone,
  githubDirectoryStatusLabel,
  subscriptionIntervalOptions,
  GITHUB_DIRECTORY_SOURCE,
} from './subscriptionEntryState';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';

describe('订阅条目状态判据（2026-09-09 验收 P1/P2 的回归锁）', () => {
  it('GitHub 目录父条目必须有订阅面板入口', () => {
    // 目录条目才是「立即同步」真正作用的对象；漏掉它 = 同步失败后无处可点
    expect(canOpenSubscriptionPanel({ sourceType: GITHUB_DIRECTORY_SOURCE })).toBe(true);
    expect(canOpenSubscriptionPanel({ sourceType: 'subscription' })).toBe(true);
  });

  it('普通上传文档没有订阅面板', () => {
    expect(canOpenSubscriptionPanel({ sourceType: 'upload' })).toBe(false);
    expect(canOpenSubscriptionPanel({})).toBe(false);
  });

  it('目录导进来的子文档没有订阅面板', () => {
    // 子文档的 sourceType 也是 subscription，但调度早就把它们排除了（由父目录统一拉）。
    // 给它们开面板 = 「暂停」「改周期」点下去后端回成功、实际什么都没发生：
    // 一个成功的空操作比报错更难查。
    expect(canOpenSubscriptionPanel({
      sourceType: 'subscription',
      metadata: { github_parent_id: 'parent-1', github_path: 'doc/a.md' },
    })).toBe(false);
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

describe('同步周期档位', () => {
  it('GitHub 目录没有可选档位——后端一律钳成每天一次', () => {
    // 摆出 1 小时 / 6 小时 / 12 小时的结果是一次「同步间隔已更新」的成功空操作：
    // 后端 UpdateSubscription 对 github_directory 把值钳到 1440，用户以为改了，其实没有。
    expect(subscriptionIntervalOptions(GITHUB_DIRECTORY_SOURCE)).toEqual([]);
  });

  it('普通 URL 订阅仍然可调，且不超出后端允许的 5 分钟 ~ 24 小时', () => {
    const options = subscriptionIntervalOptions('subscription');

    expect(options.length).toBeGreaterThan(1);
    options.forEach((minutes) => {
      expect(minutes).toBeGreaterThanOrEqual(5);
      expect(minutes).toBeLessThanOrEqual(1440);
    });
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
