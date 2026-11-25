// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import SiteEditComposer from './SiteEditComposer';
import { MAX_EDIT_SCREENSHOTS, useDesignAttachmentUploads } from './designAttachments';
vi.mock('@/components/knowledge/KnowledgeEntryPicker', () => ({ default: () => <div>知识选择器</div> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, content }: { open: boolean; content: React.ReactNode }) => open ? <div role="dialog">{content}</div> : null }));

it('默认只有输入框，知识从加号打开；输入法回车不会误提交', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const generate = vi.fn();
  const props = { instruction: '把标题缩小', setInstruction: vi.fn(), generating: false, generate,
    stopGeneration: vi.fn(), activeRunId: null, stopRequested: false, recentKnowledge: [], selectedKnowledge: [], setSelectedKnowledge: vi.fn(), loadingKnowledge: false,
    screenshots: { items: [], rejections: [], remove: vi.fn() }, screenshotsSupported: true, addScreenshots: vi.fn(),
  } as unknown as ComponentProps<typeof SiteEditComposer>;
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    act(() => root.render(<SiteEditComposer {...props} />));
    expect(container.textContent).not.toContain('知识选择器');
    act(() => (container.querySelector('[aria-label="添加引用或图片"]') as HTMLButtonElement).click());
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '引用知识')!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('知识选择器');
    const textarea = container.querySelector('textarea')!;
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    expect(generate).not.toHaveBeenCalled();
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(generate).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })));
    expect(generate).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(generate).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it('阅读页显示截图拒收原因，移除被拒附件后可以继续生成', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const generate = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function ComposerWithUploads() {
    const screenshots = useDesignAttachmentUploads('image', MAX_EDIT_SCREENSHOTS);
    return <SiteEditComposer instruction="缩小标题" setInstruction={vi.fn()} generating={false}
      generate={generate} stopGeneration={vi.fn()} activeRunId={null} stopRequested={false}
      recentKnowledge={[]} selectedKnowledge={[]} setSelectedKnowledge={vi.fn()} loadingKnowledge={false}
      screenshots={screenshots} screenshotsSupported addScreenshots={screenshots.addFiles} />;
  }
  try {
    act(() => root.render(<ComposerWithUploads />));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['test'], 'draft.pdf', { type: 'application/pdf' })] });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    const send = container.querySelector<HTMLButtonElement>('[aria-label="生成修改草稿"]')!;
    expect(send.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('PNG');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="删除截图 draft.pdf"]')!.click());
    expect(send.disabled).toBe(false);
    act(() => send.click());
    expect(generate).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
