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
});
