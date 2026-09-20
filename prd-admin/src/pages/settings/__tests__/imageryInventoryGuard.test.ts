import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：配图清单拉不到时，生成的闸必须在 generate() 里，不能只在按钮的 disabled 上。
 *
 * 由来是连着栽的两次：第一次只守住顶部批量按钮，第二次补了整组与单张，
 * 仍漏掉预览浮层的「换一张」（→ openDialog → 提交 → generate）。逐个入口打补丁
 * 永远差一个（`predicate-and-wiring-discipline` 形状 2），而漏掉的那条路会花钱
 * 重画已经存在的图。
 *
 * 所以判据只认咽喉：generate() 自己必须挡。
 */

const FILE = path.resolve(__dirname, '../SystemImagerySettings.tsx');

describe('配图生成的清单闸', () => {
  const src = fs.readFileSync(FILE, 'utf-8');

  it('generate() 自己检查 inventoryFailed', () => {
    const at = src.indexOf('const generate = async');
    expect(at, '找不到 generate()，守卫判据已过期，请修守卫').toBeGreaterThan(-1);
    const head = src.slice(at, at + 1600);
    /*
     * 判据必须是**语句**不是提到这个词。第一版写成 head.includes('inventoryFailed')，
     * 而上面那段注释里正好出现了两次这个词——把 if 整块删掉，守卫照样绿。
     * 一个不会红的证据比没有证据更糟（形状 4）。
     */
    expect(
      /if\s*\(\s*inventoryFailed\s*\)/.test(head),
      '闸只挂在按钮的 disabled 上：任何绕过按钮的入口（预览浮层「换一张」等）都会照常花钱生成',
    ).toBe(true);
  });
});
