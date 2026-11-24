// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { fail, ok } from '@/types/api';
const getTasks = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/activeTasks', () => ({ getMyActiveTasks: getTasks }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({
      user: { displayName: '测试成员' },
      permissions: [],
      isRoot: false,
    }),
}));
import { HomeTaskQueue } from './HomeTaskQueue';
it('任务刷新失败保留原任务及受阻原因，不显示为无待办', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  getTasks
    .mockResolvedValueOnce(
      ok({
        active: {
          id: 'task-1',
          title: '核对验收标准',
          blocked: true,
          blockedOn: '等待需求说明',
          running: false,
        },
        standby: [
          {
            id: 'task-2',
            title: '整理需求',
            overdue: true,
            dueLabel: '昨天要的',
          },
        ],
        displayName: '测试成员',
      }),
    )
    .mockResolvedValueOnce(fail('NETWORK', '暂不可用'));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <HomeTaskQueue />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain('等待需求说明');
    expect(container.textContent).toContain('1 件待做');
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="刷新我的任务"]',
    )!;
    await act(async () => button.click());
    expect(container.textContent).toContain('仍显示上次读取的任务');
    expect(container.textContent).toContain('核对验收标准');
    expect(container.textContent).toContain('整理需求');
    expect(
      container.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toContain('测试成员');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
