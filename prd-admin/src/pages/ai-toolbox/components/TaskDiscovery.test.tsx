// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_TOOLS, useToolboxStore } from '@/stores/toolboxStore';
vi.mock('@/components/ui/DesktopDownloadDialog', () => ({
  DesktopDownloadDialog: ({ open }: { open: boolean }) =>
    open ? <div>桌面下载入口</div> : null,
}));
import { TaskDiscovery } from './TaskDiscovery';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const initial = useToolboxStore.getState();
let root: ReturnType<typeof createRoot> | undefined;
let node: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  node?.remove();
  root = undefined;
  useToolboxStore.setState(initial);
  vi.unstubAllGlobals();
});
async function open(item: (typeof BUILTIN_TOOLS)[number]) {
  const select = vi.fn();
  const track = vi.fn();
  useToolboxStore.setState({
    recentlyUsedIds: [item.id],
    selectItem: select,
    trackRecentlyUsed: track,
  });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  function Location() {
    return <output>{useLocation().pathname}</output>;
  }
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={['/ai-toolbox']}>
        <TaskDiscovery items={[item]} />
        <Location />
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    (
      node.querySelector('.task-discovery-recent button') as HTMLButtonElement
    ).click(),
  );
  return { select, track };
}
it('最近使用的专属工具打开注册工作区并更新访问记录', async () => {
  const item = BUILTIN_TOOLS.find((item) => item.agentKey === 'visual-agent')!;
  const { select, track } = await open(item);
  expect(node.querySelector('output')?.textContent).toBe(item.routePath);
  expect(select).not.toHaveBeenCalled();
  expect(track).toHaveBeenCalledWith(item.id);
});
it('没有独立路由的工具继续打开通用详情', async () => {
  const item = BUILTIN_TOOLS.find(
    (item) => !item.routePath && item.agentKey !== 'prd-agent',
  )!;
  const { select } = await open(item);
  expect(select).toHaveBeenCalledWith(item);
  expect(node.querySelector('output')?.textContent).toBe('/ai-toolbox');
});
it('CDS最近入口保持完整页面导航', async () => {
  const assign = vi.fn();
  const original = window;
  vi.stubGlobal(
    'window',
    new Proxy(original, {
      get(target, key) {
        return key === 'location' ? { assign } : Reflect.get(target, key);
      },
    }),
  );
  const item = BUILTIN_TOOLS.find((item) => item.agentKey === 'cds-agent')!;
  const { select } = await open(item);
  expect(assign).toHaveBeenCalledWith(item.routePath);
  expect(select).not.toHaveBeenCalled();
});
it('桌面端工具保留下载入口而不进入通用对话', async () => {
  const item = {
    ...BUILTIN_TOOLS[0],
    id: 'desktop-prd',
    name: 'PRD 桌面',
    agentKey: 'prd-agent',
    routePath: undefined,
  };
  const { select, track } = await open(item);
  expect(node.textContent).toContain('桌面下载入口');
  expect(select).not.toHaveBeenCalled();
  expect(track).not.toHaveBeenCalled();
});
