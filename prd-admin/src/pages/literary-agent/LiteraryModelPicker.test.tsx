// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiteraryModelPicker } from './LiteraryModelPicker';
import type { LiteraryModelOption } from './literaryModelOptions';
import { LiteraryInlineMenuGroup, LiterarySettingsRow } from './LiteraryInlineMenu';
import { QuickMenu, QuickMenuItem } from './LiteraryQuickMenu';

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
    expect(trigger.textContent).toContain('写作模型');
    expect(trigger.querySelector('.lit-model-name')?.textContent).toBe('DeepSeek-V4');
    expect(trigger.title).toContain(models[0].name);
    expect(trigger.getAttribute('aria-label')).toBe('写作模型');
  });

  it('选择菜单项仍提交原始选项 ID，保留完整名称和默认标记', async () => {
    const onSelect = await render({ open: true });
    const items = document.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain(models[0].name);
    expect(items[0].textContent).toContain('系统默认');
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

  it('保存期间禁用触发器和已展开选项，避免再次提交', async () => {
    const onSelect = await render({ disabled: true, open: true });
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    const item = container.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!;
    expect(item.disabled).toBe(true);
    await act(async () => item.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('保留主分支的失效模型提示，允许从新目录重新选择', async () => {
    const onSelect = await render({ model: null, unavailable: true, open: true });
    const trigger = container.querySelector<HTMLButtonElement>('.lit-model-trigger')!;
    expect(trigger.textContent).toContain('原模型不可用，请重选');
    expect(trigger.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
    expect(onSelect).toHaveBeenCalledWith(models[0].id);
  });

  it('没有可选模型时，菜单显示空状态', async () => {
    await render({ model: null, options: [], open: true });
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('暂无可用模型池');
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  function InteractivePicker() {
    const [writingOpen, setWritingOpen] = useState(false);
    const [imageOpen, setImageOpen] = useState(false);
    const [selected, setSelected] = useState(models[0].id);
    const [prompt, setPrompt] = useState('自动推断');
    return <LiteraryInlineMenuGroup>
      <QuickMenu inline title="提示词" trigger={<LiterarySettingsRow icon={<span />} label="提示词" value={prompt} aria-label="提示词" />}>
        <QuickMenuItem label="自然叙事" selected={prompt === '自然叙事'} onSelect={() => setPrompt('自然叙事')} />
        <QuickMenuItem label="不可用" disabled onSelect={() => setPrompt('不可用')} />
      </QuickMenu>
      <LiteraryModelPicker label="写作" icon={<span />} model={models.find(model => model.id === selected)!} options={models}
        open={writingOpen} onOpenChange={setWritingOpen} onSelect={setSelected} />
      <LiteraryModelPicker label="配图" icon={<span />} model={models[0]} options={models}
        open={imageOpen} onOpenChange={setImageOpen} onSelect={() => {}} />
    </LiteraryInlineMenuGroup>;
  }
  const click = async (element: Element) => act(async () => { (element as HTMLElement).click(); });
  const trigger = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;

  it('六项设置共用页面内的展开区域，切换模型或设置会收起上一项', async () => {
    await act(async () => root.render(<InteractivePicker />));
    await click(trigger('写作模型'));
    expect(trigger('写作模型').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
    await click(trigger('配图模型'));
    expect(trigger('写作模型').getAttribute('aria-expanded')).toBe('false');
    expect(trigger('配图模型').getAttribute('aria-expanded')).toBe('true');
    await click(trigger('提示词'));
    expect(trigger('配图模型').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await click(container.querySelector('[role="menuitemradio"]')!);
    expect(trigger('提示词').textContent).toContain('自然叙事');
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('搜索完整身份、选择原始选项后即刻更新并收起；再次展开时清空搜索', async () => {
    await act(async () => root.render(<InteractivePicker />));
    await click(trigger('写作模型'));
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'DEEPSEEK-AI/DeepSeek-V4-Pro');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const items = container.querySelectorAll('[role="menuitemradio"]');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain(models[1].name);
    await click(items[0]);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(trigger('写作模型').querySelector('.lit-model-name')?.textContent).toBe('DeepSeek-V4-Pro');
    await click(trigger('写作模型'));
    expect(container.querySelector('input')?.value).toBe('');
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
  });

  it('没有搜索结果时能清除恢复列表，Esc 收起并还原焦点', async () => {
    await act(async () => root.render(<InteractivePicker />));
    await click(trigger('写作模型'));
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing-model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('未找到匹配模型');
    await click(trigger('清除搜索'));
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger('写作模型'));
  });
});
