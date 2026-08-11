/**
 * 双皮肤硬编码棘轮（Theme Hardcode Ratchet）
 *
 * 背景（2026-07-12 用户：「做一个系统级的双皮肤，从根上解决这类问题」）：
 * tokens.css 的暗/浅双主题 token 早已齐备，问题始终出在组件绕过 token
 * 硬编码颜色——浅色主题下出现「白底浮暗卡」「白透明表面隐形」。
 *
 * 本测试把三类高危硬编码变成棘轮：**每个文件的数量只许减、不许增**。
 *  1. 白透明表面 rgba(255,255,255,x) —— 浅色下隐形/发灰
 *  2. 深色 hex 字面量（感知亮度 < 0.15）—— 浅色下变成漂浮的暗块
 *  3. 深色 rgba() 当背景用（感知亮度 < 0.15）—— 同 2，只是换了写法
 *
 * 判据扩宽的由来（2026-08-11，浅色 Toast 不可读）：
 * 原判据只认「白 rgba」与「深色 hex」，且 walk() 只收 .tsx。于是
 * lib/glassStyles.ts —— 全站浮层配色的唯一 SSOT —— 一次都没被扫过，
 * 它里面的 rgba(8,10,16,0.82) 既不是白 rgba 也不是 hex，两重漏网，
 * 浅色主题下 Toast 深底 + 深字不可读整整没人拦。
 * 对应 .claude/rules/predicate-and-wiring-discipline.md 形状 1（判据比该管的范围窄）。
 *
 * 存量违例记录在 themeHardcodeBaseline.json（只是债务台账，不是许可）；
 * 新增代码必须走 token（见 .claude/rules/admin-dual-theme.md 的修法映射表）。
 * 确属「暗色专用装饰」（如彩色渐变上的白字、暗色形态的专用皮肤对象）需要
 * 提高某文件基线时，运行：
 *   UPDATE_THEME_BASELINE=1 pnpm vitest run src/lib/__tests__/themeHardcodeRatchet.test.ts
 * 并在 PR 里说明原因。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, '../..');
const BASELINE_PATH = path.join(TEST_DIR, 'themeHardcodeBaseline.json');
const SEMANTIC_THEME_CONSUMERS = [
  'components/agent-shell/AgentCardArtwork.tsx',
  'pages/AgentLauncherPage.tsx',
  'pages/ai-toolbox/components/ToolCard.tsx',
  'styles/home-launcher.css',
  'styles/media-card.css',
] as const;

/** 白透明表面（浅色下隐形）。 */
const WHITE_ALPHA_RE = /rgba\(\s*255\s*,\s*255\s*,\s*255/g;
/** 全部 6 位 hex，再按感知亮度过滤出「深色」。 */
const HEX_RE = /#[0-9a-fA-F]{6}\b/g;
/** 任意 rgb/rgba，取三个通道判明暗。 */
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*[,)]/g;
/**
 * 「这一行在写背景」的上下文判据。
 * 只数背景色：阴影/描边/滤镜里的深色 rgba 在两个主题下都成立（投影本来就该是暗的），
 * 一刀切会把 467 处合法投影全打成违例，判据就废了。
 */
const BG_CONTEXT_RE = /background|backgroundColor|backgroundImage|bg-\[|--[a-z-]*bg[a-z-]*\s*:/i;
/** 阴影行整行豁免（boxShadow / textShadow / drop-shadow / --shadow-*）。 */
const SHADOW_LINE_RE = /shadow/i;

/** 感知亮度 < 0.15 视为深色（#101113 ≈ 0.07 命中；#14b8c4 ≈ 0.60 不命中）。 */
function isDark(r: number, g: number, b: number): boolean {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.15;
}

function isDarkHex(hex: string): boolean {
  return isDark(
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  );
}

/** 深色 rgba 被当作背景写死的处数（逐行判上下文）。 */
function countDarkRgbaBg(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    if (SHADOW_LINE_RE.test(line)) continue;
    if (!BG_CONTEXT_RE.test(line)) continue;
    for (const m of line.matchAll(RGB_RE)) {
      if (isDark(Number(m[1]), Number(m[2]), Number(m[3]))) count += 1;
    }
  }
  return count;
}

