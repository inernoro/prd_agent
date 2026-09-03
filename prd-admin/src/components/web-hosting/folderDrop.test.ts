import { describe, expect, it } from 'vitest';
import {
  buildWebPageFolderSlot,
  buildWebPageGroupSlot,
  canDropSiteIntoTeamGroup,
  planPersonalFolderCreate,
  parseWebPageDropSlot,
} from './folderDrop';

describe('网页卡片文件夹拖拽协议', () => {
  it('文件夹名称可安全往返，中文和特殊字符不丢失', () => {
    const slot = buildWebPageFolderSlot('验收 / 分享 #1');
    expect(parseWebPageDropSlot(slot)).toEqual({ kind: 'folder', value: '验收 / 分享 #1' });
  });

  it('团队分组使用独立命名空间，不会误投到个人文件夹', () => {
    const slot = buildWebPageGroupSlot('group:42');
    expect(parseWebPageDropSlot(slot)).toEqual({ kind: 'group', value: 'group:42' });
  });

  it('拒绝未知、空值和损坏编码', () => {
    expect(parseWebPageDropSlot('share:folder')).toBeNull();
    expect(parseWebPageDropSlot('web-page-folder:')).toBeNull();
    expect(parseWebPageDropSlot('web-page-folder:%E0%A4%A')).toBeNull();
  });

  it('团队查看者只能移动自己创建的站点，编辑者可移动团队站点', () => {
    expect(canDropSiteIntoTeamGroup('viewer', 'user-1', 'user-1')).toBe(true);
    expect(canDropSiteIntoTeamGroup('viewer', 'user-2', 'user-1')).toBe(false);
    expect(canDropSiteIntoTeamGroup('editor', 'user-2', 'user-1')).toBe(true);
  });

  it('同名旧文件夹仍会补建持久记录，已有持久记录则只切换', () => {
    expect(planPersonalFolderCreate('历史归档', [], ['历史归档'])).toEqual({
      kind: 'create',
      name: '历史归档',
    });
    expect(planPersonalFolderCreate('历史归档', ['历史归档'], ['历史归档'])).toEqual({
      kind: 'select',
      name: '历史归档',
    });
  });
});
