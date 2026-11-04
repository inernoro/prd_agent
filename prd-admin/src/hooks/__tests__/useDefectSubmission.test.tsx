// @vitest-environment jsdom
import { act, type ReactNode, type MouseEventHandler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, fail } from '@/types/api';
import type { DefectAttachment, DefectReport } from '@/services/contracts/defectAgent';
import { useDefectSubmission } from '../useDefectSubmission';
import { DefectSubmitPanel } from '@/pages/defect-agent/components/DefectSubmitPanel';
import { useDefectStore } from '@/stores/defectStore';
import { GlobalDefectSubmitDialog } from '@/components/ui/GlobalDefectSubmitDialog';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';

const calls = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), upload: vi.fn(), remove: vi.fn(), submit: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), warning: vi.fn() }));
vi.mock('@/services', () => ({
  createDefect: calls.create, updateDefect: calls.update, addDefectAttachment: calls.upload, deleteDefectAttachment: calls.remove, submitDefect: calls.submit,
  analyzeDefectImage: vi.fn(),
  listDefectTemplates: vi.fn(async () => ({ success: true, data: { items: [] } })),
  getDefectUsers: vi.fn(async () => ({ success: true, data: { items: [] } })),
  previewApiLogs: vi.fn(async () => ({ success: true, data: { totalCount: 0, errorCount: 0, items: [] } })),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: calls.success, error: calls.error, dismiss: calls.dismiss, warning: calls.warning } }));
