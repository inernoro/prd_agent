import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../WebPagesPage.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../services/real/webPages.ts', import.meta.url), 'utf8');

/**
 * 内容发布租约占用时删除会被推迟：后端返回 202 + deleted=false，站点仍然存在。
 * 只看 res.success 就把卡片抹掉，是在告诉用户一件没发生的事——刷新之后它又回来
 * （Codex P2，2026-09-15）。两个单站点删除处理器共用同一条判据。
 */
describe('推迟删除时不许把卡片抹掉', () => {
  it('契约里暴露了 deleted 与 cleanupPending', () => {
    expect(service).toContain('deleted: boolean; cleanupPending?: boolean');
  });

  it('两个删除处理器都先看 deleted 再决定要不要移除卡片', () => {
    const handlers = [...page.matchAll(/const res = await deleteSite\([^)]*\);([\s\S]{0,700}?)\n {2}\}/g)];
    // companion：确实截到了两个处理器，否则下面的断言会对着空数组判绿。
    expect(handlers).toHaveLength(2);
    for (const [, body] of handlers) {
      expect(body, '处理器没有检查 deleted，会抹掉一张还在的卡片')
        .toContain('res.data.deleted === false');
      expect(
        body.indexOf('res.data.deleted === false'),
        'deleted 判定必须排在移除卡片之前',
      ).toBeLessThan(body.indexOf('setSites(prev => prev.filter'));
      expect(body, '推迟分支没有就地 return，会继续走到移除逻辑').toMatch(/deleted === false\)[\s\S]{0,320}return;/);
    }
  });
});
