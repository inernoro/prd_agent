/**
 * Guard: 源码里不许出现**字面** NUL 字节（U+0000）。
 *
 * 为什么值得一条专门的守卫：写复合键时很容易顺手把 NUL 当分隔符敲进模板字符串
 * （`` `${a}\0${b}` `` 的字面版本）。功能上它工作得很好，但 git 会因为这个字节
 * 把整个 .ts 判定为 binary —— 从此该文件的 diff、blame、PR review 全部瞎掉，
 * 评审者只看得到 "Binary files differ"。
 *
 * 这个坑在本仓库连踩三次（service-graph.ts、image-retention.ts、replica-set.ts），
 * 每次都是同一个人、同一种写法、同一轮才被发现。修法一律是改成转义写法
 * `\u0000`：运行时完全等价，文件仍是纯文本。
 *
 * 扫描 src/ 与 tests/ 全部 .ts。二进制 fixture 若将来需要，请放到独立目录并在
 * SKIP_DIRS 里登记，而不是放宽本规则。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('源码不含字面 NUL 字节', () => {
  it('没有文件会被 git 误判成 binary', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const buf = readFileSync(file);
        const at = buf.indexOf(0);
        if (at !== -1) {
          const line = buf.subarray(0, at).toString('utf8').split('\n').length;
          offenders.push(`${file.slice(ROOT.length + 1)}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `以下文件含字面 NUL 字节，git 会把它们当成 binary（diff/blame/review 全瞎）。\n`
      + `改成转义写法 \\u0000，运行时等价、文件仍是纯文本：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
