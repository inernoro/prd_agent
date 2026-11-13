// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryDocReader } from './LibraryDocReader';
import type { DocumentEntry } from '@/services/contracts/documentStore';
const auth = vi.hoisted(() => ({ isAuthenticated: true, isRoot: false, permissions: ['document-store.read'] }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: typeof auth) => unknown) => select(auth) }));
vi.mock('@/lib/useViewTracking', () => ({ useViewTracking: () => undefined }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
const fixture = (published = true): DocumentEntry => ({ id: 'doc', storeId: 'store', isFolder: false, title: '公开测试文档', sourceType: 'upload', contentType: 'text/markdown', fileSize: 12, tags: [], metadata: { writing_template: 'prd', writing_stage: 'confirm' }, createdBy: 'author', createdAt: '', updatedAt: '', hasWritingPublication: published });
async function mount(published = true, context: { writingStoreId?: string } = { writingStoreId: 'store' }) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const props = { entries: [fixture(published)], primaryEntryId: 'doc', ...context, loadContent: async () => ({ text: '测试正文', fileUrl: null, contentType: 'text/markdown' }) };
  await act(async () => root.render(<MemoryRouter><LibraryDocReader {...props} /></MemoryRouter>));
}
beforeEach(() => { auth.isAuthenticated = true; auth.isRoot = false; auth.permissions = ['document-store.read']; });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('公开库原生阅读与已发布阅读的连续性', () => {
  it('深层主文档位于后续根批次和子批次时，祖先与选中行仍会挂载', async () => {
    const roots = Array.from({ length: 220 }, (_, i) => ({ ...fixture(false), id: `r${i}`, title: `根${String(i).padStart(3, '0')}`, isFolder: true }));
    const folders = Array.from({ length: 220 }, (_, i) => ({ ...fixture(false), id: `f${i}`, title: `子${String(i).padStart(3, '0')}`, parentId: 'r219', isFolder: true }));
    const doc = { ...fixture(false), parentId: 'f219' };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><LibraryDocReader entries={[...roots, ...folders, doc]}
      primaryEntryId="doc" loadContent={async () => ({ text: '深层正文', fileUrl: null, contentType: 'text/markdown' })} /></MemoryRouter>));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.some(button => button.textContent?.includes('公开测试文档'))).toBe(true);
    expect(buttons.some(button => button.textContent?.includes('根219'))).toBe(true);
    expect(buttons.some(button => button.textContent?.includes('子219'))).toBe(true);
    expect(buttons.length).toBeLessThan(200);
    expect(container.textContent).toContain('深层正文');
  });
  it('下一版confirm但发布flag仍真时，只读者可直接阅读和学习', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    expect(links.find(a => a.textContent === '分层阅读')?.getAttribute('href')).toBe('/document-store/store/write/doc/read');
    expect(links.find(a => a.textContent === '开始学习')?.getAttribute('href')).toBe('/document-store/store/write/doc/learn');
    expect(container.textContent).toContain('测试正文');
    expect(container.textContent).not.toContain('继续成文');
  });
  it('未发布flag假不借用模板或阶段显示已发布入口', async () => {
    await mount(false);
    expect(container.querySelector('a[href*="/write/"]')).toBeNull();
  });
  it('不传原库上下文的复用方，即使条目flag真也不能出现原库深链', async () => {
    await mount(true, {});
    expect(container.querySelector('a[href*="/write/"]')).toBeNull();
    expect(container.querySelector('a[href*="returnUrl"]')).toBeNull();
  });
  it('正常公共库匿名用户得到明确登录入口，保留学习目标', async () => {
    auth.isAuthenticated = false; auth.permissions = [];
    await mount();
    const link = [...container.querySelectorAll('a')].find(a => a.textContent === '登录后开始学习');
    expect(link?.getAttribute('href')).toBe('/login?returnUrl=%2Fdocument-store%2Fstore%2Fwrite%2Fdoc%2Flearn');
    expect(container.querySelector('a[href="/document-store/store/write/doc/learn"]')).toBeNull();
  });
});
