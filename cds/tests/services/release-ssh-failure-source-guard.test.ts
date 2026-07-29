import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫：SSH 非零退出 → Error.message 只能有一个构造源。
 *
 * 事故值（2026-07-29 扫出来的真实状态）：
 *   `new Error(\`ssh exec exit=${exitCode} stderr=${stderr.slice(0, 500)}\`)`
 * 这一份手拼同时存在于 **2 处**，各写各的：
 *   - release-service.ts 的 defaultReleaseSshExecutor
 *   - sidecar/sidecar-deployer.ts 的 private sshExec
 * 两处都犯同样三个错：丢 stdout（判据就在那儿）、取头不取尾、静默截断。
 *
 * 分裂的代价不是报错而是漏修：修好 release 侧之后，sidecar 侧照旧丢诊断，
 * 而且它连流式日志都没有，Error.message 是唯一通道。所以这里三件事一起钉：
 * 两个调用点都得在、旧写法不许复现、不许再冒出第三份头截断。
 *
 * 摘掉任一调用点 → 断言 A 红；改回 stderr.slice(0, 500) → 断言 B/C 红。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

/** 剥掉注释再扫，否则本文件与被扫文件里举的反面例子会把守卫自己绊倒。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const stack = [path.join(CDS_ROOT, relativeDir)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path.relative(CDS_ROOT, full));
    }
  }
  return out;
}

const CALL_SITES = [
  'src/services/release-service.ts',
  'src/services/sidecar/sidecar-deployer.ts',
];

describe('SSH 失败摘要判定源守卫', () => {
  it('断言 A：两个 SSH 执行器都必须走 formatSshExecFailure', () => {
    for (const relative of CALL_SITES) {
      const source = stripComments(read(relative));
      expect(source, `${relative} 必须调用 formatSshExecFailure 构造失败消息`)
        .toContain('formatSshExecFailure(');
    }
  });

  it('断言 B：src 下不许再出现 stderr.slice(0, N) 这种头截断', () => {
    const offenders = walk('src', ['.ts'])
      .filter((relative) => relative !== path.join('src', 'services', 'ssh-exec-failure.ts'))
      .filter((relative) => /stderr\s*\.\s*slice\(\s*0\s*,/.test(stripComments(read(relative))));
    expect(offenders, '失败摘要必须取尾且纳入 stdout，禁止再写第三份 stderr 头截断').toEqual([]);
  });

  it('断言 C：src 下不许再手拼 ssh exec exit= 消息', () => {
    const offenders = walk('src', ['.ts'])
      .filter((relative) => relative !== path.join('src', 'services', 'ssh-exec-failure.ts'))
      .filter((relative) => /new Error\(\s*`ssh exec exit=/.test(stripComments(read(relative))));
    expect(offenders, 'ssh exec 失败消息只能由 formatSshExecFailure 构造').toEqual([]);
  });
});
