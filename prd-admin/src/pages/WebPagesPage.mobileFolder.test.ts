import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./WebPagesPage.tsx', import.meta.url), 'utf8');

describe('网页托管移动端文件夹入口', () => {
  it('个人空间筛选面板提供创建入口，并复用真实文件夹创建流程', () => {
    expect(source).toContain('data-tour-id="webpages-mobile-create-folder"');
    expect(source).toContain('data-tour-id="webpages-mobile-folder-form"');
    expect(source).toContain('const created = await handleCreatePersonalFolder(name)');
    expect(source).toContain("currentSpace.kind === 'personal'");
  });

  it('拖拽成功后用服务端响应刷新名称与权威键', () => {
    expect(source).toContain('item.id === siteId ? res.data : item');
    expect(source).not.toContain('{ ...item, folder, updatedAt: res.data.updatedAt }');
  });
});
