/**
 * 手机上点输入框页面被自动放大、输完不复原——iOS Safari 对字号小于 16px 的输入控件的固定行为。
 * 修法在 base.css：只在 iOS（@supports -webkit-touch-callout）把可输入控件兜到 >= 16px。
 *
 * 守的是三件「删掉也不会有任何测试变红、页面照常渲染」的事（predicate-and-wiring-discipline 形状 2）：
 *   1. 规则还在，且真的包在只有 iOS 认的 @supports 里（包错了条件就在电脑端也改字号，或在 iOS 上不生效）；
 *   2. 带 !important——全站大量输入框的字号写在 inline style 里，不带它就压不过，等于没修；
 *   3. base.css 仍被 globals.css 引入（文件在、没接上线也是没修）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.readFileSync(path.join(STYLES, 'base.css'), 'utf8');

function supportsBlock(css: string, condition: string): string | null {
  const at = css.indexOf(`@supports ${condition}`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(at, i + 1);
  }
  return null;
}

describe('iOS 聚焦输入框不自动放大', () => {
  const block = supportsBlock(base, '(-webkit-touch-callout: none)');

  it('规则包在只有 iOS 认的 @supports 里，覆盖 input / textarea / select / 可编辑区', () => {
    expect(block, 'base.css 里找不到 @supports (-webkit-touch-callout: none) 块').not.toBeNull();
    for (const sel of ['input', 'textarea', 'select', '[contenteditable]']) expect(block).toContain(sel);
  });

  it('字号兜到至少 16px，并且带 !important（否则压不过 inline style）', () => {
    expect(block).toMatch(/font-size:\s*max\(16px,\s*1em\)\s*!important/);
  });

  it('base.css 仍被全局样式引入', () => {
    const globals = fs.readFileSync(path.join(STYLES, 'globals.css'), 'utf8');
    expect(globals).toMatch(/@import\s+['"]\.\/base\.css['"]/);
  });
});
