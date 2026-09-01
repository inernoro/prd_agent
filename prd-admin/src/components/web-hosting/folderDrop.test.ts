import { describe, expect, it } from 'vitest';
import {
  buildWebPageFolderSlot,
  buildWebPageGroupSlot,
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
});
