// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitiationWizard } from './VersionWorkflowTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@/services/real/productAgent', async (original) => ({
  ...await original<typeof import('@/services/real/productAgent')>(),
  parseProductVersionMessage: api.parse,
  listProductVersionReviewSources: async () => ({ success: true, data: { items: [{ id: 'review', title: '品牌商后台基础T（扫码风控优化二期）', fileName: '方案.md' }], canUseAllReviews: false } }),
  getInitiationPlanDefaults: async () => ({ success: true, data: { meetingDraftCount: 1 } }),
}));
vi.mock('@/services/real/reviewAgent', () => ({ createSubmission: vi.fn(), getSubmission: vi.fn(), getResultStreamUrl: (id: string) => `/stream/${id}`, getDimensions: async () => ({ success: true, data: { dimensions: [] } }) }));
vi.mock('@/lib/useSseStream', () => ({ useSseStream: () => ({ reset: () => {}, phase: 'idle', phaseMessage: '', typing: '' }) }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me' }, permissions: ['product-agent.use'], isRoot: false }) }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content, actions }: { content: ReactNode; actions: ReactNode }) => <div role="dialog">{content}{actions}</div> }));
vi.mock('@/components/ItemSearchSelect', () => ({ ItemSearchSelect: ({ value, onChange, options, placeholder }: { value: string; onChange: (id: string) => void; options: Array<{ id: string; label: string }>; placeholder: string }) => <select aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: () => <span>申请人</span> }));

const notice = '【版本立项】\n项目类别：非定制\n版本类别：小版本\n是否需要UI设计：否\n是否属于AI\u00a0POC项目：是\n需求来源：文君\n产品立项方案名称：品牌商后台基础T（扫码风控优化二期）\n计划立项时间：2026.10.28\n';
const brand = { id: 'brand-app', name: '品牌商后台基础', productNo: 'P1' };
const other = { id: 'other', name: '互动营销', productNo: 'P2' };
let host: HTMLDivElement;
let root: Root;
function result(applicationId: string | null = 'brand-app', planName = '品牌商后台基础（扫码风控优化二期）') {
  return { success: true, data: { result: { matchedFields: ['planName', 'projectType', 'versionType', 'needUiDesign', 'isAiPoc', 'demandSource', 'plannedProjectAt'], matchedApplicationId: applicationId, planName, projectType: 'standard', versionType: 'minor', needUiDesign: false, isAiPoc: true, demandSource: '文君', plannedProjectAt: '2026-10-28T00:00:00' } } };
}
async function render(products: Array<typeof brand>) {
  await act(async () => root.render(<InitiationWizard productId="" applicationProducts={products} requirements={[]} members={[]} onClose={() => {}} onChanged={async () => {}} />));
}
const application = () => host.querySelector<HTMLSelectElement>('[aria-label="搜索应用名称或编号"]')!;
async function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function paste(text = notice) {
  await change(host.querySelector<HTMLTextAreaElement>('#version-message-internal')!, text);
  await act(async () => vi.advanceTimersByTimeAsync(650));
}
beforeEach(() => {
  vi.useFakeTimers(); api.parse.mockReset(); api.parse.mockResolvedValue(result());
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('通知识别应用与目录先后到达', () => {
  it('目录后到仍回填扫码风控原文的所属应用', async () => {
    await render([]); await paste();
    expect(api.parse).toHaveBeenCalledWith('internal', notice);
    expect(application().value).toBe('');
    await render([brand, other]);
    expect(application().value).toBe('brand-app');
    expect([...application().options].find((option) => option.selected)?.textContent).toBe('品牌商后台基础');
  });
  it('目录先到也正常回填，方案名不依赖完整T号', async () => {
    await render([brand, other]); await paste();
    expect(application().value).toBe('brand-app');
    expect(host.querySelector<HTMLInputElement>('input[placeholder="例如：内部、客户名称"]')?.value).toBe('文君');
  });
  it('等待目录时用户手动改选，目录完成不得覆盖人工选择', async () => {
    await render([other]); await paste(); await change(application(), 'other');
    await render([brand, other]);
    expect(application().value).toBe('other');
  });
  it('切换方案来源后不得应用上一条通知的待回填结果', async () => {
    await render([other]); await paste();
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    await render([brand, other]);
    expect(application().value).toBe('');
  });
  it('人工修改方案名称会取消旧匹配，目录到达不覆盖手工内容', async () => {
    await render([other]); await paste();
    const label = [...host.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === '方案名称 *')!;
    await change(label.querySelector<HTMLInputElement>('input')!, '人工修改后的方案');
    await render([brand, other]);
    expect(label.querySelector<HTMLInputElement>('input')!.value).toBe('人工修改后的方案');
    expect(application().value).toBe('');
  });
  it('下一条通知未匹配时不沿用上一条的待回填应用', async () => {
    await render([other]); await paste();
    api.parse.mockResolvedValue(result(null, '未知应用（新方案）'));
    await paste(notice.replace('品牌商后台基础T（扫码风控优化二期）', '未知应用（新方案）'));
    await render([brand, other]);
    expect(application().value).toBe('');
  });
  it('不自动选择当前目录外的应用', async () => {
    await render([other]); await paste(); await render([other]);
    expect(application().value).toBe('');
    expect([...application().options].some((option) => option.value === 'brand-app')).toBe(false);
  });
  it('评审来源识别先完成也等待目录再回填同一应用', async () => {
    await render([]);
    await change(host.querySelector<HTMLSelectElement>('[aria-label="搜索方案名称或文件名"]')!, 'review');
    await render([brand, other]);
    expect(application().value).toBe('brand-app');
  });
});
