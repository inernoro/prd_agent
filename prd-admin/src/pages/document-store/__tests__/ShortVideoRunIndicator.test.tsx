// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShortVideoMaterialRun } from '@/services';
import * as runStore from '@/stores/shortVideoRunStore';
import { shortVideoFailureMessage } from '@/lib/shortVideoFailure';
import { ShortVideoRunIndicator } from '../ShortVideoRunIndicator';
import { shortVideoCompactStatus } from '../ReprocessChatDrawer';

const calls = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock('@/services', async (original) => ({
  ...await original<typeof import('@/services')>(), getShortVideoMaterialRun: calls.getRun,
}));
const fixture = (status: string): ShortVideoMaterialRun => ({
  id: 'local-cancelled-fixture', userId: 'local-owner', videoUrl: 'https://fixture.invalid/video.mp4',
  platform: 'unknown', title: '本机取消状态回归', sourceMode: 'manual', status,
  stages: [{ key: 'source', label: '保存原始视频', status: 'running', message: '', at: '2026-11-11T00:00:00Z' }],
  createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
});
let root: Root | undefined;
let host: HTMLDivElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.useFakeTimers(); calls.getRun.mockReset();
  runStore.useShortVideoRunStore.setState({ runs: {} });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove();
  runStore.useShortVideoRunStore.setState({ runs: {} });
  sessionStorage.clear(); vi.useRealTimers();
});
async function mount() {
  runStore.useShortVideoRunStore.getState().startRun({ runId: fixture('running').id, storeId: 'local-store', title: '本机取消状态回归' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const completed = vi.fn();
  await act(async () => root!.render(<ShortVideoRunIndicator storeId="local-store" onOpenRun={vi.fn()} onRunCompleted={completed} />));
  return completed;
}

describe('短视频既有消费者的取消终态', () => {
  it('真实悬浮入口接到cancelled后停止轮询并可正常移除', async () => {
    calls.getRun.mockResolvedValue({ success: true, data: fixture('cancelled') });
    const completed = await mount();
    expect(runStore.useShortVideoRunStore.getState().runs[fixture('running').id].status).toBe('cancelled');
    expect(host.textContent).toContain('已取消');
    expect(host.textContent).not.toContain('解析失败');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(calls.getRun).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    const dismiss = host.querySelector<HTMLButtonElement>('button[title="移除"]');
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss!.click());
    expect(runStore.useShortVideoRunStore.getState().runs).toEqual({});
  });

  it('后台取消优先于上一次仍running的阶段文案', () => {
    expect(shortVideoCompactStatus(fixture('cancelled'))).toEqual({ text: '已取消', tone: 'cancelled' });
  });

  it.each(['done', 'failed'])('原%s终态继续停止轮询', async (status) => {
    calls.getRun.mockResolvedValue({ success: true, data: fixture(status) });
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(calls.getRun).toHaveBeenCalledTimes(1);
    expect(runStore.useShortVideoRunStore.getState().runs[fixture('running').id].status).toBe(status);
  });

  it('执行抽屉实际轮询回调：取消即结束消息并释放发送锁', async () => {
    const text = readFileSync(resolve('src/pages/document-store/ReprocessChatDrawer.tsx'), 'utf8');
    const tree = ts.createSourceFile('ReprocessChatDrawer.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.ArrowFunction | undefined;
    let sync: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'syncShortVideoRunToStore') sync = node;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'pollShortVideoRun'
          && node.initializer && ts.isCallExpression(node.initializer) && ts.isArrowFunction(node.initializer.arguments[0])) callback = node.initializer.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(tree); expect(callback).toBeDefined(); expect(sync).toBeDefined();
    const cancelled = fixture('cancelled'); calls.getRun.mockResolvedValue({ success: true, data: cancelled });
    type Message = { id: string; streaming: boolean; phase: string; shortVideoRun?: ShortVideoMaterialRun };
    let messages: Message[] = [{ id: 'message', streaming: true, phase: 'streaming' }];
    const sendLockRef = { current: true }, setStreamingId = vi.fn();
    const exported = runStore as unknown as Record<string, unknown>;
    const bindings = {
      useShortVideoRunStore: runStore.useShortVideoRunStore, shortVideoCompactStatus,
      normalizeShortVideoRunStatus: exported.normalizeShortVideoRunStatus,
      isTerminalShortVideoRunStatus: exported.isTerminalShortVideoRunStatus,
      isShortVideoPollActive: () => true, getShortVideoMaterialRun: calls.getRun, storeId: 'local-store',
      setMessages: (update: (old: Message[]) => Message[]) => { messages = update(messages); },
      setStreamingId, sendLockRef, onStoreChanged: vi.fn(), shortVideoFailureMessage,
      formatShortVideoProgress: () => '后台任务：已取消',
      window: { setTimeout: () => { throw new Error('取消终态不应再安排轮询'); } },
    };
    const code = ts.transpileModule(`${sync!.getText(tree)}\nconst callback=${callback!.getText(tree)};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const poll = new Function(...Object.keys(bindings), `${code}\nreturn callback;`)(...Object.values(bindings)) as (id: string, message: string, owner: string, token: number) => Promise<void>;
    await poll(cancelled.id, 'message', 'local-owner', 1);
    expect(calls.getRun).toHaveBeenCalledTimes(1);
    expect(messages[0].streaming).toBe(false); expect(messages[0].phase).toBe('done');
    expect(messages[0].shortVideoRun?.status).toBe('cancelled');
    expect(sendLockRef.current).toBe(false); expect(setStreamingId).toHaveBeenCalledWith(null);
  });
});
