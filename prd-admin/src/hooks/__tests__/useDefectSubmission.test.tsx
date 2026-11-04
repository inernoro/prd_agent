// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, fail } from '@/types/api';
import type { DefectAttachment, DefectReport } from '@/services/contracts/defectAgent';
import { useDefectSubmission } from '../useDefectSubmission';
import { DefectSubmitPanel } from '@/pages/defect-agent/components/DefectSubmitPanel';
import { useDefectStore } from '@/stores/defectStore';

const calls = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), upload: vi.fn(), remove: vi.fn(), submit: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/services', () => ({ createDefect: calls.create, updateDefect: calls.update, addDefectAttachment: calls.upload, deleteDefectAttachment: calls.remove, submitDefect: calls.submit }));
vi.mock('@/lib/toast', () => ({ toast: { success: calls.success, error: calls.error, dismiss: calls.dismiss } }));
vi.mock('@/components/design/GlassCard', () => ({ GlassCard: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: () => null }));
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
});
