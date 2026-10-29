// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVersionPlanName } from './useVersionPlanName';
import { ProductVersionMessagePaste } from './ProductVersionMessagePaste';
import type { VersionRegistrationMessageParseResult } from '@/services/real/productVersionRegistry';

const api = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@/services/real/productAgent', () => ({ parseProductVersionMessage: api.parse }));
let host: HTMLDivElement;
let root: Root | undefined;
let draft: ReturnType<typeof useVersionPlanName>;
function Harness({ paste = false }: { paste?: boolean }) {
  draft = useVersionPlanName();
  return <>
    <input aria-label="方案名称" value={draft.value} onChange={(event) => draft.setManual(event.target.value)} />
    {paste && <ProductVersionMessagePaste kind="formal" getPlanNameEditVersion={draft.getEditVersion}
      onParsed={(result, version) => {
        draft.setSource('匹配立项名称');
        if (result.planName) draft.setPasted(result.planName, version);
      }} />}
  </>;
}
async function mount(paste = false) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root?.render(<Harness paste={paste} />));
}
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.clearAllMocks();
});
describe('T/V共用名称输入优先级', () => {
  it('先用来源兜底，粘贴覆盖来源，后续来源不能覆盖粘贴，手工仍可改', async () => {
    await mount();
    await act(async () => draft.setSource('来源名称'));
    expect(draft.value).toBe('来源名称');
    await act(async () => draft.setPasted('粘贴名称', draft.getEditVersion()));
    await act(async () => draft.setSource('另一个来源'));
    expect(draft.value).toBe('粘贴名称');
    await act(async () => draft.setManual('人工修改'));
    await act(async () => draft.setSource('后台回填'));
    expect(draft.value).toBe('人工修改');
    expect(host.querySelector('input')?.readOnly).toBe(false);
  });
  it('手工编辑或清空后旧粘贴结果不能覆盖，新一次明确粘贴可更新', async () => {
    await mount();
    const previous = draft.getEditVersion();
    await act(async () => draft.setManual(''));
    await act(async () => draft.setPasted('旧响应', previous));
    await act(async () => draft.setSource('来源'));
    expect(draft.value).toBe('');
    await act(async () => draft.setPasted('新通知', draft.getEditVersion()));
    expect(draft.value).toBe('新通知');
  });
  it('真实粘贴组件的延迟响应保留请求开始后的人工编辑', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    api.parse.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount(true);
    const area = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '产品立项方案名称：粘贴名称');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(api.parse).toHaveBeenCalledOnce();
    await act(async () => draft.setManual('请求期间人工编辑'));
    const result = { planName: '粘贴名称', matchedFields: ['planName'] } as VersionRegistrationMessageParseResult;
    await act(async () => finish({ success: true, data: { result } }));
    expect(draft.value).toBe('请求期间人工编辑');
  });
});
