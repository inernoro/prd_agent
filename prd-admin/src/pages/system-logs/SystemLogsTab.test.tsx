// @vitest-environment jsdom
import { act, type ComponentProps, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiLogsListParams } from '@/services/contracts/apiLogs';

const requests = vi.hoisted(() => ({
  list: vi.fn((_params?: ApiLogsListParams, _signal?: AbortSignal): Promise<unknown> => new Promise<never>(() => {})),
  meta: vi.fn((_signal?: AbortSignal) => Promise.resolve({ success: true, data: { clientTypes: [], methods: [], appNames: [] } })),
}));
vi.mock('@/services', () => ({ getApiLogs: requests.list, getApiLogsMeta: requests.meta, getApiLogDetail: vi.fn(), getLlmLogs: vi.fn() }));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams()] }));
vi.mock('./LogArchivePanel', () => ({ default: () => null }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: () => null }));
vi.mock('@/components/design/SearchableSelect', () => ({ SearchableSelect: () => null }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('@/components/design/GlassCard', () => ({ GlassCard: ({ children }: PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/design/Badge', () => ({ Badge: ({ children }: PropsWithChildren) => <span>{children}</span> }));
vi.mock('@/components/design/Button', () => ({ Button: ({ children, onClick, disabled }: ComponentProps<'button'>) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
import SystemLogsTab from './SystemLogsTab';

let host: HTMLDivElement;
let root: Root;
let unmounted: boolean;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.useFakeTimers();
  vi.clearAllMocks();
  requests.list.mockImplementation(() => new Promise<never>(() => {}));
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host); unmounted = false;
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  host.remove(); vi.useRealTimers();
});

it('keeps one pending poll, loads the page once, and cancels work when leaving', async () => {
  await act(async () => root.render(<SystemLogsTab />));
  await act(async () => vi.advanceTimersByTime(30000));
  expect(requests.list.mock.calls.filter(([p]) => p?.status === 'running')).toHaveLength(1);
  expect(requests.list.mock.calls.filter(([p]) => p?.status !== 'running')).toHaveLength(1);
  const signals = requests.list.mock.calls.map(([, signal]) => signal);
  expect(signals.every((s) => s && !s.aborted)).toBe(true);
  await act(async () => root.unmount()); unmounted = true;
  expect(signals.every((s) => s?.aborted)).toBe(true);
  expect(requests.meta.mock.calls[0][0]?.aborted).toBe(true);
});

it('resets changed filters to the first page while retaining normal pagination', async () => {
  requests.list.mockImplementation(async (params) => ({ success: true, data: { items: [], total: 150, page: params?.page ?? 1, pageSize: 30 } }));
  await act(async () => root.render(<SystemLogsTab />));
  const next = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '下一页')!;
  await act(async () => next.click());
  expect(requests.list.mock.calls.filter(([p]) => p?.status !== 'running').at(-1)?.[0]?.page).toBe(2);
  requests.list.mockClear();
  const path = host.querySelector<HTMLInputElement>('input[placeholder="path"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(path, '/changed');
    path.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const filtered = requests.list.mock.calls.filter(([p]) => p?.status !== 'running' && p?.path === '/changed');
  expect(filtered).toHaveLength(1);
  expect(filtered[0][0]?.page).toBe(1);
});
