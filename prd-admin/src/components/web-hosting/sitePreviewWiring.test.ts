import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 站内预览「走服务端代理取正文」这条接线的守卫。
 *
 * 为什么需要：这条接线**删掉之后一个测试都不会红**——组件照常渲染，iframe 照常挂载，
 * 只是又退回到那个在 Chrome 里只画空白的直链。PR #1356 修分享页时就漏了缩略图与站内
 * 大预览，两个月后用户报「网页托管无法显示内容」，正是同一个空白在列表页复发
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 2：链路只建到一半）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** 剥掉注释再判：本仓库的注释里到处在**描述**这些反模式，不剥会匹配到散文而误报。 */
function read(relative: string): string {
  return fs
    .readFileSync(path.join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('托管预览接线', () => {
  it('缩略图接了服务端代理取正文，不是只挂一个直链 iframe', () => {
    const source = read('components/SitePreview.tsx');
    expect(source).toContain('useSitePreviewHtml');
    // 拿到正文必须真的用上：srcDoc 要接到 iframe 上，而不是取回来丢掉
    expect(source).toMatch(/srcDoc=\{/);
  });

  it('站内大预览同样接了服务端代理取正文', () => {
    const source = read('components/web-hosting/SitePreviewModal.tsx');
    expect(source).toContain('useSitePreviewHtml');
    expect(source).toMatch(/srcDoc=\{/);
  });

  it('网页托管列表把 site 传给缩略图（不传就取不到正文，静默退回直链）', () => {
    const source = read('pages/WebPagesPage.tsx');
    const usages = source.match(/<SitePreview\b[^>]*>/g) ?? [];
    expect(usages.length).toBeGreaterThan(0);
    for (const usage of usages) {
      expect(usage, `这处 <SitePreview> 没传 site：${usage}`).toMatch(/\bsite=\{/);
    }
  });

  /**
   * 缩略图的占位符必须常驻在最底层，不能被「时间到了就撤掉」。
   *
   * 跨域 iframe 读不到「画出来了没有」的信号，原先用 1.2s 定时器无条件撤掉占位符，
   * 等于拿时间冒充证据：页面真没画出来时用户看到的是一块纯空白瓦片——比地球图标更糟，
   * 它看起来像内容，其实什么都没有（形状 8：不成立的证据不能当证据）。
   */
  it('缩略图占位符常驻底层，不由定时器撤掉', () => {
    const source = read('components/SitePreview.tsx');
    expect(source).not.toMatch(/\{\s*!visible\s*&&/);
  });
});
