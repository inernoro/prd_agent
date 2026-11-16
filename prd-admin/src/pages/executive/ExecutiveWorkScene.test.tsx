// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
const api = vi.hoisted(() => ({
  getMobileAssets: vi.fn(),
  listRecentDocumentEntries: vi.fn(),
  getDocumentEntry: vi.fn(),
}));
vi.mock('@/services', () => api);
import { ExecutiveWorkScene } from './ExecutiveWorkScene';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  vi.clearAllMocks();
  useAuthStore.setState({ isRoot: false, permissions: [] });
});
it('无权限时不请求个人资源或知识，平台汇总不被阻塞', async () => {
  useAuthStore.setState({ isRoot: false, permissions: [] });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveWorkScene />
      </MemoryRouter>,
    ),
  );
  expect(api.getMobileAssets).not.toHaveBeenCalled();
  expect(api.listRecentDocumentEntries).not.toHaveBeenCalled();
  expect(container.textContent).toContain('暂无工作对象访问权限');
});
it('刷新图片失败保留真实旧结果，知识无摘要时不编造正文', async () => {
  useAuthStore.setState({
    isRoot: false,
    permissions: ['assets.read', 'document-store.read'],
  });
  api.getMobileAssets.mockResolvedValue({
    success: true,
    data: {
      items: [
        {
          id: 'a',
          title: '真实图片',
          type: 'image',
          createdAt: '2026-11-15',
          source: '上传',
          url: '/image.png',
        },
      ],
    },
  });
  api.listRecentDocumentEntries.mockResolvedValue({
    success: true,
    data: {
      items: [
        {
          id: 'e',
          storeId: 's',
          storeName: '共享库',
          title: '真实知识',
          updatedAt: '2026-11-15',
          contentType: 'markdown',
          tags: [],
        },
      ],
    },
  });
  api.getDocumentEntry.mockResolvedValue({
    success: true,
    data: { summary: '' },
  });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveWorkScene />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toContain('真实图片');
  expect(container.textContent).toContain('我可访问的个人与团队知识');
  expect(container.textContent).toContain('打开阅读正文');
  api.getMobileAssets.mockResolvedValue({
    success: false,
    error: { message: '临时失败' },
  });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveWorkScene revision={1} />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toContain('保留上次结果');
  expect(container.textContent).toContain('真实图片');
});
