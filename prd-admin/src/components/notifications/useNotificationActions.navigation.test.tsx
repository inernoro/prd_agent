// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotificationActions } from './useNotificationActions';
import type { AdminNotificationItem } from '@/services/contracts/notifications';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { batch, ticket, error } = vi.hoisted(() => ({ batch: vi.fn(), ticket: vi.fn(), error: vi.fn() }));
vi.mock('@/services', () => ({ handleBatchAdminNotifications: batch, createLlmGatewaySsoTicket: ticket }));
vi.mock('@/lib/toast', () => ({ toast: { error, success: vi.fn() } }));
let host: HTMLDivElement;
let root: Root;
const closed = vi.fn();
const base: AdminNotificationItem = { id: 'existing-notice', title: '草稿已生成', level: 'info', status: 'open', source: 'report-agent', actionUrl: '/report-agent?tab=report&weekYear=2026&weekNumber=46', createdAt: '2026-11-15', updatedAt: '2026-11-15' };
function Probe({ item }: { item: AdminNotificationItem }) {
  const { openNotification } = useNotificationActions({ refresh: async () => {}, onNavigated: closed });
  const location = useLocation();
  return <><button onClick={() => void openNotification(item)}>打开对象</button><output>{location.pathname}{location.search}</output></>;
}
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function open(item = base) {
  await act(async () => root.render(<MemoryRouter initialEntries={['/users']}><Probe item={item} /></MemoryRouter>));
  await act(async () => host.querySelector('button')!.click());
}
it('通知成功导航后关闭遮挡列表，保留周期，并且不确认通知', async () => {
  await open();
  expect(host.querySelector('output')?.textContent).toBe(base.actionUrl);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(batch).not.toHaveBeenCalled();
});
it('非法入口或网关授权失败仍保留通知列表，不冒充跳转或确认成功', async () => {
  await open({ ...base, actionUrl: '//untrusted.invalid' });
  expect(closed).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  ticket.mockResolvedValue({ success: false, error: { message: '没有网关权限' } });
  await open({ ...base, actionKind: 'llm-gateway', actionUrl: '/requests' });
  expect(closed).not.toHaveBeenCalled();
  expect(host.querySelector('output')?.textContent).toBe('/users');
  expect(batch).not.toHaveBeenCalled();
});
