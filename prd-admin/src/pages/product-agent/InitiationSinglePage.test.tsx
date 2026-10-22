// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InitiationWizard } from './VersionWorkflowTab';
import type { ProductInitiation } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listProductVersionReviewSources: vi.fn(), getInitiationPlanDefaults: vi.fn(), parseProductVersionMessage: vi.fn(),
  createInitiation: vi.fn(), updateInitiation: vi.fn(), syncInitiationReview: vi.fn(), decideInitiation: vi.fn(),
  upload: vi.fn(), submit: vi.fn(), stream: vi.fn(),
}));
vi.mock('@/services/real/productAgent', async (original) => ({
  ...await original<typeof import('@/services/real/productAgent')>(),
  ...Object.fromEntries(Object.entries(api).filter(([key]) => !['upload', 'submit', 'stream'].includes(key))),
}));
vi.mock('@/services/real/aiToolbox', () => ({ uploadAttachment: api.upload }));
vi.mock('@/services/real/reviewAgent', () => ({
  createSubmission: api.submit, getDimensions: async () => ({ success: true, data: { dimensions: [] } }),
  getResultStreamUrl: (id: string) => `/stream/${id}`,
  getSubmission: vi.fn(),
}));
vi.mock('@/lib/useSseStream', () => ({
  useSseStream: (options: { onDone: (data: unknown) => void }) => ({
    reset: () => {}, start: async () => { await api.stream(); options.onDone({}); },
    phase: 'idle', phaseMessage: '', typing: '',
  }),
}));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (select: (state: unknown) => unknown) => select({ user: { userId: 'me', displayName: '申请人' }, permissions: ['product-agent.use'], isRoot: false }) }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, description, content, actions }: { title: ReactNode; description: string; content: ReactNode; actions: ReactNode }) => <div role="dialog"><h3>{title}</h3><p>{description}</p>{content}{actions}</div> }));
vi.mock('@/components/ItemSearchSelect', () => ({ ItemSearchSelect: ({ value, onChange, options, placeholder, disabled }: { value: string; onChange: (id: string) => void; options: Array<{ id: string; label: string }>; placeholder: string; disabled?: boolean }) => <select aria-label={placeholder} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> }));
vi.mock('./ProductVersionMessagePaste', () => ({ ProductVersionMessagePaste: () => null }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: ({ value, onChange, placeholder }: { value: string; onChange: (id: string) => void; placeholder: string }) => <select aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option><option value="me">申请人</option><option value="owner">其他负责人</option></select> }));
vi.mock('./VersionCopyActions', () => ({ VersionCopyActions: () => null }));
vi.mock('./InitiationReviewLivePanel', async (original) => ({ ...await original<typeof import('./InitiationReviewLivePanel')>(), InitiationReviewLivePanel: () => <div>正在展示评审进度</div> }));

let root: Root | undefined;
let host: HTMLDivElement;
const onChanged = vi.fn(async () => {});
const seed = (overrides: Partial<ProductInitiation> = {}): ProductInitiation => ({
  id: 'initiation', productId: 'product', linkedProductId: 'product', projectType: 'standard',
  demandSource: '客户', planName: '测试应用（方案）第二稿', versionType: 'minor', requirementIds: [],
  plannedProjectAt: '2026-10-21T00:00:00+08:00', needUiDesign: false, isAiPoc: true, remark: '保留备注',
  reviewMeetingRequired: true, meetingDraftCount: 2, status: 'review_failed', reviewPassed: false,
  reviewScore: 65, reviewSubmissionId: 'old-review', developmentStatus: '待开发', createdBy: 'me',
  sourceType: 'system', createdAt: '2026-10-21', updatedAt: '2026-10-21',
  reviewAttempts: [{ id: 'attempt1', attemptNo: 1, submissionId: 'old-review', planFileName: '第二稿.md', reviewPassed: false, reviewScore: 65, startedAt: '2026-10-21' }],
  ...overrides,
});

