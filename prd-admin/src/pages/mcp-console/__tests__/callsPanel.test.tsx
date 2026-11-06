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
async function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<McpCallsPanel clients={[client]} />));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.resetAllMocks(); document.body.innerHTML = ''; });

it('语音入队虽然已有历史链接，调用记录仍显示未完成，并可打开任务', async () => {
  vi.mocked(listMcpCalls).mockResolvedValue(result([{ ...call, toolName: 'map_speech_generate', isWrite: true, artifact: { kind: 'audio-run', id: 'speech-1', url: '/mcp-console?tab=speech&run=speech-1', status: 'queued' } }]));
  await mount();
  expect(document.body.textContent).toContain('还没出结果');
  expect(document.querySelector('a[href="/mcp-console?tab=speech&run=speech-1"]')?.textContent).toContain('查看语音任务');
});

it('语音结果不明显示待核查并指向历史，不建议再次提交', async () => {
  vi.mocked(listMcpCalls).mockResolvedValue(result([{ ...call, toolName: 'map_speech_generate', isWrite: true, artifact: { kind: 'audio-run', id: 'speech-1', url: '/mcp-console?tab=speech&run=speech-1', status: 'unknown' } }]));
  await mount();
  expect(document.body.textContent).toContain('待核查');
  await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('map_speech_'))!.click());
  expect(document.body.textContent).toContain('确认前不要再次提交生成');
  expect(document.body.textContent).toContain('任务历史');
  expect(document.body.textContent).not.toContain('从发起到失败');
});

it('分组内语音每一步也依据业务状态显示，不把已入队的步骤写成成功', async () => {
  const artifact = { kind: 'audio-run', id: 'speech-1', url: '/mcp-console?tab=speech&run=speech-1', status: 'generating' };
  vi.mocked(listMcpCalls).mockResolvedValue(result([
    { ...call, id: 'poll', toolName: 'map_speech_get_run', createdAt: '2026-11-06T01:00:10Z', artifact },
    { ...call, id: 'enqueue', toolName: 'map_speech_generate', isWrite: true, createdAt: '2026-11-06T01:00:00Z', artifact },
  ]));
  await mount();
  await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('map_speech_'))!.click());
  const steps = [...document.querySelectorAll('code')].filter(node => node.textContent?.startsWith('map_speech_')).map(node => node.parentElement?.textContent);
  expect(steps).toHaveLength(2);
  steps.forEach(text => { expect(text).toContain('还没出结果'); expect(text).not.toContain('成功'); });
});
