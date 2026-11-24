/**
 * 全站字体链的接线守卫。
 *
 * 背景（2026-08-21）：index.html 一直在加载 Inter / Space Grotesk / Source Serif 4，
 * 但全仓没有任何一处 font-family 引用它们，Tailwind 兜底到 system-ui，
 * 中文在 Windows 上落到系统默认字体——用户的原话是「有一种老 Windows 的字体感」。
 *
 * 为什么不扫源码（predicate-and-wiring-discipline.md 形状 6）：
 * `@theme { --font-sans: ... }` 写在文件里只证明零件在，不证明装对了——
 * 真正生效的是 preflight 的 `html { font-family: var(--default-font-family, 兜底) }`，
 * 而那个变量要经由 `--default-font-family: var(--font-sans)` 才接得上。
 * 中间任何一环断掉（改了 @theme 的层级、Tailwind 换了变量名、被别处覆盖），
 * 页面会静默退回系统字体而源码看着完全正常。
 * 所以这里编译真实的 tailwind.css，按 var 链条一路解到最终值再断言。
 *
 * 形状 8（别把不成立的证据当证据）：只断言「html 规则里出现了 Inter」不够——
 * 那串 Inter 也可能只是 var() 的兜底参数（`--default-font-family` 没定义时才生效）。
 * 下面显式检查变量确实被定义，再解析它的值。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const STYLES_DIR = path.resolve(TEST_DIR, '..');
const ADMIN_DIR = path.resolve(STYLES_DIR, '../..');
const TW_DIR = path.join(ADMIN_DIR, 'node_modules/tailwindcss');

async function buildTailwindCss(): Promise<string> {
  const source = fs.readFileSync(path.join(STYLES_DIR, 'tailwind.css'), 'utf8');
  const compiled = await compile(source, {
    base: STYLES_DIR,
    loadStylesheet: async (id: string) => {
      const file = id === 'tailwindcss'
        ? path.join(TW_DIR, 'index.css')
        : path.join(TW_DIR, id.replace(/^\.\//, ''));
      return { path: file, base: TW_DIR, content: fs.readFileSync(file, 'utf8') };
    },
  });
  // 不传候选类名：preflight 与 :root 的 theme 变量与用了哪些工具类无关
  return compiled.build([]);
}

/** 取某个自定义属性的**定义值**（`--x: 值;`），拿不到就返回 null。 */
function readCustomProperty(css: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const m = re.exec(css);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** 顺着 `var(--x)` 一路解到字面值，最多 5 层，防环。 */
function resolveVarChain(css: string, value: string, depth = 0): string {
  if (depth > 5) return value;
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value.trim());
  if (!m) return value;
  const next = readCustomProperty(css, m[1]);
  return next === null ? value : resolveVarChain(css, next, depth + 1);
}

describe('全站字体链（font-sans → default-font-family → html）', () => {
  it('preflight 的 html 规则确实接到了我们定义的字体链，而不是 var() 兜底', async () => {
    const css = await buildTailwindCss();

    // 1. html 规则读的是 --default-font-family
    const htmlRule = /html,\s*:host\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
    expect(htmlRule).toMatch(/font-family:\s*var\(--default-font-family/);

    // 2. 这个变量必须真的被定义——没定义的话上面那句读到的永远是兜底参数
    const defaultFamily = readCustomProperty(css, '--default-font-family');
    expect(defaultFamily, '--default-font-family 未被输出，html 会退回 var() 兜底的系统字体').not.toBeNull();

    // 3. 解到最终值再断言内容
    const resolved = resolveVarChain(css, defaultFamily!);
    expect(resolved).not.toMatch(/^var\(/); // 没解开说明链断了

    // 拉丁字形走 index.html 已经在加载的 Inter，排在通用族之前
    expect(resolved.indexOf('Inter')).toBeGreaterThanOrEqual(0);
    expect(resolved.indexOf('Inter')).toBeLessThan(resolved.indexOf('sans-serif'));

    // 中文必须显式排序，不许交给浏览器兜底——这是「老 Windows 感」的根因
    for (const cjk of ['PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei UI']) {
      expect(resolved, `中文字体链缺少 ${cjk}`).toContain(cjk);
    }
    expect(resolved.indexOf('PingFang SC')).toBeLessThan(resolved.indexOf('sans-serif'));
  });
});
