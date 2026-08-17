import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 调色板的两条硬约束。都属于「改完页面照样渲染、测试照样绿，只有真人看才发现」
 * 的那一类，所以必须机械钉住。
 *
 * 背景：2026-08-15 全站换用 design_handoff_release_center 的调色板，主色是一抹
 * 亮绿 `#c8f04a`。它当填充色很好看，**当文字色在白天几乎读不出来**——实测
 * 「接入 Agent」在浅底上对比度只有 1.22:1（AA 要求 4.5:1，大字 3:1）。
 * 模板本来就为此分了两个值：--accent 填充 / --accent-ink 文字。
 */

const CSS = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/src/index.css'), 'utf8');
const TW = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/tailwind.config.js'), 'utf8');
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('主色：填充用 primary，文字用 primary-ink', () => {
  /**
   * 这条是真实故障的回归。`color: hsl(var(--primary))` 曾有 21 处，
   * 白天全部是亮绿字落在浅底上。border-color / background-color 用亮绿是对的，
   * 只有 `color:` 必须换成 ink。
   */
  it('index.css 里不许再用 --primary 当文字色', () => {
    const css = strip(CSS);
    const hits = css.match(/(?<!-)\bcolor:\s*hsl\(var\(--primary\)[^)]*\)/g) || [];
    expect(hits, `这些地方把主色当文字色用了，白天读不出来：\n${hits.join('\n')}`).toEqual([]);
    // 反向确认 ink 真的在用，不是把问题整段删掉了事
    expect(css).toContain('color: hsl(var(--primary-ink)');
  });

  it('Tailwind 的 text-primary 也指向 ink（组件里那一半）', () => {
    const tw = strip(TW);
    expect(tw).toContain('textColor: {');
    expect(tw).toMatch(/textColor:\s*\{[^}]*primary:\s*'hsl\(var\(--primary-ink\)/);
    // bg-primary 仍然是亮绿，别一起改掉
    expect(tw).toMatch(/primary:\s*\{[^}]*DEFAULT:\s*'hsl\(var\(--primary\)/);
  });
});

describe('状态色只走 token，不再硬编码调色板', () => {
  const SRC = path.resolve(process.cwd(), '../cds/web/src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

  /**
   * 硬编码的 emerald/amber/red/sky **不跟主题走**：换调色板时它们留在原地
   * 与新底色打架，而且每处都得写 `text-x-600 dark:text-x-400` 双主题对，
   * 漏一半就在某个主题下看不清。1291 处已收敛到 ok/warn/bad/info，不许回流。
   */
  it('组件里没有硬编码的 Tailwind 调色板状态色', () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const hits = src.match(/\b(?:bg|text|border|ring|fill)-(?:red|emerald|amber|sky|green|blue|orange|rose)-\d{2,3}\b/g);
      if (hits) bad.push(`${path.relative(SRC, file)}: ${[...new Set(hits)].join(' ')}`);
    }
    expect(bad, `改用语义类 ok / warn / bad / info（各带 -soft 底色）：\n${bad.join('\n')}`).toEqual([]);
  });

  it('四档状态色在两个主题里都定义了', () => {
    for (const token of ['ok', 'ok-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'info', 'info-soft']) {
      const count = (CSS.match(new RegExp(`--${token}:`, 'g')) || []).length;
      expect(count, `--${token} 应在 dark 与 light 各定义一次，实际 ${count} 次`).toBe(2);
    }
  });
});
