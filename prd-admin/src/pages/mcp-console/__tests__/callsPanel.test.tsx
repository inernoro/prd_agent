// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { listMcpCalls } from '@/services';
import { McpCallsPanel } from '../McpCallsPanel';
import type { McpCallLogDto, McpClientDto } from '@/services/contracts/mcpConsole';

vi.mock('@/services', () => ({ listMcpCalls: vi.fn() }));
vi.mock('@/components/ui/PrdLoader', () => ({ PrdLoader: () => <span>正在加载</span> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const call: McpCallLogDto = { id: 'old', keyId: 'one', keyName: '历史客户端', toolName: 'knowledge_base_list_stores', status: 'success', isWrite: false, imageCount: 0, deduplicated: false, durationMs: 100, createdAt: '2026-01-01T01:00:00Z' };
const client: McpClientDto = { keyId: 'one', name: 'Codex', keyPrefix: 'test', scopes: [], scopeMode: 'manual', missingCapabilities: [], isActive: true, todayCalls: 0, dailyImageQuota: 50, dailyWriteQuota: 200, rateLimitPerMin: 60, todayImages: 0, todayWrites: 0 };
const result = (items: McpCallLogDto[] = [], total = items.length) => ({ success: true as const, error: null, data: { items, total, skip: 0, limit: 50 } });
async function mount(compact = false) {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<McpCallsPanel clients={[client]} compact={compact} />));
}
async function change(label: string, value: string) {
  await act(async () => { const el = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function click(text: string) { await act(async () => Array.from(document.querySelectorAll('button')).find(el => el.textContent === text)!.click()); }
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.resetAllMocks(); document.body.innerHTML = ''; });

it('首页最近请求读取全部日期，显示跨天记录，不依赖今日统计', async () => {
  vi.mocked(listMcpCalls).mockResolvedValue(result([call]));
  await mount(true);
  expect(listMcpCalls).toHaveBeenCalledWith({ keyId: undefined, status: undefined, skip: 0, limit: 5 });
  expect(document.body.textContent).toContain('历史客户端');
  expect(document.body.textContent).toContain('01/01');
  expect(document.body.textContent).toContain('全部日期');
});

it('客户端筛选为空不声称整个历史为空，清除后恢复记录', async () => {
  vi.mocked(listMcpCalls).mockResolvedValueOnce(result([call])).mockResolvedValueOnce(result()).mockResolvedValueOnce(result([call]));
  await mount(); await change('筛选调用客户端', 'one');
  expect(document.body.textContent).toContain('当前筛选下没有记录');
  expect(document.body.textContent).not.toContain('当前环境暂无工具调用记录');
  await click('清除筛选'); expect(document.body.textContent).toContain('历史客户端');
});

it('网络异常显示读取失败，重试后才能判定空历史', async () => {
  vi.mocked(listMcpCalls).mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(result());
  await mount();
  expect(document.body.textContent).toContain('调用记录没读到');
  expect(document.body.textContent).not.toContain('当前环境暂无工具调用记录');
  await click('重试'); expect(document.body.textContent).toContain('当前环境暂无工具调用记录');
});

it('历史支持翻页，修改筛选回到第一页', async () => {
  vi.mocked(listMcpCalls).mockResolvedValue(result([call], 51));
  await mount(); await click('下一页');
  expect(listMcpCalls).toHaveBeenLastCalledWith({ keyId: undefined, status: undefined, skip: 50, limit: 50 });
  await change('筛选调用结果', 'error');
  expect(listMcpCalls).toHaveBeenLastCalledWith({ keyId: undefined, status: 'error', skip: 0, limit: 50 });
});

it('慢返回的旧筛选不会覆盖新筛选数据', async () => {
  let resolveOld!: (value: ReturnType<typeof result>) => void;
  vi.mocked(listMcpCalls).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(result([{ ...call, id: 'new', status: 'error', keyName: '新筛选结果' }]));
  await mount(); await change('筛选调用结果', 'error');
  await act(async () => resolveOld(result([call])));
  expect(document.body.textContent).toContain('新筛选结果');
  expect(document.body.textContent).not.toContain('历史客户端');
});
