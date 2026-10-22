// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserSearchSelect } from './UserSearchSelect';
import { Dialog } from './ui/Dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const directory = vi.hoisted(() => vi.fn());
vi.mock('@/services', () => ({ searchDirectoryUsers: directory }));

const people = [
  { userId: 'owner-a', username: 'owner.a', displayName: '测试负责人甲' },
  { userId: 'owner-b', username: 'owner.b', displayName: '测试负责人乙' },
];
const selected = vi.fn();
const snapshot = vi.fn();
let root: Root;
let host: HTMLDivElement;

function Fixture({ modal, inlineOptions = false }: { modal: boolean; inlineOptions?: boolean }) {
  const [value, setValue] = useState('');
  const content = <>
    <label>产品负责人<UserSearchSelect value={value} onChange={(id) => { setValue(id); selected(id); }} onSelectUser={snapshot} placeholder="搜索并选择产品主负责人" inlineOptions={inlineOptions} /></label>
    <output>{value}</output><button type="button">列表外按钮</button>
  </>;
  return modal ? <Dialog open onOpenChange={() => {}} title="申领内部版本号" content={content} /> : content;
}

async function settle(ms = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mount(modal = true, inlineOptions = false) {
  await act(async () => root.render(<Fixture modal={modal} inlineOptions={inlineOptions} />));
  const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索并选择产品主负责人"]')!;
  await act(async () => input.focus());
  await settle();
  return input;
}

function row(name = people[1].displayName) {
  const label = [...document.querySelectorAll('span')].find((element) => element.textContent === name);
  if (!label) throw new Error(`未找到候选 ${name}`);
  return label.closest<HTMLDivElement>('div.cursor-pointer')!;
}

function list() {
  return row().parentElement!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  directory.mockImplementation(async (query: string) => ({
    success: true, data: { items: people.filter((person) => !query || person.displayName.includes(query) || person.username.includes(query)) },
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-theme');
});

describe('UserSearchSelect 真实模态交互', () => {
  it.each(['dark', 'light'])('%s 产品负责人就地候选在输入框之后，不创建悬浮portal，搜索后仍可单选', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const input = await mount(true, true);
    const trigger = input.parentElement!;
    const menu = trigger.nextElementSibling as HTMLElement;
    expect(menu.contains(row())).toBe(true);
    expect(menu.style.position).toBe('static');
    expect(menu.style.maxHeight).toBe('256px');
    expect(menu.style.width).toBe('100%');
    expect(list().style.overflowY).toBe('auto');
    expect(list().style.overscrollBehavior).toBe('contain');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '负责人乙');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.dispatchEvent(new Event('resize'));
      trigger.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await settle(240);
    expect(input.parentElement!.nextElementSibling).toBe(menu);
    expect(menu.style.top).toBe('');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { row().dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    await click(row());
    expect(input.value).toBe(people[1].displayName);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith('owner-b');
    expect(trigger.nextElementSibling).toBeNull();
  });

  it('就地候选ESC仅收起名单；点外关闭及清除后重新选择不改业务回调', async () => {
    const input = await mount(true, true);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.body.textContent).not.toContain('共 2 人');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { input.blur(); input.focus(); });
    await settle();
    await click(row());
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="清除"]')!);
    expect(input.value).toBe('');
    await click(input);
    await settle();
    await click([...document.querySelectorAll('button')].find((button) => button.textContent === '列表外按钮')!);
    expect(document.body.textContent).not.toContain('共 2 人');
    expect(selected.mock.calls.map(([id]) => id)).toEqual(['owner-b', '']);
  });

  it.each(['dark', 'light'])('%s 主题真实Dialog内搜索并点击候选，只关闭下拉并回填姓名', async (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    const input = await mount();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '负责人乙');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(240);
    expect(directory).toHaveBeenLastCalledWith('负责人乙', 50);
    const candidate = row();
    // 原body portal在jsdom中也能触发合成click；必须先断言它属于被Radix允许交互的dialog。
    expect(candidate.closest('[role="dialog"]')).toBe(document.querySelector('[role="dialog"]'));
    expect(document.body.style.pointerEvents).toBe('none');
    await click(candidate);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith('owner-b');
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining(people[1]));
    expect(document.querySelector('output')?.textContent).toBe('owner-b');
    expect(input.value).toBe(people[1].displayName);
    expect(input.title).toContain(people[1].displayName);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('人匹配');
  });

  it('选中后可清除、重新搜索并选择另一人', async () => {
    const input = await mount();
    await click(row());
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="清除"]')!);
    expect(input.value).toBe('');
    expect(document.querySelector('output')?.textContent).toBe('');
    await act(async () => { input.blur(); input.focus(); });
    await settle();
    await click(row(people[0].displayName));
    expect(input.value).toBe(people[0].displayName);
    expect(selected.mock.calls.map(([id]) => id)).toEqual(['owner-b', '', 'owner-a']);
  });

  it('候选列表上下滚动不被真实Radix滚动锁拦截', async () => {
    await mount();
    const scrollable = list();
    expect(scrollable.style.overflowY).toBe('auto');
    expect(scrollable.style.overscrollBehavior).toBe('contain');
    Object.defineProperties(scrollable, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 200, writable: true },
    });
    for (const deltaY of [100, -100]) {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
      await act(async () => { scrollable.dispatchEvent(wheel); });
      expect(wheel.defaultPrevented).toBe(false);
    }
  });

  it('点击弹窗内列表外区域只收起候选', async () => {
    await mount();
    const outside = [...document.querySelectorAll('button')].find((button) => button.textContent === '列表外按钮')!;
    await click(outside);
    expect(document.body.textContent).not.toContain('共 2 人');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });

  it('非弹窗人员筛选仍使用body portal并可选择', async () => {
    const input = await mount(false);
    expect(row().closest('[role="dialog"]')).toBeNull();
    expect(host.contains(row())).toBe(false);
    await click(row());
    expect(input.value).toBe(people[1].displayName);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith('owner-b');
  });
});
