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
});
