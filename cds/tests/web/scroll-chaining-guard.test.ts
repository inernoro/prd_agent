/*
 * 守卫：横向滚动容器不许两轴一起 overscroll-behavior: contain。
 *
 * overflow-x: auto 会把 y 轴也算成滚动容器（CSS 规定一轴非 visible 另一轴也非 visible）。
 * 此时若写 `overscrollBehavior: 'contain'`，纵向滚轮到了它这里就被拦住、不再往祖先冒——
 * 鼠标停在那张表上，整个详情页就滚不动。2026-09-15 用户截图「无法滑动下去」就是这个。
 * 想拦的只是横向回弹，写 X 轴那一个属性。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../web/src', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('横向滚动容器不吃纵向滚轮', () => {
  it('overflow-x-auto 的元素上没有两轴 contain', () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, 'utf8');
      // 同一个开标签里既有 overflow-x-auto 又有 overscrollBehavior: 'contain'
      const re = /<div[^>]*overflow-x-auto[^>]*overscrollBehavior:\s*'contain'[^>]*>/g;
      for (const m of src.matchAll(re)) hits.push(`${file.replace(ROOT, '')}: ${m[0].slice(0, 90)}`);
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
