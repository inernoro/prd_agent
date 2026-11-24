import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「同色调浅底 + 同色调浅字」棘轮。
 *
 * 这是本仓库浅色主题里最高频、也最难靠肉眼发现的一类缺陷：
 * 底铺 rgba(同一个色, 0.1~0.2) 的淡色调，字却写死同一个色的 300/400/500 档。
 * 暗色主题下成立（淡底压在深画布上仍是深的，亮字够亮），
 * 浅色主题下两者一起被暖纸底稀释，就变成「浅绿字压浅绿底」——
 * 实测 1.4~2.1:1，远低于 4.5:1。
 *
 * 已知的三次事故（全都是共用层，一处错、几十屏糊）：
 *   - components/design/Badge.tsx        success/danger/warning 三档   1.74:1
 *   - components/daily-tips/difficultyMeta.ts  初/中/高三档            1.42~2.06:1
 *   - pages/email-agent/EmailAgentPage.tsx     分类 chip 选中态         1.54:1
 *
 * 前两次是用户翻页翻出来的，不是扫出来的 —— 因为它们只在**列表被真实数据填满**
 * 之后才渲染，而浏览器审计跑的是空数据桩。所以这一类必须在**源码层**拦，
 * 不能指望运行时扫描。
 *
 * 判据（两种写法各一条）：
 *   A. 内联样式对象里，同一个 rgb 三元组同时出现为 color(alpha≥0.7) 与 background(alpha≤0.3)
 *   B. 同一个 className 串里，bg-<hue>-<shade>/<低透明度> 搭 text-<同 hue>-<浅档 50~300>
 *
 * 修法一律是：**底不动，字改走 tokens.css 里双写的 --accent-fg-***。
 * 底色本身在两个主题下都成立，坏的只有前景。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(full);
  }
  return out;
}

const RGBA = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/g;
/*
 * 十六进制也要认。判据最初只扫 rgba(...)，于是 NOTIFICATION_TYPE_REGISTRY 的九档
 * accent（'#5eead4' 这种 300/400 亮彩）整个溜过去 —— 而通知抽屉挂在 AppShell 上、
 * 全部 36 条路由都渲染它，一处错就是 144 处糊，占那轮真实数据审计的一半。
 */
const HEXC = /#([0-9a-fA-F]{6})\b/g;

interface ColorUse { rgb: string; alpha: number; index: number; }

/**
 * 把 rgb 归到色相族。判据只认「完全相同的三元组」会漏掉最常见的写法：
 * 底用 400 档、字用 300 档，色相一样、三元组不同（海鲜市场 CONFIG_TYPE_REGISTRY
 * 就是 bg rgba(56,189,248,.14) + text rgba(125,211,252,.98)，一眼同色、判据却看不见）。
 * 无彩色返回 null，交给 themeHardcodeRatchet。
 */
function hueFamily(rgb: string): string | null {
  const [r, g, b] = rgb.split(',').map(Number);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return null;
  let h: number;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 330) return 'red';
  if (h < 45) return 'warning';
  if (h < 70) return 'amber';
  if (h < 170) return 'green';
  if (h < 260) return 'blue';
  return 'violet';
}