vi.mock('@/components/design/GlassCard', () => ({ GlassCard: ({ children, onClick }: { children: ReactNode; onClick?: MouseEventHandler<HTMLDivElement> }) => <div onClick={onClick}>{children}</div> }));
vi.mock('@/components/ui/SuccessConfettiButton', () => ({ SuccessConfettiButton: ({ onAction, readyText, disabled }: { onAction: () => Promise<unknown>; readyText: string; disabled?: boolean }) => <button data-tour-id="defect-submit-global" disabled={disabled} onClick={() => { void onAction(); }}>{readyText}</button> }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="提交给" value={value} onChange={event => onChange(event.target.value)} /> }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/useAiPreviewStream', () => ({ useAiPreviewStream: () => ({ open: false }) }));

describe('缺陷提交的失败恢复与传输幂等身份', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useDefectSubmission>;
  const onCreated = vi.fn();
  const onSubmitted = vi.fn();
  const onRecovered = vi.fn();
  let draft: DefectReport;
  const input = { content: '原始问题描述', title: '原始问题', assigneeUserId: 'self', severity: 'minor' };

  function Harness() {
    current = useDefectSubmission({ onCreated, onSubmitted, onRecovered });
    return null;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    calls.error.mockReturnValue('own-failure-toast');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    draft = { id: 'draft-1', defectNo: '101', status: 'draft', rawContent: input.content, attachments: [] } as unknown as DefectReport;
    calls.create.mockImplementation(async () => ok({ defect: draft }));
    calls.update.mockImplementation(async () => ok({ defect: draft }));
    calls.upload.mockResolvedValue(ok({ attachment: { id: 'attachment-1' } }));
    calls.remove.mockResolvedValue(ok({ deleted: true }));
    calls.submit.mockImplementation(async () => ok({ defect: { ...draft, status: 'submitted' } }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    sessionStorage.removeItem('defect-agent-last-assignee');
    useGlobalDefectStore.setState({ showDialog: false, prefill: null, onCreated: null });
  });

  async function openEntry(entry: 'global' | 'panel') {
    vi.useFakeTimers();
    sessionStorage.setItem('defect-agent-last-assignee', 'self');
    if (entry === 'global') {
      useGlobalDefectStore.getState().openDialog({ onCreated });
      await act(async () => root.render(<GlobalDefectSubmitDialog />));
    } else {
      useDefectStore.setState({ defects: [], templates: [], users: [], projects: [], showSubmitPanel: true });
      function PageHost() {
        return useDefectStore(state => state.showSubmitPanel) ? <DefectSubmitPanel /> : null;
      }
      await act(async () => root.render(<PageHost />));
    }
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="问题描述"]')!;
    await act(async () => Simulate.change(textarea, { target: { value: input.content } } as never));
    return {
      isOpen: () => entry === 'global' ? useGlobalDefectStore.getState().showDialog : useDefectStore.getState().showSubmitPanel,
      submit: () => document.querySelector<HTMLButtonElement>(`[data-tour-id="${entry === 'global' ? 'defect-submit-global' : 'defect-submit'}"]`)!,
      close: () => document.querySelector<HTMLButtonElement>('[aria-label="关闭提交缺陷"]')!,
      backdrop: () => document.querySelector<HTMLElement>('[role="dialog"]')!,
    };
  }

  it('结果待确认时reset不能丢弃同一提交身份', async () => {
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '提交响应丢失');
    });
    await act(async () => { await current.submit(input, []); });
    await act(async () => current.reset());
    expect(current.confirmationPending).toBe(true);
    expect(current.savedDefect?.id).toBe('draft-1');
    await act(async () => { expect(await current.submit(input, [])).toBe(true); });
    expect(calls.create.mock.calls[1][0].clientRequestId).toBe(calls.create.mock.calls[0][0].clientRequestId);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('待确认重试暂读到草稿且保存失败，仍保留未知结果与身份直到核实', async () => {
    calls.submit.mockResolvedValueOnce(fail('NETWORK_ERROR', '最终提交响应丢失'));
    await act(async () => { await current.submit(input, []); });
    calls.update.mockResolvedValueOnce(fail('VERSION_CONFLICT', '保存冲突'));
    await act(async () => { await current.submit(input, []); });
    expect(current.confirmationPending).toBe(true);
    await act(async () => { expect(current.reset()).toBe(false); });
    // 先前请求在暂读draft之后完成；不能因这次失败而改用新身份创建另一单。
    draft = { ...draft, status: 'submitted' };
    await act(async () => { expect(await current.submit(input, [])).toBe(true); });
    expect(new Set(calls.create.mock.calls.map(([request]) => request.clientRequestId)).size).toBe(1);
    expect(calls.submit.mock.calls.map(([request]) => request.id)).toEqual(['draft-1', 'draft-1']);
  });

  it.each(['content', 'assignee'] as const)('待确认回查仍为草稿且%s无效时，只核对原身份、不写入无效编辑', async field => {
    calls.submit.mockResolvedValueOnce(fail('NETWORK_ERROR', '最终提交响应丢失'));
    await act(async () => { await current.submit(input, []); });
    const edited = { ...input, ...(field === 'content' ? { content: '' } : { assigneeUserId: '' }) };
    await act(async () => { expect(await current.submit(edited, [])).toBe(false); });
    expect(current.confirmationPending).toBe(true);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.upload).not.toHaveBeenCalled();
    expect(calls.submit).toHaveBeenCalledTimes(1);
    await act(async () => { expect(current.reset()).toBe(false); });
    draft = { ...draft, status: 'submitted' };
    await act(async () => { expect(await current.submit(edited, [])).toBe(false); });
    expect(current.unappliedChanges).toBe(true);
    expect(current.confirmationPending).toBe(false);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(new Set(calls.create.mock.calls.map(([request]) => request.clientRequestId)).size).toBe(1);
  });

  it.each([['global', 'content'], ['panel', 'content'], ['global', 'assignee'], ['panel', 'assignee']] as const)('%s待确认后清空%s仍可核实原单，并保留当前未保存编辑', async (entry, field) => {
    const ui = await openEntry(entry);
    const selector = field === 'content' ? '[aria-label="问题描述"]' : '[aria-label="提交给"]';
    const edit = async (value: string) => act(async () => Simulate.change(document.querySelector(selector)!, { target: { value } } as never));
    await edit('');
    if (field === 'content') expect(ui.submit().disabled).toBe(true);
    else await act(async () => ui.submit().click());
    expect(calls.create).not.toHaveBeenCalled();
    await edit(field === 'content' ? input.content : 'self');
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '提交响应丢失');
    });
    await act(async () => ui.submit().click());
    await edit('');
    expect(ui.submit().disabled).toBe(false);
    await act(async () => ui.submit().click());
    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(calls.create.mock.calls[1][0].clientRequestId).toBe(calls.create.mock.calls[0][0].clientRequestId);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(calls.success).not.toHaveBeenCalled();
    expect(document.querySelector(selector)?.getAttribute('value') ?? (document.querySelector(selector) as HTMLTextAreaElement).value).toBe('');
    expect(ui.isOpen()).toBe(true);
    expect(ui.close().disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('当前修改尚未保存');
    await act(async () => ui.close().click());
    expect(ui.isOpen()).toBe(false);
  });

  it.each(['global', 'panel'] as const)('%s待确认时关闭按钮、遮罩及快捷键不丢会话，重试确认后正常关闭', async entry => {
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '提交响应丢失');
    });
    const ui = await openEntry(entry);
    await act(async () => ui.submit().click());
    expect(ui.close().disabled).toBe(true);
    await act(async () => { ui.close().click(); Simulate.click(ui.backdrop()); });
    if (entry === 'global') {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
      });
    }
    expect(ui.isOpen()).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="问题描述"]')?.value).toBe(input.content);
    await act(async () => { ui.submit().click(); await vi.advanceTimersByTimeAsync(1600); });
    expect(ui.isOpen()).toBe(false);
    expect(calls.create.mock.calls[1][0].clientRequestId).toBe(calls.create.mock.calls[0][0].clientRequestId);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.submit.mock.calls.map(([request]) => request.id)).toEqual(['draft-1', 'draft-1']);
    expect(calls.success).toHaveBeenCalledTimes(1);
  });

  it.each(['global', 'panel'] as const)('%s同帧提交与关闭不会卸载进行中的会话，提交前失败后仍可关闭', async entry => {
    let failSave!: (value: ReturnType<typeof fail>) => void;
    calls.create.mockReturnValueOnce(new Promise(resolve => { failSave = resolve; }));
    const ui = await openEntry(entry);
    await act(async () => { ui.submit().click(); Simulate.click(ui.backdrop()); });
    expect(ui.isOpen()).toBe(true);
    await act(async () => failSave(fail('NETWORK_ERROR', '保存失败')));
    expect(ui.close().disabled).toBe(false);
    await act(async () => ui.close().click());
    expect(ui.isOpen()).toBe(false);
    expect(calls.submit).not.toHaveBeenCalled();
  });

  it('全局确认成功后先关闭再重开，旧关闭定时器不能清除新草稿', async () => {
    const ui = await openEntry('global');
    await act(async () => ui.submit().click());
    await act(async () => ui.close().click());
    await act(async () => useGlobalDefectStore.getState().openDialog());
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="问题描述"]')!;
    await act(async () => Simulate.change(textarea, { target: { value: '新草稿内容' } } as never));
    await act(async () => vi.advanceTimersByTimeAsync(1600));
    expect(ui.isOpen()).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="问题描述"]')?.value).toBe('新草稿内容');
  });

  it('附件业务失败立即停止，不调用最终提交；重试复用草稿和附件身份', async () => {
    const file = new File(['evidence'], 'evidence.txt', { type: 'text/plain' });
    calls.upload.mockResolvedValueOnce(fail('UPLOAD_TIMEOUT', '上传超时'));
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    expect(current.confirmationPending).toBe(false);
    expect(calls.submit).not.toHaveBeenCalled();
    expect(calls.success).not.toHaveBeenCalled();
    expect(current.savedDefect?.id).toBe('draft-1');
    expect(current.error).toContain('重新上传');

    const edited = { ...input, content: '重试前补充的描述', severity: 'major' };
    await act(async () => { expect(await current.submit(edited, [{ file }])).toBe(true); });
    expect(calls.create.mock.calls[0][0]).toEqual(calls.create.mock.calls[1][0]);
    expect(calls.update.mock.calls[1][0]).toMatchObject({ id: 'draft-1', ...edited });
    expect(calls.upload.mock.calls[0][0].clientRequestId).toBe(calls.upload.mock.calls[1][0].clientRequestId);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(calls.dismiss).toHaveBeenCalledWith('own-failure-toast');
  });

  it('创建结果丢失时重放首次内容与身份，再保存当前编辑内容', async () => {
    calls.create.mockRejectedValueOnce(new Error('Failed to fetch'));
    await act(async () => { expect(await current.submit(input, [])).toBe(false); });
    expect(calls.update).not.toHaveBeenCalled();
    expect(calls.submit).not.toHaveBeenCalled();
    const edited = { ...input, content: '当前编辑内容' };
    await act(async () => { expect(await current.submit(edited, [])).toBe(true); });
    expect(calls.create.mock.calls[0][0]).toEqual(calls.create.mock.calls[1][0]);
    expect(calls.update).toHaveBeenCalledWith({ ...edited, id: 'draft-1', templateId: '', projectId: '', teamId: '' });
  });

  it.each(['throw', 'response'] as const)('提交响应丢失（%s）后按服务器状态恢复，不再修改草稿或重复上传', async (mode) => {
    const file = new File(['a'], 'a.txt');
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      if (mode === 'response') return fail('NETWORK_ERROR', '网络连接异常，请检查网络后重试。');
      throw new Error('Failed to fetch');
    });
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    expect(current.confirmationPending).toBe(true);
    expect(calls.error).toHaveBeenLastCalledWith('提交结果待确认', expect.any(String));
    calls.create.mockRejectedValueOnce(new Error('Failed to fetch'));
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    expect(current.confirmationPending).toBe(true);
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(true); });
    expect(current.confirmationPending).toBe(false);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.upload).toHaveBeenCalledTimes(1);
    expect(calls.submit).toHaveBeenCalledTimes(2);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'metadata', 'add-file', 'remove-file'] as const)('已提交恢复时保留未应用的当前修改（%s），不误报成功或关闭', async (change) => {
    const file = new File(['old'], 'original.txt');
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '连接中断');
    });
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    const edited = { ...input, ...(change === 'content' ? { content: '重试前新增的复现步骤' } : {}),
      ...(change === 'metadata' ? { assigneeUserId: 'new-assignee', severity: 'major', projectId: 'new-project' } : {}) };
    const attachments = change === 'remove-file' ? [] : [{ file }, ...(change === 'add-file' ? [{ file: new File(['new'], 'new.txt') }] : [])];
    await act(async () => { expect(await current.submit(edited, attachments)).toBe(false); });
    expect(current.unappliedChanges).toBe(true);
    expect(current.confirmationPending).toBe(false);
    expect(current.savedDefect?.status).toBe('submitted');
    expect(current.error).toContain('当前修改尚未保存');
    expect(calls.success).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1', status: 'submitted' }));
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.upload).toHaveBeenCalledTimes(1);
    expect(calls.submit).toHaveBeenCalledTimes(1);
    expect(edited.content).toBe(change === 'content' ? '重试前新增的复现步骤' : input.content);
    expect(attachments).toHaveLength(change === 'add-file' ? 2 : change === 'remove-file' ? 0 : 1);
  });

  it('待确认但服务端仍是草稿时，允许修正确定性拒绝后继续提交', async () => {
    calls.submit.mockResolvedValueOnce(fail('INVALID_FORMAT', '请补充复现步骤'));
    await act(async () => { expect(await current.submit(input, [])).toBe(false); });
    const edited = { ...input, content: '已补充复现步骤' };
    await act(async () => { expect(await current.submit(edited, [])).toBe(true); });
    expect(current.unappliedChanges).toBe(false);
    expect(calls.update).toHaveBeenLastCalledWith(expect.objectContaining(edited));
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('保护未保存修改后，只有明确开始新提交才生成新身份，原缓冲仍可继续使用', async () => {
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '连接中断');
    });
    await act(async () => { await current.submit(input, []); });
    const edited = { ...input, content: '待另存的当前编辑' };
    const attachments = [{ file: new File(['new'], 'retained.txt') }];
    await act(async () => { expect(await current.submit(edited, attachments)).toBe(false); });
    const identity = calls.create.mock.calls[0][0].clientRequestId;
    await act(async () => current.reset());
    draft = { ...draft, id: 'new-draft', status: 'draft' };
    await act(async () => { expect(await current.submit(edited, attachments)).toBe(true); });
    expect(current.unappliedChanges).toBe(false);
    expect(calls.create.mock.calls[2][0].clientRequestId).not.toBe(identity);
    expect(calls.update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'new-draft', content: edited.content }));
    expect(calls.upload).toHaveBeenLastCalledWith(expect.objectContaining({ file: attachments[0].file }));
  });

  it('相同内容的字段顺序、空可选字段和首尾空白不造成未保存修改误报', async () => {
    const file = new File(['same'], 'same.txt');
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '连接中断');
    });
    await act(async () => { await current.submit(input, [{ file, description: '  证据说明  ' }]); });
    const reordered = { severity: input.severity, assigneeUserId: input.assigneeUserId, content: ` ${input.content} `,
      title: input.title, templateId: '', projectId: '', teamId: '' };
    await act(async () => { expect(await current.submit(reordered, [{ file, description: '证据说明' }])).toBe(true); });
    expect(current.unappliedChanges).toBe(false);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('实际页面回调和Store在一次成功提交后只保留唯一ID及最终状态', async () => {
    sessionStorage.setItem('defect-agent-last-assignee', 'self');
    useDefectStore.setState({ defects: [], templates: [], users: [], projects: [], showSubmitPanel: true });
    await act(async () => root.render(<DefectSubmitPanel />));
    const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="问题描述"]')!;
    await act(async () => Simulate.change(textarea, { target: { value: input.content } } as never));
    const button = document.querySelector<HTMLButtonElement>('[data-tour-id="defect-submit"]')!;
    await act(async () => { button.click(); });
    const rows = useDefectStore.getState().defects;
    expect(rows.map((row) => row.id)).toEqual(['draft-1']);
    expect(rows[0].status).toBe('submitted');
    expect(useDefectStore.getState().showSubmitPanel).toBe(false);
    sessionStorage.removeItem('defect-agent-last-assignee');
  });

  it('上传响应丢失后用户移除文件，先删除本会话的已上传附件再提交', async () => {
    const file = new File(['a'], 'a.txt');
    calls.upload.mockImplementationOnce(async (request) => {
      draft = { ...draft, attachments: [{ id: 'uploaded-before-disconnect', clientRequestId: request.clientRequestId }, { id: 'other-source' }] as DefectAttachment[] };
      throw new Error('Failed to fetch');
    });
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    await act(async () => { expect(await current.submit(input, [])).toBe(true); });
    expect(calls.remove).toHaveBeenCalledTimes(1);
    expect(calls.remove).toHaveBeenCalledWith({ id: 'draft-1', attachmentId: 'uploaded-before-disconnect' });
    expect(calls.submit).toHaveBeenCalledTimes(1);
  });

  it('同一帧连续触发只启动一条提交链，提交中不能重置重试身份', async () => {
    let resume!: (value: ReturnType<typeof ok<{ defect: DefectReport }>>) => void;
    calls.create.mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    let first!: Promise<boolean>;
    await act(async () => {
      first = current.submit(input, []);
      expect(await current.submit(input, [])).toBe(false);
      current.reset();
    });
    expect(calls.create).toHaveBeenCalledTimes(1);
    await act(async () => { resume(ok({ defect: draft })); expect(await first).toBe(true); });
    expect(calls.submit).toHaveBeenCalledTimes(1);
  });

  it('新编辑会话使用新身份，未知上游细节不进入界面', async () => {
    calls.create.mockRejectedValueOnce(new Error('HTTP 500 secret https://upstream.invalid'));
    await act(async () => { await current.submit(input, []); });
    const originalIdentity = calls.create.mock.calls[0][0].clientRequestId;
    expect(current.error).not.toMatch(/HTTP|secret|upstream/);
    await act(async () => current.reset());
    expect(calls.dismiss).toHaveBeenCalledWith('own-failure-toast');
    await act(async () => { expect(await current.submit(input, [])).toBe(true); });
    expect(calls.create.mock.calls[1][0].clientRequestId).not.toBe(originalIdentity);
  });

  it.each([false, true])('同File异步分析补充描述后更换上传身份，已存=%s 时精确删除旧附件', async (persisted) => {
    const file = new File(['image'], 'evidence.png', { type: 'image/png' });
    calls.upload.mockImplementationOnce(async request => {
      if (persisted) draft = { ...draft, attachments: [
        { id: 'own-old', clientRequestId: request.clientRequestId },
        { id: 'other-source', clientRequestId: 'foreign-request' },
      ] as DefectAttachment[] };
      return fail('NETWORK_ERROR', '上传响应丢失');
    });
    await act(async () => { expect(await current.submit(input, [{ file }])).toBe(false); });
    const oldId = calls.upload.mock.calls[0][0].clientRequestId;
    calls.upload.mockResolvedValueOnce(fail('NETWORK_ERROR', '再次断连'));
    const analyzed = [{ file, description: '异步图片分析结果' }];
    await act(async () => { expect(await current.submit(input, analyzed)).toBe(false); });
    expect(calls.upload.mock.calls[1][0]).toMatchObject({ file, description: analyzed[0].description });
    const newId = calls.upload.mock.calls[1][0].clientRequestId;
    expect(newId).not.toBe(oldId);
    expect(calls.remove.mock.calls).toEqual(persisted ? [[{ id: 'draft-1', attachmentId: 'own-old' }]] : []);
    // 模拟服务端删除后的真实草稿；其他来源附件仍保留。
    draft = { ...draft, attachments: (draft.attachments ?? []).filter(item => item.id !== 'own-old') };
    await act(async () => { expect(await current.submit(input, analyzed)).toBe(true); });
    expect(calls.upload.mock.calls[2][0].clientRequestId).toBe(newId);
    expect(calls.upload.mock.calls[2][0].description).toBe(analyzed[0].description);
    expect(calls.submit).toHaveBeenCalledTimes(1);
  });

  it('替换描述前删除失败保留旧身份，重试成功删除后才上传新身份', async () => {
    const file = new File(['image'], 'evidence.png', { type: 'image/png' });
    calls.upload.mockImplementationOnce(async request => {
      draft = { ...draft, attachments: [{ id: 'own-old', clientRequestId: request.clientRequestId }] as DefectAttachment[] };
      return fail('NETWORK_ERROR', '上传响应丢失');
    });
    await act(async () => { await current.submit(input, [{ file }]); });
    const oldId = calls.upload.mock.calls[0][0].clientRequestId;
    calls.remove.mockResolvedValueOnce(fail('NETWORK_ERROR', '删除失败'));
    const analyzed = [{ file, description: '延迟分析完成' }];
    await act(async () => { expect(await current.submit(input, analyzed)).toBe(false); });
    expect(calls.upload).toHaveBeenCalledTimes(1);
    expect(calls.submit).not.toHaveBeenCalled();
    await act(async () => { expect(await current.submit(input, analyzed)).toBe(true); });
    expect(calls.remove.mock.calls).toEqual([
      [{ id: 'draft-1', attachmentId: 'own-old' }], [{ id: 'draft-1', attachmentId: 'own-old' }],
    ]);
    expect(calls.upload.mock.calls[1][0].clientRequestId).not.toBe(oldId);
    expect(calls.upload.mock.calls[1][0].description).toBe('延迟分析完成');
  });

  it('已提交后分析描述变化仍保护未应用编辑，不删除或再上传', async () => {
    const file = new File(['image'], 'evidence.png', { type: 'image/png' });
    calls.submit.mockImplementationOnce(async () => {
      draft = { ...draft, status: 'submitted' };
      return fail('NETWORK_ERROR', '提交响应丢失');
    });
    await act(async () => { await current.submit(input, [{ file }]); });
    await act(async () => { expect(await current.submit(input, [{ file, description: '延迟分析结果' }])).toBe(false); });
    expect(current.unappliedChanges).toBe(true);
    expect(calls.upload).toHaveBeenCalledTimes(1);
    expect(calls.remove).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

});
