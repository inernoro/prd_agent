/**
 * cjs-named-import-guard.test.ts — CommonJS 依赖禁止静态具名导入。
 *
 * 2026-07-29 的真实事故：`remote-host-service.ts` 写了
 *
 *     import { utils as ssh2Utils } from 'ssh2';
 *
 * 结果是：
 *   - `tsc --noEmit` 零错误（TS 只看类型声明，不管运行时模块格式）
 *   - `vitest run` 4568 条全绿（vite 自己做 CJS interop，测试里根本复现不了）
 *   - 部署后容器起不来：Node 加载真 ESM 产物时抛
 *     `SyntaxError: Named export 'utils' not found`
 *
 * 三道关全过、线上直接挂，是本仓库最贵的一类 bug。所以判据不能靠人记，
 * 得有一条扫源码的守卫：CJS 依赖一律走默认导入（`import ssh2 from 'ssh2'`）
 * 或动态 `await import()` + `mod.x || mod.default?.x`（release-service.ts 的既有写法）。
 *
 * 新增 CJS 依赖时把包名加进 CJS_ONLY_MODULES。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../../src');

/** 只发布 CommonJS 的依赖。具名导入它们 = 运行时炸。 */
const CJS_ONLY_MODULES = ['ssh2'];

/**
 * 去掉注释行再扫。
 *
 * 第一版直接扫原文，结果把 remote-host-service.ts 里那句「不能这么写」的**反例注释**
 * 也算成违规——守卫在正确代码上恒红，等于逼后来人删掉解释性注释来讨好测试。
 * 判据必须只看真正会被执行的代码。
 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('CommonJS 依赖的导入方式', () => {
  const files = walk(srcRoot);

  it('src 下有文件可扫（守卫本身没有空跑）', () => {
    // 没有这条断言，walk 一旦因为路径变更返回空数组，下面的检查会变成
    // 「零个文件全部合规」的假绿——正是本规则要防的那种测试。
    expect(files.length).toBeGreaterThan(50);
  });

  for (const moduleName of CJS_ONLY_MODULES) {
    it(`没有任何文件对 ${moduleName} 使用静态具名导入`, () => {
      // 匹配 `import { x } from 'ssh2'` / `import {x as y} from "ssh2"`，
      // 放过 `import ssh2 from 'ssh2'`、`import type {...}`、`await import('ssh2')`。
      const pattern = new RegExp(
        String.raw`import\s+(?!type\s)\{[^}]*\}\s*from\s*['"]${moduleName}['"]`,
      );
      const offenders = files
        .filter((file) => pattern.test(stripComments(fs.readFileSync(file, 'utf8'))))
        .map((file) => path.relative(srcRoot, file));

      expect(offenders, [
        `${offenders.join(', ')} 对 CommonJS 依赖 ${moduleName} 使用了静态具名导入。`,
        `tsc 与 vitest 都不会报错，但 Node 加载 ESM 产物时会抛 Named export not found，容器起不来。`,
        `改成 import ${moduleName} from '${moduleName}' 再取属性，或走动态 import + default 兜底。`,
      ].join('\n')).toEqual([]);
    });
  }
});
