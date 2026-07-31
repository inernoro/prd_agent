/**
 * Emoji 存量棘轮（Emoji Hardcode Ratchet）
 *
 * 背景（issue #1289）：CLAUDE.md §0 与 cds/CLAUDE.md §0 都规定「本系统任何项目
 * 一律不允许出现 emoji 字符」，但 cds/src 与 cds/web/src 里此前有约 45 处存量
 * emoji，且没有任何守卫拦截——新代码可以随手加一个 emoji 而不会有任何东西变红。
 *
 * 本测试把存量 emoji 变成棘轮：**每个文件的数量只许减、不许增**，不做一刀切
 * 清零（避免把一个聚焦 PR 变成跨 17 个文件的大扫除）。存量记录在
 * emojiHardcodeBaseline.json（只是债务台账，不是许可）；新代码一律零容忍，
 * 走文字标签或 SVG icon（见 CLAUDE.md §0 替代方案）。
 *
 * 统计口径见下方 EMOJI_RE：按 Unicode 区段覆盖真 emoji 与 dingbat，**排除**用于
 * 控制台横幅的制表/画框字符（═ ║ ╔ 等）与纯方向箭头（→ ← ↑ ↓ ↔ ⇒，项目里大量
 * 用于日志/注释画调用链，不是 emoji）与几何图形块。
 *
 * 对外可见输出（PR 评论模板 comment-template.ts、webhook 回帖
 * github-webhook.ts）已在 issue #1289 修复时清零，不在基线里——回归会被本测试拦住。
 *
 * 确属需要提高某文件基线的场景（不应该发生，emoji 只应该减少），运行：
 *   UPDATE_EMOJI_BASELINE=1 pnpm vitest run tests/services/emoji-hardcode-ratchet.test.ts
 * 并在 PR 里说明原因。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CDS_ROOT = path.resolve(TEST_DIR, '../..');
const BASELINE_PATH = path.join(TEST_DIR, 'emojiHardcodeBaseline.json');
const SCAN_ROOTS = ['src', 'web/src'];

/**
 * 真 emoji / dingbat 字符集，按 **区段** 而非逐字枚举：
 *  - U+1F000–1FAFF：麻将/骰子/扑克/带圈字母（🀄 🃏 🅰 🆗）+ 表情/交通/符号/
 *    补充符号与象形文字等 emoji 主力区块
 *  - U+2600–27BF：Misc Symbols + Dingbats（☀ ★ ⚠ ❤ ✨ ✅ ✔ ✓ ✕ ✖ ✗ ❌ ❗ ❓ ➜）
 *  - U+2B00–2BFF：Misc Symbols and Arrows（⭐ ⬛ ⬅ ⬆）
 *  - U+2139：Letterlike Symbols 里的 ℹ（信息图标，不在上面任何区段）
 * 尾随的 U+FE0F（variation selector）并入同一次匹配，`⚠️` 记 1 处而不是 2 处。
 *
 * 刻意不含方向箭头（→ ← ↑ ↓ ↔ ⇒，U+2190-21FF）、制表画框（═ ║ ╔，U+2500-257F）
 * 与几何图形块（U+25A0-25FF），这些在本项目里大量用于日志/注释画调用链，不是 emoji。
 *
 * 逐字枚举的旧口径漏过了整个 U+2600-27BF 区段——`ℹ`（github-webhook.ts 的 postReply）
 * 与 `★`（deploy-infra-resolver.ts 注释）都躲过了守卫，其中 `ℹ` 恰好落在下面那条
 * 「对外可见输出零 emoji」用例声称已清零的文件里。判据比它该管的范围窄，用例就会
 * 绿着放行它本该拦住的东西，所以这里改成按区段覆盖。
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2139}]\u{FE0F}?/gu;

function skipped(rel: string): boolean {
  return (
    rel.includes('/tests/') ||
    rel.includes('__tests__') ||
    rel.endsWith('.test.ts') ||
    rel.endsWith('.test.tsx') ||
    rel.includes('/dist/') ||
    rel.includes('/node_modules/')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scan(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(CDS_ROOT, root))) {
      const rel = file.slice(CDS_ROOT.length + 1).replace(/\\/g, '/');
      if (skipped(rel)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const count = content.match(EMOJI_RE)?.length ?? 0;
      if (count > 0) result[rel] = count;
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

describe('Emoji 存量棘轮（issue #1289）', () => {
  it('每个文件的 emoji 数量不得超过基线（只减不增）', () => {
    const current = scan();

    if (process.env.UPDATE_EMOJI_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      // 基线已重写；本次直接通过（重写行为要出现在 PR diff 里接受 review）
      return;
    }

    const baseline: Record<string, number> = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const violations: string[] = [];

    for (const [file, count] of Object.entries(current)) {
      const base = baseline[file] ?? 0;
      if (count > base) {
        violations.push(`${file}: emoji 数量由 ${base} 增至 ${count} —— 违反 CLAUDE.md §0，请改用文字标签或 SVG icon`);
      }
    }

    expect(
      violations,
      [
        '',
        'Emoji 棘轮拦截：新增了 emoji 字符。',
        '替代方案见 CLAUDE.md §0：状态/类型用 SVG icon 或文案分级，禁止 emoji 字面量。',
        '确属需要提高基线的场景，跑 UPDATE_EMOJI_BASELINE=1 vitest 并在 PR 说明原因。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('PR 评论模板与 webhook 回帖零 emoji（对外可见输出，issue #1289 已清零）', () => {
    const files = ['src/services/comment-template.ts', 'src/routes/github-webhook.ts'];
    const violations: string[] = [];
    for (const rel of files) {
      const content = fs.readFileSync(path.join(CDS_ROOT, rel), 'utf8');
      const count = content.match(EMOJI_RE)?.length ?? 0;
      if (count > 0) violations.push(`${rel}: 发现 ${count} 处 emoji`);
    }
    expect(violations).toEqual([]);
  });
});
