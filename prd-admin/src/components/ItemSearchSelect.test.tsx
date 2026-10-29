// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemSearchSelect } from './ItemSearchSelect';
import { Dialog } from './ui/Dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options = Array.from({ length: 120 }, (_, index) => ({ id: String(index), label: `方案 ${index}` }));
let root: Root;
let host: HTMLDivElement;

function Fixture({ modal = true }: { modal?: boolean }) {
  const [value, setValue] = useState('');
  const content = <><ItemSearchSelect value={value} onChange={setValue} options={options} placeholder="搜索已有方案" countUnit="个方案" /><output>{value}</output><button type="button">列表外按钮</button></>;
  return modal ? <Dialog open onOpenChange={() => {}} title="申领内部版本号" content={content} /> : content;
}

async function mount(modal = true) {
  await act(async () => root.render(<Fixture modal={modal} />));
  const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索已有方案"]')!;
  // Dialog 初始聚焦可能已打开列表；先收起，再通过真实输入框重新展开。
  const collapse = document.querySelector<HTMLButtonElement>('button[aria-label="收起列表"]');
  if (collapse) await act(async () => collapse.click());
  await act(async () => input.focus());
  return input;
}

function panel() {
  const footer = [...document.querySelectorAll('span')].find((element) => element.textContent === '共 120 个方案')!;
  return footer.parentElement!.parentElement!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ItemSearchSelect 弹窗滚动兼容', () => {
  it('真实模态内的长列表挂在所属弹窗，上下滚轮不被滚动锁取消', async () => {
    await mount();
    const listPanel = panel();
    expect(listPanel.closest('[role="dialog"]')).toBe(document.querySelector('[role="dialog"]'));
    const list = listPanel.firstElementChild as HTMLDivElement;
    expect(list.style.overflowY).toBe('auto');
    expect(list.style.overscrollBehavior).toBe('contain');
    // jsdom 没有布局/原生滚动，用可滚动尺寸验证真实 Radix 滚轮拦截器的准入。
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 240 },
      scrollHeight: { configurable: true, value: 4800 },
      scrollTop: { configurable: true, value: 600, writable: true },
    });
    for (const deltaY of [100, -100]) {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
      await act(async () => { list.dispatchEvent(wheel); });
      expect(wheel.defaultPrevented).toBe(false);
    }
  });

  it('搜索后仍能选择，选择只收起列表、不关闭申领弹窗', async () => {
    const input = await mount();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '方案 119');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const row = [...document.querySelectorAll('div[title]')].find((element) => element.getAttribute('title') === '方案 119')!;
    expect(document.body.textContent).toContain('1 / 120 个方案匹配');
    await act(async () => (row.parentElement as HTMLElement).click());
    expect(document.querySelector('output')?.textContent).toBe('119');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('个方案匹配');
  });

  it('点击弹窗内列表外区域会收起列表', async () => {
    await mount();
    const outside = [...document.querySelectorAll('button')].find((element) => element.textContent === '列表外按钮')!;
    await act(async () => outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.body.textContent).not.toContain('共 120 个方案');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('普通页面的列表仍挂到 body，不被原控件容器裁切', async () => {
    await mount(false);
    expect(panel().parentElement?.parentElement).toBe(document.body);
    expect(panel().closest('[role="dialog"]')).toBeNull();
  });
});
