import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { documentDisplayTitle } from '../docBrowserTitle';

const published = { id: 'published', title: '作者确认的交接指南', isFolder: false, hasWritingPublication: true };

describe('文档标题与正文首行的选择', () => {
  it('目录行与阅读栏接入同一标题规则，不能只留下未使用的辅助函数', () => {
    const browser = readFileSync(new URL('../DocBrowser.tsx', import.meta.url), 'utf8');
    expect(browser).toMatch(/import\s*\{\s*documentDisplayTitle as getDisplayTitle\s*\}\s*from '\.\/docBrowserTitle'/);
    expect(browser).not.toMatch(/function getDisplayTitle\s*\(/);
    expect(browser).toContain('const displayTitle = getDisplayTitle(entry, useContentTitle, contentFirstLines)');
    expect(browser).toContain('getDisplayTitle(selectedEntryData, useContentTitle, contentFirstLines)');
  });

  it('已发布成文的摘要异步到达后，目录与阅读栏仍使用作者确认标题', () => {
    expect(documentDisplayTitle(published, true, new Map())).toBe(published.title);
    expect(documentDisplayTitle(published, true, new Map([[published.id, '本合成案例只适用于测试租户，执行人先备份再审核导入。']]))).toBe(published.title);
  });

  it('普通文档继续采用正文标题，缺少正文首行时回退文件名', () => {
    const entry = { id: 'ordinary', title: '导入文件.md', isFolder: false };
    expect(documentDisplayTitle(entry, true, new Map([[entry.id, '正文中的交接规范']]))).toBe('正文中的交接规范');
    expect(documentDisplayTitle(entry, true, new Map())).toBe('导入文件.md');
    expect(documentDisplayTitle(entry, false, new Map([[entry.id, '正文中的交接规范']]))).toBe('导入文件.md');
  });

  it('文件夹名称不被预览内容替换，未发布草稿仍遵守普通显示偏好', () => {
    expect(documentDisplayTitle({ id: 'folder', title: '资料目录', isFolder: true }, true, new Map([['folder', '其他首行']]))).toBe('资料目录');
    expect(documentDisplayTitle({ ...published, hasWritingPublication: false }, true, new Map([[published.id, '草稿正文标题']]))).toBe('草稿正文标题');
  });
});