async function mount(item?: ProductInitiation) {
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<InitiationWizard productId="product" applicationProducts={[{ id: 'product', name: '测试应用', productNo: 'P1' }]} requirements={[]} members={[]} seed={item} onClose={() => {}} onChanged={onChanged} />); });
}
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label: string): T {
  const wrapper = [...host.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === label);
  const input = wrapper?.querySelector('input,select,textarea');
  if (!input) throw new Error(`未找到字段 ${label}`);
  return input as T;
}
async function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function selectFile() {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['修改后的内容'], '第二稿.md', { type: 'text/markdown' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function confirm() { await act(async () => { host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

beforeEach(() => {
  vi.clearAllMocks();
  api.listProductVersionReviewSources.mockResolvedValue({ success: true, data: { items: [{ id: 'passed', title: '测试应用（已有方案）', fileName: '已有方案.md' }], canUseAllReviews: false } });
  api.getInitiationPlanDefaults.mockResolvedValue({ success: true, data: { meetingDraftCount: 2 } });
  api.parseProductVersionMessage.mockResolvedValue({ success: true, data: { result: { matchedApplicationId: 'product' } } });
  api.upload.mockResolvedValue({ success: true, data: { attachmentId: 'attachment' } });
  api.submit.mockResolvedValue({ success: true, data: { submission: { id: 'new-review' } } });
  api.stream.mockResolvedValue(undefined);
  api.decideInitiation.mockResolvedValue({ success: true, data: seed({ reviewPassed: true, status: 'approved', tCode: 'T1.2.3' }) });
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

describe('内部立项单页来源与失败恢复', () => {
  it('业务负责人默认申请人且可代他人申领，不传审批人', async () => {
    api.createInitiation.mockResolvedValue({ success: true, data: seed({ ownerId: 'owner', ownerName: '其他负责人', reviewPassed: true, status: 'decision_pending' }) });
    await mount();
    expect(field<HTMLSelectElement>('产品负责人 *').value).toBe('me');
    await change(field('产品负责人 *'), 'owner');
    await change(host.querySelector<HTMLSelectElement>('[aria-label="搜索方案名称或文件名"]')!, 'passed');
    await change(field('需求来源 *'), '客户');
    await change(field('计划立项时间 *'), '2026-10-22');
    await confirm();
    expect(api.createInitiation).toHaveBeenCalledWith('product', expect.objectContaining({ ownerId: 'owner' }));
    expect(api.decideInitiation.mock.calls[0][1]).not.toHaveProperty('primaryOwnerId');
    expect(host.textContent).toContain('T1.2.3');
  });

  it('已发号改负责人只保存资料，导入未改选保留原姓名', async () => {
    const issued = seed({ tCode: 'T1.2.3', status: 'approved', sourceType: 'import', ownerName: '历史负责人' });
    api.updateInitiation.mockResolvedValue({ success: true, data: issued });
    await mount(issued);
    await confirm();
    expect(api.updateInitiation.mock.calls[0][1].ownerId).toBeUndefined();
    await change(field('产品负责人 *'), 'owner');
    await confirm();
    expect(api.updateInitiation.mock.calls[1][1].ownerId).toBe('owner');
    expect(api.decideInitiation).not.toHaveBeenCalled();
    expect(api.createInitiation).not.toHaveBeenCalled();
  });
  it.each(['REVIEW_ALREADY_REGISTERED', 'REVIEW_NOT_PASSED', 'REVIEW_NOT_READY'])('确认被 %s 拒绝弹窗说明且保留输入，不触发后续流程', async (code) => {
    api.createInitiation.mockResolvedValue({ success: false, error: { code, message: '服务端拒绝原因' } });
    await mount();
    await change(host.querySelector<HTMLSelectElement>('[aria-label="搜索方案名称或文件名"]')!, 'passed');
    await change(field('需求来源 *'), '保留需求');
    await change(field('计划立项时间 *'), '2026-10-21');
    await change(field('是否需要开评审会'), 'yes');
    await confirm();
    expect(host.querySelectorAll('[role=dialog]')).toHaveLength(2);
    expect(host.textContent).toContain('服务端拒绝原因');
    expect(field<HTMLInputElement>('需求来源 *').value).toBe('保留需求');
    expect(field<HTMLInputElement>('计划立项时间 *').value).toBe('2026-10-21');
    expect(api.decideInitiation).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === '返回修改')?.click());
    expect(host.querySelectorAll('[role=dialog]')).toHaveLength(1);
    expect(field<HTMLInputElement>('需求来源 *').value).toBe('保留需求');
  });

  it('无需选择审批人，不开会也直接自动发号', async () => {
    api.createInitiation.mockResolvedValue({ success: true, data: seed({ reviewPassed: true, status: 'decision_pending' }) });
    await mount();
    await change(host.querySelector<HTMLSelectElement>('[aria-label="搜索方案名称或文件名"]')!, 'passed');
    await change(field('需求来源 *'), '客户');
    await change(field('计划立项时间 *'), '2026-10-21');
    expect(host.querySelector('[aria-label="搜索并选择产品主负责人"]')).toBeNull();
    await confirm();
    expect(api.decideInitiation).toHaveBeenCalledWith('initiation', expect.objectContaining({ reviewMeetingRequired: false }));
    expect(api.decideInitiation.mock.calls[0][1]).not.toHaveProperty('primaryOwnerId');
    expect(host.textContent).toContain('T1.2.3');
  });

  it('已发号记录修改只保存资料，不上传、不评审、不重新发号', async () => {
    const issued = seed({ tCode: 'T1.2.3', status: 'approved', reviewPassed: true });
    api.updateInitiation.mockResolvedValue({ success: true, data: issued });
    await mount(issued);
    await change(field('备注（选填）'), '修改备注');
    await confirm();
    expect(api.updateInitiation).toHaveBeenCalledWith('initiation', expect.objectContaining({ remark: '修改备注' }));
    expect(api.createInitiation).not.toHaveBeenCalled();
    expect(api.decideInitiation).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain('原 T 号、评审及下游关联保持不变');
  });
  it('两种来源显式分开，切换上传立即出现文件控件，不出现下一步', async () => {
    await mount();
    expect(host.textContent).toContain('确认时校验评审和申领状态');
    expect(host.querySelector('input[type=file]')).toBeNull();
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(host.querySelector('input[type=file]')).not.toBeNull();
    expect(host.textContent).toContain('无需进入下一页');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === '下一步')).toBe(false);
  });

  it('已有方案确认后直接决策，不上传、不新建评审任务', async () => {
    api.createInitiation.mockResolvedValue({ success: true, data: seed({ reviewPassed: true, reviewSubmissionId: 'passed', status: 'decision_pending' }) });
    await mount();
    await change(host.querySelector<HTMLSelectElement>('[aria-label="搜索方案名称或文件名"]')!, 'passed');
    await change(field('需求来源 *'), '客户');
    await change(field('计划立项时间 *'), '2026-10-21');
    await change(field('是否需要开评审会'), 'yes');
    await confirm();
    expect(api.createInitiation).toHaveBeenCalledWith('product', expect.objectContaining({ reviewSubmissionId: 'passed', reviewMeetingRequired: true }));
    expect(api.decideInitiation).toHaveBeenCalledTimes(1);
    expect(api.upload).not.toHaveBeenCalled(); expect(api.submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain('T1.2.3');
  });

  it('失败记录恢复所有填写项和上次文件；再失败仍更新原记录且不发号', async () => {
    const previous = seed();
    api.updateInitiation.mockResolvedValue({ success: true, data: previous });
    api.syncInitiationReview.mockResolvedValue({ success: true, data: { ...previous, reviewSubmissionId: 'new-review' } });
    await mount(previous);
    expect(field<HTMLInputElement>('方案名称 *').value).toBe(previous.planName);
    expect(field<HTMLInputElement>('计划立项时间 *').value).toBe('2026-10-21');
    expect(field<HTMLTextAreaElement>('备注（选填）').value).toBe('保留备注');
    expect(field<HTMLSelectElement>('是否需要开评审会').value).toBe('yes');
    expect(host.textContent).toContain('上次方案文件：第二稿.md');
    await selectFile(); await confirm();
    expect(api.updateInitiation).toHaveBeenCalledWith('initiation', expect.objectContaining({ reviewMeetingRequired: true, remark: '保留备注', planFileName: '第二稿.md' }));
    expect(api.createInitiation).not.toHaveBeenCalled(); expect(api.decideInitiation).not.toHaveBeenCalled();
    expect(host.textContent).toContain('未生成 T 号');
    expect(host.textContent).toContain('填写内容及本次评审记录已保存');
  });

  it('新文件评审通过后同一次确认自动决策，会议时间沿用计划日期', async () => {
    const previous = seed();
    api.updateInitiation.mockResolvedValue({ success: true, data: previous });
    api.syncInitiationReview.mockResolvedValueOnce({ success: true, data: previous })
      .mockResolvedValueOnce({ success: true, data: seed({ status: 'decision_pending', reviewPassed: true }) });
    await mount(previous); await selectFile(); await confirm();
    expect(api.decideInitiation).toHaveBeenCalledWith('initiation', expect.objectContaining({ expectedMeetingAt: previous.plannedProjectAt, meetingDraftCount: 2 }));
    expect(host.textContent).toContain('T1.2.3');
  });

  it('连续确认只执行一次；不需要开会自动发号并显示服务端编号', async () => {
    let resolveSave!: (value: unknown) => void;
    const previous = seed({ reviewMeetingRequired: false, primaryOwnerId: 'owner', reviewPassed: true, status: 'decision_pending' });
    api.updateInitiation.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    api.decideInitiation.mockResolvedValue({ success: true, data: { ...previous, status: 'approved', tCode: 'T1.2.3' } });
    await mount(previous);
    await act(async () => {
      const form = host.querySelector('form');
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.updateInitiation).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave({ success: true, data: previous }));
    expect(api.decideInitiation).toHaveBeenCalledWith('initiation', expect.objectContaining({ reviewMeetingRequired: false }));
    expect(api.decideInitiation).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('T1.2.3');
    expect(host.textContent).not.toContain('已提交主负责人审批');
    expect(api.createInitiation).not.toHaveBeenCalled();
  });

  it('服务端尚未返回编号时不把待发号误报为完成', async () => {
    const previous = seed({ reviewMeetingRequired: false, reviewPassed: true, status: 'decision_pending' });
    api.updateInitiation.mockResolvedValue({ success: true, data: previous });
    api.decideInitiation.mockResolvedValue({ success: true, data: { ...previous, status: 'owner_pending', tCode: null } });
    await mount(previous); await confirm();
    expect(host.textContent).toContain('尚未取得 T 立项号');
    expect(host.textContent).not.toContain('内部版本号已生成');
    expect(host.querySelector('form')).not.toBeNull();
  });
});
