// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiteraryModelPicker } from './LiteraryModelPicker';
import type { LiteraryModelOption } from './literaryModelOptions';

const models: LiteraryModelOption[] = ['DeepSeek-V4', 'DeepSeek-V4-Pro'].map((name, i) => ({
  id: `pool_${i}`, poolId: String(i), name: `deepseek-ai/${name}`, modelName: `logical-${i}`,
  actualModelId: `deepseek-ai/${name}`, platformId: 'gateway', actualPlatformId: 'upstream',
  enabled: true, isDedicated: true, isDefault: i === 0,
}));

describe('工作台紧凑模型选择', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (overrides: Partial<Parameters<typeof LiteraryModelPicker>[0]> = {}) => {
    const onSelect = vi.fn();
    await act(async () => root.render(
      <LiteraryModelPicker label="写作" icon={<span />} model={models[0]} options={models}
        open={false} onOpenChange={() => {}} onSelect={onSelect} {...overrides} />,
    ));
    return onSelect;
  };

  it('按钮省略供应商前缀，悬停仍显示完整模型身份', async () => {
    await render();
    const trigger = container.querySelector('button')!;
    expect(trigger.textContent).toContain('写作DeepSeek-V4');
    expect(trigger.textContent).not.toContain('deepseek-ai/');
    expect(trigger.title).toContain(models[0].name);
    expect(trigger.getAttribute('aria-label')).toBe('写作模型');
  });

  it('选择菜单项仍提交原始选项 ID，保留完整名称和默认标记', async () => {
    const onSelect = await render({ open: true });
    const items = document.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain(models[0].name);
    expect(items[0].textContent).toContain('默认模型');
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    await act(async () => items[1].click());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(models[1].id);
  });

  it('自动调度显示为只读状态，不能当作可选择的模型', async () => {
    await render({ model: { ...models[0], isAutoResolved: true } });
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('自动');
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toContain(models[0].name);
  });

  it('没有可选模型时，菜单显示空状态', async () => {
    await render({ model: null, options: [], open: true });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('暂无可用模型池');
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  });
});
