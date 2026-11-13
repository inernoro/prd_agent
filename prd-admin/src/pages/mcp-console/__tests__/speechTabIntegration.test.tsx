// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import McpConsolePage from '../McpConsolePage';
import { getMcpConsoleOverview } from '@/services';

vi.mock('@/services', () => ({ getMcpConsoleOverview: vi.fn() }));
vi.mock('../SpeechPanel', () => ({ SpeechPanel: () => <div>语音创作内容</div> }));
vi.mock('../MapAgentSkillPanel', () => ({ MapAgentSkillPanel: () => null, useMapAgentSkillManifest: () => ({}) }));
vi.mock('../McpSummaryRail', () => ({ McpSummaryRail: () => null }));
vi.mock('../McpCallTrendChart', () => ({ McpCallTrendChart: () => null }));
vi.mock('../ConnectAgentDialog', () => ({ ConnectAgentDialog: () => null }));
vi.mock('../QuotaEditorDialog', () => ({ QuotaEditorDialog: () => null }));
vi.mock('../RevokeClientDialog', () => ({ RevokeClientDialog: () => null }));

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function Location() { return <output>{useLocation().search}</output>; }

it('新版接入台保留语音历史深链，并能从客户端页签再次进入', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getMcpConsoleOverview).mockResolvedValue({ success: true, error: null, data: {
    endpointUrl: 'https://map.example.test/mcp', clients: [], capabilities: [], recentCalls: [],
    hasHistory: false, today: { sinceUtc: '2026-11-09T00:00:00Z', calls: 0, failed: 0, denied: 0, images: 0, writes: 0 },
  } });
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={['/mcp-console?tab=speech&run=existing-run']}><McpConsolePage /><Location /></MemoryRouter>));
  expect(container.textContent).toContain('语音创作内容');
  const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(item => item.textContent?.startsWith(label))!;
  await act(async () => tab('客户端').click());
  expect(container.textContent).toContain('当前没有已接入的客户端');
  expect(container.querySelector('output')?.textContent).toBe('?run=existing-run');
  await act(async () => tab('语音创作').click());
  expect(container.textContent).toContain('语音创作内容');
  expect(container.querySelector('output')?.textContent).toContain('run=existing-run');
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('语音创作');
});
