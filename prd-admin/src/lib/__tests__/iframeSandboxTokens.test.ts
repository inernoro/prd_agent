import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * iframe 的 `sandbox` 属性只认规范里定义的那几个 token，写错的会被浏览器整条忽略并报
 * `Error while parsing the 'sandbox' attribute: 'xxx' is an invalid sandbox flag.`
 *
 * 这类错写不会让编译失败、不会让任何测试变红、页面也照常渲染（其余合法 token 仍生效），
 * 唯一的痕迹是控制台里一行红字 —— 于是它能活很久：分享页的 `allow-fullscreen`
 * （全屏归 `allow="fullscreen"` 的 Permissions Policy 管，根本不是 sandbox 的取值）
 * 就是用户在控制台里发现的，在那之前谁都以为 deck 的全屏按钮已经能用了。
 *
 * 判据扫的是**源码字面量**，只对得起「写死在 JSX 里的 sandbox 值」这一种形态；
 * 运行时拼出来的值扫不到，所以拼装的基座（previewHtml.ts 的两个常量）本身也是字面量、
 * 一样被这条守卫覆盖。见 .claude/rules/predicate-and-wiring-discipline.md 形状 6。
 */

/** https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox */
const VALID_SANDBOX_FLAGS = new Set([
  'allow-downloads',
  'allow-forms',
  'allow-modals',
  'allow-orientation-lock',
  'allow-pointer-lock',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-presentation',
  'allow-same-origin',
  'allow-scripts',
  'allow-storage-access-by-user-activation',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-top-navigation-to-custom-protocols',
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../..');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * 抓两种写法：JSX 上的 `sandbox="..."` 和常量里的 `SANDBOX = '...'`。
 * 都要求值是纯字面量——带 `${}` 的模板拼装留给它的组成部分去管。
 */
const PATTERNS = [
  /\bsandbox\s*=\s*"([^"$]*)"/g,
  /\bsandbox\s*=\s*'([^'$]*)'/g,
  /SANDBOX\s*=\s*['"]([^'"$]*)['"]/g,
];

describe('iframe sandbox 字面量', () => {
  it('只能使用规范定义的 flag（写错的会被浏览器整条忽略，且只在控制台留一行红字）', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC_ROOT)) {
      // 守卫自身列举了合法 flag，扫自己必然自证，跳过
      if (file === path.join(HERE, 'iframeSandboxTokens.test.ts')) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(source)) !== null) {
          for (const token of m[1].trim().split(/\s+/).filter(Boolean)) {
            if (!VALID_SANDBOX_FLAGS.has(token)) {
              offenders.push(`${path.relative(SRC_ROOT, file)}: "${token}"`);
            }
          }
        }
      }
    }

    expect(offenders, `非法 sandbox flag（全屏请用 allow="fullscreen"，不是 sandbox 的取值）：\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('自身能认出非法 flag（红绿闭环：判据不是恒真）', () => {
    const parsed = 'allow-scripts allow-fullscreen'.split(/\s+/);
    expect(parsed.filter((t) => !VALID_SANDBOX_FLAGS.has(t))).toEqual(['allow-fullscreen']);
  });
});
