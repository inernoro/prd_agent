/**
 * 划词浮层配色的 SSOT 守卫。
 *
 * 背景（2026-08-21）：同一套浮层配色曾经抄在三个文件里，三处都写着冷紫
 * rgba(168,85,247,.4)，与产品主色 #D97757 一冷一暖同屏打架。抽成
 * selectionOverlayStyle.ts 之后，最容易复发的两种形态各对应一条断言：
 *  - 形状 3（判据分裂）：有人图省事又在组件里手写一份面板样式；
 *  - 形状 2（接线只建一半）：样式模块建好了，但某个浮层根本没 import 它，
 *    删掉这条 import 不会有任何测试变红。
 *
 * 断言的是「颜色从哪来」，不是某段实现的字面存在（形状 4a）：
 * 具体色值随时可以调，但必须调在 tokens.css 与这一份样式模块里。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STYLE_MODULE = 'selectionOverlayStyle';

/** 三个划词浮层：改写输入条 / 采纳条、划词 AI 面板、划词配图面板 */
const OVERLAY_FILES = [
  'SelectionRewriteInline.tsx',
  'SelectionAiPopover.tsx',
  'SelectionImagePopover.tsx',
] as const;

function read(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}

describe('划词浮层配色 SSOT', () => {
  it('三个浮层都从共用样式模块取面板样式，没人再手写一份', () => {
    for (const file of OVERLAY_FILES) {
      const src = read(file);
      expect(src, `${file} 没有 import ${STYLE_MODULE}`).toContain(`./${STYLE_MODULE}`);
      expect(src, `${file} 没有消费 SELECTION_OVERLAY_PANEL`).toContain('SELECTION_OVERLAY_PANEL');
    }
  });

  it('浮层里不再出现冷紫，也不再手写浮层底色与阴影', () => {
    for (const file of OVERLAY_FILES) {
      const src = read(file);
      expect(src, `${file} 仍有冷紫硬编码`).not.toMatch(/rgba\(\s*168\s*,\s*85\s*,\s*247/);
      expect(src, `${file} 仍在手写浮层底`).not.toContain('var(--overlay-panel-bg)');
      expect(src, `${file} 仍在手写浮层阴影`).not.toMatch(/boxShadow:\s*'0 18px 44px/);
    }
  });

  it('划词工具条与选区高亮也走同一份样式，没留在旧的冷紫里', () => {
    const src = read('DocBrowser.tsx');
    expect(src).toContain(`./${STYLE_MODULE}`);
    // DocBrowser 里还有别的功能在用紫色（AI 摘要卡等，不在本次范围），
    // 所以只切出划词这两个函数来判，不整文件一刀切。
    for (const [fn, token] of [
      ['function PendingSelectionHighlight(', 'SELECTION_OVERLAY_HIGHLIGHT'],
      ['function SelectionActionPopover(', 'SELECTION_OVERLAY_BAR'],
    ] as const) {
      const start = src.indexOf(fn);
      expect(start, `找不到 ${fn}，守卫失去目标`).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      expect(body, `${fn} 没有消费 ${token}`).toContain(token);
      expect(body, `${fn} 仍有冷紫硬编码`).not.toMatch(/rgba\(\s*168\s*,\s*85\s*,\s*247/);
      expect(body, `${fn} 仍有冷紫文字色`).not.toMatch(/rgba\(\s*216\s*,\s*180\s*,\s*254/);
    }
  });

  it('样式模块本身只消费 token，不写死颜色字面量', () => {
    const src = read(`${STYLE_MODULE}.ts`);
    // 注释里可以举反例说明历史，所以只看代码部分
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // 唯一允许的字面 rgba 是主按钮那层投影，且颜色通道本身也来自 token
    for (const hit of code.matchAll(/rgba?\(([^)]*)\)/g)) {
      expect(hit[0], '样式模块里出现了写死通道值的颜色').toContain('var(--');
    }
  });
});
