// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog';
import type { ProductEntityType, WorkflowTransition } from './types';
import type { WorkflowTransitionEntitySnapshot } from './workflowTransitionGuard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ listVersions: vi.fn(), listInitiations: vi.fn(), listReleases: vi.fn(), transition: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('./ProductAssigneePicker', () => ({ ProductAssigneePicker: () => null }));

let root: Root;
let host: HTMLDivElement;
const done = vi.fn();

async function renderDialog(toState: string, entity: WorkflowTransitionEntitySnapshot = {}, entityType: ProductEntityType = 'requirement', requiredFieldKeys: string[] = []) {
  const transition: WorkflowTransition = { key: 'advance', label: '推进', toState, requireComment: false, requiredFieldKeys };
  await act(async () => {
    root.render(<WorkflowTransitionDialog open productId="p1" workflow={null} entityType={entityType}
      entityId="r1" transition={transition} entity={entity} onClose={vi.fn()} onDone={done} />);
  });
}

async function selectOption(value: string) {
  const select = Array.from(document.body.querySelectorAll('select')).find(el => Array.from(el.options).some(option => option.value === value));
  expect(select).toBeDefined();
  await act(async () => { select!.value = value; select!.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.body.contains(select!)).toBe(true);
}

async function submit() {
  const button = Array.from(document.body.querySelectorAll('button')).find(el => el.textContent?.trim() === '确认流转');
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listVersions.mockResolvedValue({ success: true, data: { items: [{ id: 'v1', versionName: '规划版本' }] } });
  api.listInitiations.mockResolvedValue({ success: true, data: { items: [{ id: 't1', status: 'approved', tCode: 'T1.0.0', planName: '方案', requirementIds: [] }] } });
  api.listReleases.mockResolvedValue({ success: true, data: { items: [{ id: 'release1', status: 'released', vCode: 'V1.0.0', planName: '上线', requirementIds: [] }] } });
  api.transition.mockResolvedValue({ success: true, data: { entityId: 'r1', newState: 'done' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('流转弹窗保留已填写的业务依据', () => {
  it.each([['status_2', 't1', 'initiationId'], ['resolved', 'release1', 'releaseId']])('选择 %s 的关联后仍显示并提交', async (state, id, field) => {
    await renderDialog(state);
    await selectOption(id);
    await submit();
    expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({ [field]: id }));
    expect(done).toHaveBeenCalledOnce();
  });

  it('选择归属版本后保留复选框并提交版本', async () => {
    await renderDialog('status_3');
    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(document.body.contains(checkbox)).toBe(true);
    expect(checkbox.checked).toBe(true);
    await submit();
    expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({ versionIds: ['v1'] }));
  });

  it('补齐标题后保留输入并发送标题', async () => {
    await renderDialog('developing', { title: '' }, 'requirement', ['title']);
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="填写标题"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '补全的需求标题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.contains(input)).toBe(true);
    await submit();
    expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({ title: '补全的需求标题' }));
  });

  it('没有业务依据时阻止发送并显示缺失项', async () => {
    await renderDialog('status_2');
    await submit();
    expect(api.transition).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请填写：立项单');
  });

  it('功能流转不错误要求需求专用的上线记录', async () => {
    await renderDialog('resolved', {}, 'feature');
    await submit();
    expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'feature' }));
    expect(document.body.textContent).not.toContain('请填写：上线单');
  });
});
