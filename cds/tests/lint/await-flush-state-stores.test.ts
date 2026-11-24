/**
 * await-flush-state-stores.test.ts — 收尾清目录之前，落盘必须已经落完。
 *
 * 2026-09-04 的真实失败：`tests/routes/identity.test.ts` 的 afterEach 是
 *
 *     flushAllJsonStateStores();          // 少了 await
 *     fs.rmSync(tmp, { recursive: true, force: true });
 *
 * `flushAllJsonStateStores` 是 async 的，不 await 就等于没等：写盘还在飞，
 * rmSync 已经在走目录，于是 CI 上报 `ENOTEMPTY: directory not empty`。
 * 同一次运行的日志里还刷了几十条 `[state] async state.json write failed: ENOENT`
 * ——那都是写落到已经被删掉的临时目录上，长期被当成噪音。
 *
 * 为什么必须有守卫而不是「改完记住」：漏掉 await 之后，测试**大多数时候照样绿**
 * （竞态要写盘恰好慢过 rmSync 才翻车），全量跑一次看不出来，人也审不出来。
 * 判据得机器来判：`cds/tests` 里每一处调用都必须带 await。
 *
 * 当时全仓 96 处调用，86 处已经 await、10 处漏了——占多数的那个写法本来就是对的，
 * 这条守卫只是把它钉死。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('flushAllJsonStateStores 必须 await', () => {
  it('cds/tests 里没有漏掉 await 的调用', () => {
    const offenders: string[] = [];
    let seen = 0;

    for (const file of walk(TESTS_ROOT)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        // 只看真的调用，不看 import / 注释里提到的名字
        if (!/\bflushAllJsonStateStores\s*\(/.test(line)) return;
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/^\s*import\b/.test(line)) return;
        seen += 1;
        if (!/\bawait\s+flushAllJsonStateStores\s*\(/.test(line)) {
          offenders.push(`${path.relative(TESTS_ROOT, file)}:${idx + 1}`);
        }
      });
    }

    // 一处都没扫到 = 守卫空转（函数改名了却没人发现），比漏判更糟。
    expect(seen).toBeGreaterThan(20);
    expect(
      offenders,
      '这几处 flushAllJsonStateStores 没 await：写盘还在飞，收尾的 rmSync 会撞 ENOTEMPTY，'
        + '而且大多数时候照样绿，只在 CI 上偶发翻车',
    ).toEqual([]);
  });
});
