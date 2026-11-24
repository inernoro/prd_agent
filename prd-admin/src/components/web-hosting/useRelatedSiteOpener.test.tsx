// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSite, type HostedSite } from '@/services/real/webPages';
import { useRelatedSiteOpener } from './useRelatedSiteOpener';

vi.mock('@/services/real/webPages', () => ({ getSite: vi.fn() }));
let opener: ReturnType<typeof useRelatedSiteOpener>;
const onOpened = vi.fn(), onError = vi.fn();
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
function Harness() { opener = useRelatedSiteOpener(onOpened, onError); return null; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  container = document.createElement('div'); root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('只将通过权限检查的目标交给当前预览，不写路由', async () => {
  const site = { id: 'target', title: '目标文档' } as HostedSite;
  vi.mocked(getSite).mockResolvedValue({ success: true, data: site, error: null });
  const url = location.href;
  await opener.open(site.id);
  expect(getSite).toHaveBeenCalledWith(site.id);
  expect(onOpened).toHaveBeenCalledWith(site);
  expect(location.href).toBe(url);
});

it('目标权限失效时保留原预览并显示失败原因', async () => {
  vi.mocked(getSite).mockResolvedValue({ success: false, data: null as never, error: { code: 'FORBIDDEN', message: '无权访问' } });
  await opener.open('denied');
  expect(onOpened).not.toHaveBeenCalled();
  expect(onError).toHaveBeenLastCalledWith('无权访问');
});

it('连续切换及关闭后不让较早的响应重新打开或覆盖文档', async () => {
  const pending = new Map<string, (result: Awaited<ReturnType<typeof getSite>>) => void>();
  vi.mocked(getSite).mockImplementation(id => new Promise(resolve => pending.set(id, resolve)));
  const first = opener.open('first'), second = opener.open('second');
  pending.get('second')!({ success: true, data: { id: 'second' } as HostedSite, error: null }); await second;
  pending.get('first')!({ success: true, data: { id: 'first' } as HostedSite, error: null }); await first;
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(onOpened).toHaveBeenLastCalledWith({ id: 'second' });
  const closed = opener.open('closed'); opener.cancel();
  pending.get('closed')!({ success: true, data: { id: 'closed' } as HostedSite, error: null }); await closed;
  expect(onOpened).toHaveBeenCalledTimes(1);
});
