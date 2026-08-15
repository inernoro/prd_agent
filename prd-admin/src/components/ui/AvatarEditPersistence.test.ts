import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const dialogSource = readFileSync(path.resolve(testDirectory, 'AvatarEditDialog.tsx'), 'utf8');
const appShellSource = readFileSync(path.resolve(testDirectory, '../../layouts/AppShell.tsx'), 'utf8');
const accountSettingsSource = readFileSync(
  path.resolve(testDirectory, '../../pages/settings/AccountSettings.tsx'),
  'utf8',
);
const usersPageSource = readFileSync(path.resolve(testDirectory, '../../pages/UsersPage.tsx'), 'utf8');

describe('头像持久化单次写入契约', () => {
  it('上传或应用成功后只同步服务端返回结果，不再二次保存', () => {
    expect(dialogSource).toContain('props.onPersisted({ ...response.data, avatarFileName: fileName })');
    expect(dialogSource).not.toContain('props.onSave(');
    expect(appShellSource).not.toContain('updateMyAvatar');
    expect(accountSettingsSource).not.toContain('updateMyAvatar');
    expect(usersPageSource).not.toContain('updateUserAvatar');
  });

  it('生成图片失效时保留错误码并指导重新生成预览', () => {
    expect(dialogSource).toContain('code: response.error.code');
    expect(dialogSource).toContain('请重新生成预览后再应用。');
    expect(dialogSource).not.toContain("throw new Error(response.error?.message || '替换头像失败')");
  });

  it('上传失败时保留服务端错误码并给出可执行的恢复提示', () => {
    const uploadBranch = dialogSource.slice(
      dialogSource.indexOf('const uploadAndSave'),
      dialogSource.indexOf('const onChooseFile'),
    );
    expect(uploadBranch).toContain('code: response.error.code');
    expect(uploadBranch).toContain('请检查图片格式、大小和网络后重新上传。');
    expect(uploadBranch).not.toContain("throw new Error(response.error?.message || '上传失败')");
  });

  it('重新打开弹窗时同时恢复已知任务和创建响应丢失的任务', () => {
    expect(dialogSource).toContain('hasRecoverableMyAvatarGeneration()');
    expect(dialogSource).toContain('resumeMyAvatarPreview({');
    expect(dialogSource).not.toContain('if (!runId) return;');
  });

  it('空描述时说明不能继续的原因和恢复动作', () => {
    expect(dialogSource).toContain('aria-describedby="avatar-ai-prompt-help"');
    expect(dialogSource).toContain('请先描述想怎么修改头像，输入后即可生成预览。');
  });
});
