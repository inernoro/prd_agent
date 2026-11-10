// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse } from '@/types/api';
import type { AdminUserAvatarUploadResponse } from '@/services/contracts/userAvatarUpload';
import { AvatarEditDialog } from './AvatarEditDialog';

const calls = vi.hoisted(() => ({ generate: vi.fn(), apply: vi.fn(), resume: vi.fn(), upload: vi.fn() }));
vi.mock('@/services', () => ({
  generateMyAvatarPreview: calls.generate, applyGeneratedMyAvatar: calls.apply,
  resumeMyAvatarPreview: calls.resume, uploadUserAvatar: calls.upload,
  hasRecoverableMyAvatarGeneration: () => false,
}));
// 此处只隔离弹层外壳；状态、原事件处理、输入校验及反馈均运行真实编辑器组件。
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content }: { content: ReactNode }) => <>{content}</> }));

let root: Root | undefined;
let host: HTMLDivElement;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  vi.clearAllMocks();
});
async function mount(onUpload?: (file: File) => Promise<ApiResponse<AdminUserAvatarUploadResponse>>) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  const persisted = vi.fn();
  await act(async () => root!.render(<AvatarEditDialog open onOpenChange={vi.fn()} title="合成头像编辑"
    username="synthetic-avatar" currentAvatarUrl="/unit/avatar.png" enableAiEdit
    onUpload={onUpload} onPersisted={persisted} />));
  return persisted;
}
function button(label: string) {
  const matches = [...host.querySelectorAll('button')].filter(node => node.textContent?.trim() === label);
  expect(matches).toHaveLength(1); return matches[0]!;
}
async function chooseFile() {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File(['synthetic'], 'avatar.png', { type: 'image/png' })], configurable: true });
  await act(async () => Simulate.change(input));
}

describe('头像上传反馈与空描述恢复', () => {
  it('空描述允许触发本地校验，显示恢复动作且不调用生成服务', async () => {
    await mount();
    expect(button('生成预览').disabled).toBe(false);
    await act(async () => button('生成预览').click());
    expect(host.textContent).toContain('请描述想怎么修改头像');
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it('上传未结束时显示持续状态，失败后保留当前头像并恢复操作', async () => {
    let finish!: (value: ApiResponse<AdminUserAvatarUploadResponse>) => void;
    const pending = new Promise<ApiResponse<AdminUserAvatarUploadResponse>>(resolve => { finish = resolve; });
    const upload = vi.fn(() => pending), persisted = await mount(upload);
    await chooseFile();
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('uploading');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在上传头像');
    expect(button('生成预览').disabled).toBe(true);
    await act(async () => finish({ success: false, data: null, error: { code: 'UPLOAD_FAILED', message: '合成上传失败' } }));
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('editing');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toContain('合成上传失败');
    expect(button('生成预览').disabled).toBe(false);
    expect(persisted).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.upload).not.toHaveBeenCalled();
  });

  async function generatedPreview() {
    calls.generate.mockResolvedValue({ success: true, data: { assetSha256: 'unit-asset', previewUrl: '/unit/generated.png' }, error: null });
    const input = host.querySelector<HTMLInputElement>('#avatar-ai-prompt')!;
    await act(async () => { input.value = '合成手绘描述'; Simulate.change(input); });
    await act(async () => button('生成预览').click());
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('preview');
  }

  it('已有生成预览后改选文件仍提示上传，不误报正在应用旧预览', async () => {
    let finish!: (value: ApiResponse<AdminUserAvatarUploadResponse>) => void;
    const pending = new Promise<ApiResponse<AdminUserAvatarUploadResponse>>(resolve => { finish = resolve; });
    await mount(() => pending); await generatedPreview(); await chooseFile();
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('uploading');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在上传头像');
    expect(host.textContent).not.toContain('正在替换');
    expect(button('使用此头像').disabled).toBe(true);
    await act(async () => finish({ success: false, data: null, error: { code: 'UPLOAD_FAILED', message: '合成失败' } }));
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it('应用生成预览期间提示替换，失败仍保留预览以便重试', async () => {
    let finish!: (value: ApiResponse<AdminUserAvatarUploadResponse>) => void;
    calls.apply.mockImplementation(() => new Promise<ApiResponse<AdminUserAvatarUploadResponse>>(resolve => { finish = resolve; }));
    const persisted = await mount(); await generatedPreview();
    await act(async () => button('使用此头像').click());
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('applying');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('正在替换头像');
    expect(button('正在替换').disabled).toBe(true);
    await act(async () => finish({ success: false, data: null, error: { code: 'EXPIRED', message: '合成预览失效' } }));
    expect(host.querySelector('[data-avatar-phase]')?.getAttribute('data-avatar-phase')).toBe('preview');
    expect(button('使用此头像').disabled).toBe(false);
    expect(persisted).not.toHaveBeenCalled();
  });
});
