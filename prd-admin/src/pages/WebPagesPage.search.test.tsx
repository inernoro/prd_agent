// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebPagesPage from './WebPagesPage';

const { listSites, viewport } = vi.hoisted(() => ({
  listSites: vi.fn(),
  viewport: { isMobile: false },
}));

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => viewport,
  useIsMobile: () => viewport.isMobile,
}));
vi.mock('@/services', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services')>(),
  listSites,
  listSiteFolders: async () => ({ success: true, data: { folders: [] } }),
  listSiteTags: async () => ({ success: true, data: { tags: [] } }),
  listWebFolders: async () => ({ success: true, data: { items: [] } }),
  listSiteShares: async () => ({ success: true, data: { items: [] } }),
}));
vi.mock('@/services/real/teams', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/real/teams')>(),
  listMyTeams: async () => ({ success: true, data: { items: [] } }),
}));
vi.mock('@/components/web-hosting/useRelatedSummaries', () => ({ useRelatedSummaries: () => ({}) }));
vi.mock('@/components/web-hosting/useSitePreviewHtml', () => ({
  useSitePreviewHtml: () => ({ srcDoc: '<input autofocus>' }),
}));

const site = {
  id: 'site-1', title: '架构', siteUrl: 'https://example.test/index.html', files: [],
  tags: [], teamIds: [], sourceType: 'upload', visibility: 'private',
  createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z',
};
const preview = 'iframe[title="preview"]';
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() {
      this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() {}
  });
  listSites.mockReset().mockImplementation(async ({ keyword }) => ({
    success: true,
    data: {
      items: keyword === '架构' ? [site] : [{ ...site, id: 'initial', title: '初始网页' }],
      total: 1,
    },
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function inputText(input: HTMLInputElement, value: string, isComposing = false) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing }));
}

it.each([
  ['桌面', false, '搜索标题、描述、标签'],
  ['移动端', true, '搜索站点名称、描述...'],
] as const)('%s仅用已确认的拼音选词搜索，实时预览在输入期间暂停', async (_name, mobile, placeholder) => {
  viewport.isMobile = mobile;
  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages']}><WebPagesPage /></MemoryRouter>));
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  const previewCount = host.querySelectorAll(preview).length;
  expect(previewCount).toBeGreaterThan(0);
  const initialRequests = listSites.mock.calls.length;

  await act(async () => {
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    inputText(input, 'jiagou', true);
  });
  expect(input.value).toBe('jiagou');
  expect(listSites).toHaveBeenCalledTimes(initialRequests);
  expect(host.querySelector(preview)).toBeNull();
  expect(document.activeElement).toBe(input);

  await act(async () => {
    inputText(input, '架构', true);
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '架构' }));
  });
  expect(listSites).toHaveBeenCalledTimes(initialRequests + 1);
  expect(listSites).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '架构' }));
  expect(host.querySelector('[data-site-selection-surface] h3')?.textContent).toBe('架构');
  expect(host.querySelector(preview)).toBeNull();
  expect(document.activeElement).toBe(input);

  await act(async () => inputText(input, ''));
  expect(listSites).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: undefined }));
  await act(async () => input.blur());
  expect(host.querySelectorAll(preview)).toHaveLength(previewCount);
});
