import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：**首页里指向本页的锚点，落点得真的存在。**
 *
 * 死锚点是「链路只建一半」最便宜的一种形态：点了只换地址栏，页面纹丝不动。
 * 它不会报错、不会红、通读也挑不出来——只有真去点那一下才知道。
 *
 * 这类缺陷在这一页上已经出现两次：
 *   · 顶部导航指向被删掉的旧章节；
 *   · 「看看有哪些 Agent」指向 `#scene-roster`，而那一幕早被照 /ai-toolbox
 *     重画的百宝箱取代，`id` 换成了 `agents` / `scene-toolbox`。
 * 两次都是「幕改了、指过去的那根线没跟着改」，所以补一条机械判据。
 */

const HOME_DIR = path.resolve(__dirname, '../../pages/home');

/** 递归收集 pages/home 下的全部 tsx 源码 */
function sources(dir: string): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) { out.push(...sources(full)); continue; }
    if (!name.endsWith('.tsx')) continue;
    out.push({ file: path.relative(HOME_DIR, full), src: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

describe('首页的页内锚点', () => {
  const all = sources(HOME_DIR);

  const ids = new Set<string>();
  for (const { src } of all) {
    for (const m of src.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)) ids.add(m[1]);
  }

  const links: { file: string; target: string }[] = [];
  for (const { file, src } of all) {
    for (const m of src.matchAll(/href="#([a-zA-Z0-9_-]+)"/g)) links.push({ file, target: m[1] });
  }

  it('扫到了锚点和 id（判据不是空跑）', () => {
    expect(links.length, '一条页内锚点都没扫到，说明选择器写错了').toBeGreaterThan(0);
    expect(ids.size).toBeGreaterThan(5);
  });

  it('每个 href="#x" 都能在首页找到对应的 id="x"', () => {
    const dead = links
      .filter((l) => !ids.has(l.target))
      .map((l) => `${l.file} -> #${l.target}（页面上没有这个 id）`);
    expect(
      dead,
      dead.join('\n') + '\n死锚点：点了只换地址栏、页面不动。要么改指到真实存在的 id，'
        + '要么给目标那一幕补上这个 id。',
    ).toEqual([]);
  });
});