/** 跳过的目录/文件：测试、开发样板、mockup。 */
function skipped(rel: string): boolean {
  return (
    rel.includes('__tests__') ||
    rel.includes('/_dev/') ||
    rel.includes('/_mockup/') ||
    rel.endsWith('.test.tsx') ||
    rel.endsWith('.test.ts') ||
    rel.endsWith('.d.ts')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // .ts 也要扫：glassStyles.ts / appStoreTokens.ts 这类「配色 SSOT」都是 .ts，
    // 只扫 .tsx 等于放过影响面最大的那批文件。
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Counts {
  whiteAlpha: number;
  darkHex: number;
  darkRgbaBg: number;
}

function scan(): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const file of walk(SRC_DIR)) {
    const rel = file.slice(SRC_DIR.length).replace(/\\/g, '/');
    if (skipped(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const whiteAlpha = content.match(WHITE_ALPHA_RE)?.length ?? 0;
    const darkHex = (content.match(HEX_RE) ?? []).filter(isDarkHex).length;
    const darkRgbaBg = countDarkRgbaBg(content);
    if (whiteAlpha > 0 || darkHex > 0 || darkRgbaBg > 0) {
      result[rel] = { whiteAlpha, darkHex, darkRgbaBg };
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

describe('双皮肤硬编码棘轮（admin-dual-theme）', () => {
  it('每个文件的硬编码暗色/白透明数量不得超过基线（只减不增）', () => {
    const current = scan();

    if (process.env.UPDATE_THEME_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      // 基线已重写；本次直接通过（重写行为要出现在 PR diff 里接受 review）
      return;
    }

    const baseline: Record<string, Counts> = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const violations: string[] = [];

    for (const [file, counts] of Object.entries(current)) {
      const base = baseline[file] ?? { whiteAlpha: 0, darkHex: 0, darkRgbaBg: 0 };
      if (counts.whiteAlpha > base.whiteAlpha) {
        violations.push(
          `${file}: rgba(255,255,255,x) 由 ${base.whiteAlpha} 增至 ${counts.whiteAlpha} —— 浅色主题下会隐形。` +
            `请改用 token：面 var(--bg-card)/var(--bg-secondary)，边 var(--border-subtle)，字 var(--text-*)`,
        );
      }
      if (counts.darkHex > base.darkHex) {
        violations.push(
          `${file}: 深色 hex 字面量由 ${base.darkHex} 增至 ${counts.darkHex} —— 浅色主题下会变成漂浮暗块。` +
            `请改用 var(--bg-base)/var(--bg-elevated)/var(--panel-solid) 等语义 token，不要在组件里新增明暗分支`,
        );
      }
      if ((counts.darkRgbaBg ?? 0) > (base.darkRgbaBg ?? 0)) {
        violations.push(
          `${file}: 当背景用的深色 rgba() 由 ${base.darkRgbaBg ?? 0} 增至 ${counts.darkRgbaBg} —— ` +
            `与深色 hex 同罪，浅色主题下是漂浮暗块 / 深底深字。` +
            `请改用 var(--bg-card)/var(--panel-solid)/var(--glass-bg-start) 等语义 token；` +
            `确需浮层专用底色就在 tokens.css 双写一个新 token（参考 --toast-bg-base）`,
        );
      }
    }

    expect(
      violations,
      [
        '',
        '双皮肤棘轮拦截：新增了绕过主题 token 的硬编码颜色。',
        '修法映射见 .claude/rules/admin-dual-theme.md；',
        '确属暗色专用装饰需提高基线时，跑 UPDATE_THEME_BASELINE=1 vitest 并在 PR 说明。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('共享首页与图片卡只消费语义 token，不新增页面级明暗分支', () => {
    const violations = SEMANTIC_THEME_CONSUMERS.flatMap((relativePath) => {
      const content = fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf8');
      const reasons: string[] = [];
      if (/useDataTheme|useMobileThemeStore/.test(content)) reasons.push('读取主题状态');
      if (/\[data-theme=["']light["']\]/.test(content)) reasons.push('声明浅色选择器');
      if (/\bisLight\b|\bisDark\b/.test(content)) reasons.push('维护明暗布尔分支');
      return reasons.map((reason) => `${relativePath}: ${reason}`);
    });

    expect(violations).toEqual([]);
  });

  /**
   * 接线守卫：Toast 底层必须双写。
   * 删掉 tokens.css 的浅色 --toast-bg-base、或把 glassToast 改回写死深色，
   * 上面的棘轮**不会红**（棘轮只数增量，不看语义），所以这里单独钉一条。
   * 断言的是「浅色块里那个值真的是浅的」——值本身，不是某段字面量存在。
   */
  it('Toast 底层色在暗/浅两套主题各有定义，且浅色下真的是浅色', () => {
    const tokens = fs.readFileSync(path.join(SRC_DIR, 'styles/tokens.css'), 'utf8');

    /** 取某个选择器块里 --toast-bg-base 的**最后一次**定义（后写的赢）。 */
    const readToastBase = (selector: string): string | null => {
      const start = tokens.indexOf(`${selector} {`);
      if (start === -1) return null;
      const end = tokens.indexOf('\n}', start);
      const block = tokens.slice(start, end === -1 ? undefined : end);
      const hits = [...block.matchAll(/--toast-bg-base:\s*([^;]+);/g)];
      return hits.length ? hits[hits.length - 1][1].trim() : null;
    };

    /** 把 rgb/rgba/hex 求成感知亮度，判明暗（不认的写法直接判失败，防止悄悄换成 hsl/oklch 绕过）。 */
    const luminanceOf = (color: string): number => {
      const rgb = color.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
      if (rgb) {
        return (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255;
      }
      const hex = color.match(/#([0-9a-fA-F]{6})\b/);
      if (hex) {
        const v = hex[1];
        return (
          (0.2126 * parseInt(v.slice(0, 2), 16) +
            0.7152 * parseInt(v.slice(2, 4), 16) +
            0.0722 * parseInt(v.slice(4, 6), 16)) /
          255
        );
      }
      return Number.NaN;
    };

    const dark = readToastBase(':root');
    const light = readToastBase('[data-theme="light"]');

    expect(dark, ':root 缺少 --toast-bg-base').not.toBeNull();
    expect(light, '[data-theme="light"] 缺少 --toast-bg-base —— 浅色主题下 Toast 会回到深底深字不可读').not.toBeNull();
    expect(luminanceOf(dark as string), `:root 的 --toast-bg-base 必须是深色，当前 ${dark}`).toBeLessThan(0.2);
    expect(
      luminanceOf(light as string),
      `[data-theme="light"] 的 --toast-bg-base 必须是浅色，当前 ${light}`,
    ).toBeGreaterThan(0.7);

    // 语义前景（图标 / 动作按钮文字）同样双写：浅色档必须比暗色档更深，
    // 否则 500 档饱和色落在暖纸底上不到 3:1。
    for (const kind of ['success', 'error', 'info', 'warning'] as const) {
      const readAccent = (selector: string) => {
        const start = tokens.indexOf(`${selector} {`);
        const end = tokens.indexOf('\n}', start);
        const block = tokens.slice(start, end === -1 ? undefined : end);
        const hits = [...block.matchAll(new RegExp(`--toast-accent-${kind}:\\s*([^;]+);`, 'g'))];
        return hits.length ? hits[hits.length - 1][1].trim() : null;
      };
      const darkAccent = readAccent(':root');
      const lightAccent = readAccent('[data-theme="light"]');
      expect(darkAccent, `:root 缺少 --toast-accent-${kind}`).not.toBeNull();
      expect(lightAccent, `[data-theme="light"] 缺少 --toast-accent-${kind}`).not.toBeNull();
      expect(
        luminanceOf(lightAccent as string),
        `--toast-accent-${kind} 浅色档(${lightAccent})必须比暗色档(${darkAccent})更深，否则浅色 Toast 上看不清`,
      ).toBeLessThan(luminanceOf(darkAccent as string));
    }

    // glassToast 必须消费这个 token，而不是自己写死一层底。
    const glass = fs.readFileSync(path.join(SRC_DIR, 'lib/glassStyles.ts'), 'utf8');
    const toastFn = glass.slice(glass.indexOf('export const glassToast'), glass.indexOf('export const glassBadge'));
    expect(toastFn).toContain('var(--toast-bg-base)');
    expect(
      countDarkRgbaBg(toastFn),
      'glassToast 又写死了深色背景 rgba —— 浅色主题下会复发「深底深字」',
    ).toBe(0);
  });

  it('移动端百宝箱图片卡标题跟随媒体文字 token', () => {
    const content = fs.readFileSync(
      path.join(SRC_DIR, 'pages/ai-toolbox/MobileToolboxView.tsx'),
      'utf8',
    );
    const agentCard = content.slice(
      content.indexOf('function AgentCard('),
      content.indexOf('/* ─────────── 空状态'),
    );

    expect(agentCard).toContain("color: hasArtwork ? 'var(--text-on-media)' : '#fff'");
    expect(agentCard).not.toMatch(/useDataTheme|\bconst light\b|\bisLight\b|\bisDark\b/);
  });
});
