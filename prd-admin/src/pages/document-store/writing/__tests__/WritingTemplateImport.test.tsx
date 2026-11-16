// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { WritingTemplateImport } from '../WritingTemplateImport';
const importTemplate = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/writing', () => ({ importWritingTemplate: importTemplate }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe('组织模版导入', () => {
  it('按真实文件换行预览章节并从文件名取得名称', async () => {
    const markdown = '# 交接模版\r\n## 执行条件\r\n范围与批准人\r\n## 异常处理\r\n停止条件';
    importTemplate.mockResolvedValue({ success: true, data: { template: { id: 'org-1', name: 'handoff' } } });
    const imported = vi.fn(), container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<WritingTemplateImport storeId="store-1" disabled={false} onImported={imported} />));
      const file = new File([markdown], 'handoff.md', { type: 'text/markdown' });
      Object.defineProperty(file, 'text', { value: async () => markdown });
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(container.querySelector<HTMLInputElement>('input.field')?.value).toBe('handoff');
      expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual(['执行条件', '异常处理']);
      const button = container.querySelector<HTMLButtonElement>('button')!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(importTemplate).toHaveBeenCalledWith('store-1', 'handoff', markdown);
      expect(imported).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-1' }));
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
