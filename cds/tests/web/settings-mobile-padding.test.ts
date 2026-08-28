/**
 * 设置页窄屏内边距不叠层。
 *
 * `.cds-settings-content` 在 `max-width: 900px` 那一档已经用
 * `padding: 1rem !important` 给了 16px 边距。新加的 `.cds-settings-section-body`
 * 又带 1.5rem 横向内边距，两层一叠就是每侧 40px——320px 的屏只剩 240px 装表单。
 *
 * 判据取的是**最终生效的那条声明**（形状 6）：同名属性可以被声明多次，
 * 所以这里按源码顺序取窄屏档里最后一条 `.cds-settings-section-body` 的 padding，
 * 而不是第一条；断言它的横向分量为 0，把横向留给外层。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../web/src/index.css', import.meta.url), 'utf8');

/** 取某个选择器在「max-width: 900px 及更窄」的媒体查询里最后一条 padding 声明。 */
function narrowScreenPadding(selector: string): string | null {
  const blocks = [...CSS.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)];
  let winner: string | null = null;
  for (const match of blocks) {
    const width = Number(match[1]);
    if (width > 900) continue;
    // 从 @media 起始处向后截一段，够覆盖整块即可；只要能找到该选择器的规则。
    const chunk = CSS.slice(match.index ?? 0, (match.index ?? 0) + 60000);
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'g');
    let hit: RegExpExecArray | null;
    while ((hit = rule.exec(chunk)) !== null) {
      const padding = /(?:^|[\s;])padding:\s*([^;}]+)/.exec(hit[1]);
      if (padding) winner = padding[1].trim();
    }
  }
  return winner;
}

describe('设置页窄屏内边距', () => {
  it('外层 .cds-settings-content 在窄屏给横向边距', () => {
    const padding = narrowScreenPadding('.cds-settings-content');
    expect(padding, '窄屏档里找不到 .cds-settings-content 的 padding').not.toBeNull();
    // 单值 padding，四边同宽；只要它给了非零横向边距，内层就不该再叠一层。
    expect(padding).toMatch(/^1rem/);
  });

  it('内层 .cds-settings-section-body 在窄屏横向内边距为 0，不与外层叠加', () => {
    const padding = narrowScreenPadding('.cds-settings-section-body');
    expect(
      padding,
      '.cds-settings-section-body 在窄屏没有覆盖 padding，会和外层的 1rem 叠成每侧 40px',
    ).not.toBeNull();
    const parts = (padding as string).split(/\s+/);
    // 一到四值写法里，横向分量分别在第 2 位（两值/三值/四值）或第 1 位（单值）。
    const horizontal = parts.length === 1 ? parts[0] : parts[1];
    expect(horizontal, `横向内边距是 ${horizontal}，应为 0`).toMatch(/^0(px|rem|%)?$/);
  });
});