/** 抓出某段文本里所有「作为前景」与「作为背景」的 rgba 用法。 */
function collect(text: string): { fg: ColorUse[]; bg: ColorUse[] } {
  const fg: ColorUse[] = [];
  const bg: ColorUse[] = [];
  // color: / fg: / stroke: 视为前景；background / background-color / bg: 视为背景
  const scan = (re: RegExp, sink: ColorUse[]) => {
    for (const m of text.matchAll(re)) {
      const decl = m[0];
      RGBA.lastIndex = 0;
      const c = RGBA.exec(decl);
      if (!c) continue;
      sink.push({
        rgb: `${c[1]},${c[2]},${c[3]}`,
        alpha: c[4] === undefined ? 1 : Number(c[4]),
        index: m.index ?? 0,
      });
    }
  };
  scan(/(?:^|[\s{;,])(?:color|fg|text|iconColor|accent|stroke)\s*:\s*'?"?rgba?\([^)]*\)/gim, fg);
  scan(/(?:^|[\s{;,])(?:background(?:-color)?|bg)\s*:\s*'?"?rgba?\([^)]*\)/gim, bg);
  // hex 写法同样两类键各扫一遍：注册表里的 accent 普遍是 '#5eead4' 这种，不是 rgba()
  const scanHex = (re: RegExp, sink: ColorUse[]) => {
    for (const m of text.matchAll(re)) {
      HEXC.lastIndex = 0;
      const c = HEXC.exec(m[0]);
      if (!c) continue;
      const h = c[1];
      sink.push({
        rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(','),
        alpha: 1,
        index: m.index ?? 0,
      });
    }
  };
  scanHex(/(?:^|[\s{;,])(?:color|fg|text|iconColor|accent|stroke)\s*:\s*'?"?#[0-9a-fA-F]{6}\b/gim, fg);
  scanHex(/(?:^|[\s{;,])(?:background(?:-color)?|bg)\s*:\s*'?"?#[0-9a-fA-F]{6}\b/gim, bg);
  return { fg, bg };
}

const PAPER: [number, number, number] = [246, 244, 237];   // 浅色档页面底（暖纸）

const srgb = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const relLum = ([r, g, b]: number[]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

/** 找到与该前景同族、离它最近的那层淡底，合成到暖纸页底上，得到真实底色。 */
function bgTintOf(f: ColorUse, bgs: ColorUse[]): number[] | null {
  const fam = hueFamily(f.rgb);
  let best: ColorUse | null = null;
  for (const b of bgs) {
    if (b.alpha > 0.3 || hueFamily(b.rgb) !== fam) continue;
    if (Math.abs(b.index - f.index) > 400) continue;
    if (!best || Math.abs(b.index - f.index) < Math.abs(best.index - f.index)) best = b;
  }
  if (!best) return null;
  const t = best.rgb.split(',').map(Number);
  return t.map((c, i) => Math.round(c * best!.alpha + PAPER[i] * (1 - best!.alpha)));
}

function contrastOnTint(fg: number[], tint: number[] | null): number | null {
  return tint ? ratio(fg, tint) : null;
}

/**
 * 取 CSS 里某个声明所在规则的选择器（从该位置往回找最近的 `{`，再往回找上一条规则的边界）。
 *
 * 用途见下面的 `pinnedThemeScope`：判据把淡底合成到**暖纸页底**上算真账，
 * 而这个前提只对「跟随全局主题」的规则成立。写在 `[data-pa-theme="mountain"]`
 * 这类**钉死某一档主题**的选择器下的声明，底根本不是暖纸，合出来的比值是假的。
 */
function selectorAt(text: string, index: number): string {
  const open = text.lastIndexOf('{', index);
  if (open < 0) return '';
  const prev = Math.max(text.lastIndexOf('}', open), text.lastIndexOf(';', open), text.lastIndexOf('*/', open));
  return text.slice(prev + 1, open);
}

/**
 * 该声明是否写在「钉死主题」的作用域里。
 *
 * 只认属性选择器形态的主题钉死（`[data-theme=` / `[data-pa-theme=` / 任何
 * `[data-*-theme=`）与暗岛类 `.surface-tone-dark`。**基础规则一律照判**，
 * 豁免只落到这一条覆盖声明上 —— 这正是「豁免要窄到具体声明、不能整份文件放过」
 * 的要求（Codex 在 PR #1374 第七/二十二/三十一轮反复指同一件事）。
 *
 * 已知边界：按浅色档命名的覆盖（若将来出现）也会被一并豁免。目前仓库里
 * 钉死档全是深色（pa-agent 的 mountain、纸面页的 surface-tone-dark），暂不区分。
 */
function pinnedThemeScope(sel: string): boolean {
  return /\[data-(?:[a-z-]+-)?theme\s*=|\.surface-tone-dark/.test(sel);
}

/** 判据 A：同一色相，既当高不透明前景、又当低不透明背景，且在浅色档下够不到 4.5:1。 */
function findInlineViolations(text: string, isCss = false): { rgb: string; fgA: number; bgA: number; near: number }[] {
  const { fg, bg } = collect(text);
  const hits: { rgb: string; fgA: number; bgA: number; near: number }[] = [];
  for (const f of fg) {
    if (f.alpha < 0.7) continue;
    if (isCss && pinnedThemeScope(selectorAt(text, f.index))) continue;
    const ch = f.rgb.split(',').map(Number);
    // 无彩色（白/灰/slate，通道极差 < 40）不属于本判据：那是「白透明前景」另一类，
    // 归 themeHardcodeRatchet 管。混进来会让两条棘轮互相打架、数字也不再有意义。
    if (Math.max(...ch) - Math.min(...ch) < 40) continue;
    // 深色前景（600/700/800 档）压在同色淡底上是浅色主题的**正确**写法
    // （report-agent 的 buildStatusConfig(isLight) 分支就这么写），不能判红。
    // 但「深/浅」不能拍一个亮度阈值——purple-500 与 pink-500 的相对亮度落在 0.21~0.25，
    // 卡任何一个魔数都会漏掉它们。直接算真账：把淡底合成到暖纸页底上，
    // 再算前景对它的对比度，够 4.5:1 就是好写法，不够才是缺陷。
    const fgOk = contrastOnTint(ch, bgTintOf(f, bg));
    if (fgOk === null || fgOk >= 4.5) continue;
    const fam = hueFamily(f.rgb);
    if (!fam) continue;
    for (const b of bg) {
      if (b.alpha > 0.3 || hueFamily(b.rgb) !== fam) continue;
      // 同一个对象字面量/同一条规则里才算（400 字符窗口，跨组件的巧合不算）
      if (Math.abs(f.index - b.index) > 400) continue;
      hits.push({ rgb: f.rgb, fgA: f.alpha, bgA: b.alpha, near: f.index });
    }
  }
  return hits;
}

/** hue 名 → 是否同族。Tailwind 里 sky/blue、violet/purple/indigo 视觉上同族。 */
const HUE_FAMILY: Record<string, string> = {
  sky: 'blue', blue: 'blue', cyan: 'blue', indigo: 'violet', violet: 'violet', purple: 'violet',
  fuchsia: 'violet', emerald: 'green', green: 'green', teal: 'green', lime: 'green',
  amber: 'amber', yellow: 'amber', orange: 'amber', red: 'red', rose: 'red', pink: 'red',
};

/** 判据 B：className 串里 bg-<hue>-<shade>/<alpha≤30> 搭 text-<同族 hue>-<50~300>。 */
function findClassViolations(text: string): { cls: string; bg: string; fg: string }[] {
  const hits: { cls: string; bg: string; fg: string }[] = [];
  for (const m of text.matchAll(/(?:className|class)\s*=\s*[{"'`]([^"'`}]{0,600})/g)) {
    const cls = m[1];
    const bgM = cls.match(/\bbg-([a-z]+)-(\d{2,3})\/(\d{1,2})\b/);
    if (!bgM) continue;
    const fgM = cls.match(/\btext-([a-z]+)-(50|100|200|300)\b/);
    if (!fgM) continue;
    if (HUE_FAMILY[bgM[1]] !== HUE_FAMILY[fgM[1]]) continue;
    hits.push({ cls: cls.slice(0, 90), bg: `${bgM[1]}-${bgM[2]}/${bgM[3]}`, fg: `${fgM[1]}-${fgM[2]}` });
  }
  return hits;
}

/**
 * 判据 C：同一个变量既被拼成淡底（`${x}22` —— 两位十六进制 alpha 后缀），
 * 又被直接当字色（`color: x`）。
 *
 * 这是真实规模最大的那一次事故的形状：NOTIFICATION_TYPE_REGISTRY 的 accent
 * 一值两用 —— 当底色用 `${accent}22` 拼，两个主题都成立；直接当字色，浅色档
 * 只有 1.29:1。通知抽屉挂在 AppShell 上，全部 36 条路由都渲染，一处错 144 处糊。
 *
 * 判据 A/B 对它是瞎的：底是模板串不是颜色字面量，判据扫不到「淡底」这一半。
 * 补 hex、补 accent 键都救不了，必须单独认这个形状。
 *
 * 修法：拆字段 —— 拼接用的保持 hex，当字色的另起一个走 --accent-fg-* 的字段。
 */
function findDualUseViolations(text: string): { expr: string; alpha: string }[] {
  const hits: { expr: string; alpha: string }[] = [];
  const tinted = new Map<string, string>();
  // `${x}22` / `${x}1f`：两位十六进制 alpha ≤ 0x4d(30%) 才算「淡底」
  for (const m of text.matchAll(/\$\{([\w.]+)\}([0-9a-fA-F]{2})\b/g)) {
    if (parseInt(m[2], 16) <= 0x4d) tinted.set(m[1], m[2]);
  }
  if (!tinted.size) return hits;
  for (const m of text.matchAll(/\bcolor\s*:\s*([\w.]+)\b/g)) {
    const a = tinted.get(m[1]);
    if (a) hits.push({ expr: m[1], alpha: a });
  }
  return hits;
}

const BASELINE_PATH = path.join(HERE, 'sameHueTintBaseline.json');

describe('同色调浅底浅字棘轮（浅色主题最高频缺陷）', () => {
  it('不得新增「同色调淡底 + 同色调浅字」的配色', () => {
    const files = walk(SRC);
    const found: Record<string, number> = {};
    const detail: string[] = [];

    for (const file of files) {
      const rel = file.slice(SRC.length).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      /*
       * 显式按主题分支的文件跳过 —— 但判定必须**窄**。
       *
       * 第一版写成 /useDataTheme|isLight|data-theme/ 命中即跳过整个文件，
       * 结果 AppShell.tsx 因为注释里提到 data-theme、以及 removeAttribute('data-theme')
       * 就被整体排除 —— 而它正是这条守卫为之而建的那个文件（通知注册表 accent
       * 一值两用，36 条路由 × 4 处）。守卫把自己要守的目标排除在外，
       * 全仓共 48 个文件这样被静默跳过（Codex 在 PR #1374 第七轮抓到）。
       *
       * 现在只认三种「真的在按主题分支」的信号，且先剥掉注释再判：
       *   - useDataTheme( ：拿到了主题值
       *   - isLight 作为标识符：典型的分支变量
       *   - [data-theme= ：CSS 属性选择器写的双档
       * 只是提到字符串、或操作 DOM 属性，不算分支。
       */
      const codeOnly = text
        .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
        .replace(/(^|[^:])\/\/.*$/gm, '$1');  // 行注释（避开 http:// 这类）
      const branchesOnTheme = /useDataTheme\s*\(|\bisLight\b|\[data-theme=/.test(codeOnly);
      /*
       * 分支文件不再整份跳过 —— 只跳「前景是浅色档」的那些。
       *
       * 原来一律 continue，理由是分支文件的暗色档会写 300/400，静态判据分不出
       * 哪段给哪个主题。但这个豁免连**深色前景**一起放走了，而深色前景只可能是
       * 浅色档的值（暗底上没人用 700 档当字），完全判得动。
       * 实测代价：DailyLogPanel 的三档因此藏了整整一轮 ——
       * 沟通 orange-700 4.09、文档 green-700 4.00、Todo emerald-700 4.36，
       * 都在 4.5 以下（Codex 在 PR #1374 第二十二轮抓到，而我上一版还在
       * debt 里写「实测敞口为 0」，那句是错的）。
       *
       * 判据：前景相对亮度 < 0.30 就必须判。实测两类分得很开 ——
       * 浅色档的 700 档在 0.14~0.16，暗色档的 300 档在 0.52~0.58。
       */
      const isLightShadeFg = (rgb: string) => {
        const [r, g, b] = rgb.split(',').map(Number);
        return relLum([r, g, b]) >= 0.30;
      };
      /*
       * 三条判据一律扫 codeOnly（剥掉注释的源码），不扫 text。
       * 注释里写「原来这里是 `${x}15`」这种复盘说明会被判据当成真代码判红，
       * 于是「修好缺陷并写清为什么」反而让 CI 红 —— 那会逼后来人删掉说明
       * 而不是删掉缺陷。branchesOnTheme 早就这么做了，判据本身漏了。
       */
      const a = findInlineViolations(codeOnly, rel.endsWith('.css'))
        .filter((h) => !branchesOnTheme || !isLightShadeFg(h.rgb));
      // 判据 B 只匹配 50~300 档前景，那正是「暗色档的合法写法」本身，
      // 与判据 A 的亮度豁免是同一件事，分支文件继续放行。
      const b = branchesOnTheme ? [] : findClassViolations(codeOnly);
      /*
       * 判据 C 不吃主题豁免：一值两用是**与主题无关**的错。
       * 淡底由同一个值拼出来，两层永远同色调，无论哪个主题都糊 ——
       * 文件里恰好还有一处 isLight 分支，跟这个值成不成立没有半点关系。
       * 实测代价：StatsCardPanel 的五张统计卡因此藏了整整一轮 ——
       * card.color 既拼成 `${card.color}20` 当边框、又直接当 24px 大数字色，
       * 浅色档实测 1.62~2.56:1（大字需 3:1），而文件里的 isLight 分支
       * 管的是字体与引导条样式（Codex 在 PR #1374 第三十一轮抓到）。
       */
      const c = findDualUseViolations(codeOnly);
      const n = a.length + b.length + c.length;
      if (!n) continue;
      found[rel] = n;
      for (const h of a) detail.push(`${rel}: rgb(${h.rgb}) 同时当 ${h.fgA} 前景与 ${h.bgA} 背景`);
      for (const h of b) detail.push(`${rel}: bg-${h.bg} 配 text-${h.fg}`);
      for (const h of c) detail.push(`${rel}: ${h.expr} 既拼成 \`\${...}${h.alpha}\` 淡底又直接当字色`);
    }

    if (process.env.UPDATE_SAME_HUE_BASELINE) {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(found, null, 2)}\n`);
    }
    const baseline: Record<string, number> = fs.existsSync(BASELINE_PATH)
      ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
      : {};

    const violations = Object.entries(found)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: 由 ${baseline[f] ?? 0} 增至 ${n}`);

    expect(
      [
        violations.length
          ? '同色调棘轮拦截：新增了「淡底 + 同色调浅字」配色。\n'
            + '浅色主题下这两层会被暖纸底一起稀释，实测只有 1.4~2.1:1。\n'
            + '修法：底不动，字改走 tokens.css 里双写的 --accent-fg-*。\n'
            + '确属合法例外要提高基线，跑 UPDATE_SAME_HUE_BASELINE=1 并在 PR 说明。'
          : '',
        ...violations,
      ].filter(Boolean).join('\n'),
    ).toBe('');

    // 判据自检：三次真实事故的形状必须被这套判据认出来，否则判据本身是死的
    expect(findInlineViolations(
      "{ background: 'rgba(245,158,11,0.12)', color: 'rgba(245,158,11,0.95)' }",
    ).length).toBe(1);
    expect(findClassViolations(
      '<span className="bg-violet-500/30 border text-violet-100">x</span>',
    ).length).toBe(1);
    // 反向：底不淡（0.5）不算，字不浅（700 档）不算
    expect(findInlineViolations(
      "{ background: 'rgba(245,158,11,0.5)', color: 'rgba(245,158,11,0.95)' }",
    ).length).toBe(0);
    expect(findClassViolations(
      '<span className="bg-violet-500/30 text-violet-700">x</span>',
    ).length).toBe(0);
    // 海鲜市场那种「底 400 档 + 字 300 档」的同色相不同档，必须认出来
    expect(findInlineViolations(
      "{ bg: 'rgba(56,189,248,0.14)', text: 'rgba(125,211,252,0.98)' }",
    ).length).toBe(1);
    // 判据 C 自检：这就是 144 处那次的原样，必须认出来
    expect(findDualUseViolations(
      'style={{ background: `${variant.accent}22` }}\nstyle={{ color: variant.accent }}',
    ).length).toBe(1);
    // 拆成两个字段之后（拼接用 accent、字色用 fg），判据必须放行
    expect(findDualUseViolations(
      'style={{ background: `${variant.accent}22` }}\nstyle={{ color: variant.fg }}',
    ).length).toBe(0);
    // 深色前景压同色淡底 = 浅色主题的正确写法，判据不许把它当缺陷
    expect(findInlineViolations(
      "{ background: 'rgba(29,78,216,0.10)', color: 'rgba(29,78,216,1)' }",
    ).length).toBe(0);
  });
  /*
   * 零容忍：--accent-fg-* 不许再叠 alpha 后缀。
   *
   * 这一族 token 的浅色档是按「实色恰好压过 4.5:1」调出来的（700/800 档），
   * 暗色档同理。再叠一层不透明度就是直接把它拉回阈值以下：实测五色 × 双主题里
   * 最差的一档，alpha 0.85 是 4.53、0.8 就掉到 4.07、0.7 只有 3.35。
   *
   * 这个形状已经被抓两次：第一次剥掉 30 处（PR #1374 中途），漏网 46 处，
   * Codex 第十一轮拿 ProductsSection 的删除按钮（暗 3.54 / 浅 3.57）又抓一次。
   * 靠「记得手动剥干净」显然不成立，所以钉成恒为 0 的守卫 —— 判据是
   * 「删掉修复之后测试要变红」，这条满足。
   */
  it('--accent-fg-* 不得叠 alpha 后缀（叠了必然跌破 4.5:1）', () => {
    const ALPHA_SUFFIX = /text-\[color:var\(--accent-fg-[a-z-]+\)\]\/\d+/g;
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes('__tests__')) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(ALPHA_SUFFIX)) {
        hits.push(`${path.relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(hits.join('\n'), '这些地方给语义前景 token 叠了不透明度，实色本来就只是刚好达标').toBe('');
  });
});
