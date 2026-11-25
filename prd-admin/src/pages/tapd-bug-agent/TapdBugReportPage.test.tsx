// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TapdBugDraft } from '@/services/contracts/tapdBugAgent';
import { streamTapdBugPreviewReal } from '@/services/real/tapdBugAgent';
import { TapdBugReportPage } from './TapdBugReportPage';

vi.mock('@/components/daily-tips/TipsEntryButton', () => ({ TipsEntryButton: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/services/real/tapdBugAgent', () => ({ streamTapdBugPreviewReal: vi.fn(), submitTapdBugReal: vi.fn() }));

const draft: TapdBugDraft = {
  title: '地区筛选后列表未更新',
  module: '门店筛选',
  severity: 'normal',
  priority: 'medium',
  bugType: '逻辑错误',
  currentOwner: '',
  versionReport: '',
  preconditions: ['有两个地区的门店'],
  steps: ['打开列表并选择一个地区'],
  actualResult: ['列表仍展示全部门店'],
  expectedResult: ['列表只展示所选地区的门店'],
  missingFields: [],
};

it('表单直出和规则兜底不会把上一轮或尝试失败的模型显示为草稿来源', async () => {
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const rootElement = document.createElement('div');
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  const preview = vi.mocked(streamTapdBugPreviewReal);
  preview
    .mockImplementationOnce(async (_input, events) => {
      events?.onModel?.('actual-model-a', '测试平台');
      events?.onDraft?.(draft);
      return draft;
    })
    .mockImplementationOnce(async (_input, events) => {
      events?.onStage?.('validated', '已按表单内容生成缺陷草稿');
      events?.onDraft?.(draft);
      return draft;
    })
    .mockImplementationOnce(async (_input, events) => {
      events?.onModel?.('failed-model-b', '测试平台');
      events?.onStage?.('fallback', '模型整理失败，已使用规则兜底生成草稿');
      events?.onDraft?.(draft);
      return draft;
    });
  try {
    await act(async () => root.render(<TapdBugReportPage />));
    const description = rootElement.querySelector<HTMLTextAreaElement>('textarea')!;
    const button = [...rootElement.querySelectorAll('button')].find((element) => element.textContent?.trim() === '生成缺陷草稿')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(description, '选地区后筛选失败');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button.click());
    expect(rootElement.textContent).toContain('模型：actual-model-a');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(description, '');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button.click());
    expect(rootElement.textContent).toContain('已按表单内容生成缺陷草稿');
    expect(rootElement.textContent).not.toContain('模型：actual-model-a');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(description, '选地区后筛选失败');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button.click());
    expect(rootElement.textContent).toContain('已使用规则兜底生成草稿');
    expect(rootElement.textContent).not.toContain('模型：failed-model-b');
  } finally {
    await act(async () => root.unmount());
    rootElement.remove();
    preview.mockReset();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
