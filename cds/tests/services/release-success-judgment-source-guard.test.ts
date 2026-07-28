import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isReleaseRunTerminal, isSuccessfulReleaseRun } from '../../src/services/release-retention.js';
import type { ReleaseRunStatus } from '../../src/types.js';

/**
 * 「防再修一边」守卫：什么算「一次成功的发布」只能有一个判定源。
 *
 * 事故值（本轮验收扫出来的真实状态）：`run.status === 'success' || run.status === 'rollback_success'`
 * 这一条判定同时存在于 **4 处**，各写各的：
 *   - release-retention.ts 的 isSuccessfulReleaseRun（保留策略靠它决定「谁绝不能删」）
 *   - routes/releases.ts:652 的 successfulRuns 过滤（发布中心版本下拉靠它决定「用户能选谁」）
 *   - routes/releases.ts:655 的 ['success','rollback_success'].includes(latest.status)
 *   - release-service.ts:789 的同款 includes（回滚时校验「只能回滚到成功版本」）
 *   外加 release-dora.ts 的 RECOVERY_STATUSES 字面量 Set（恢复时长的配对判据）。
 *
 * 分裂的代价是错位而不是报错：保留策略保住 20 条、下拉展示 20 条，两边口径一旦漂移，
 * 用户会看到「下拉里明明有这个版本，点下去说没有可回滚的上一版本」。而新增一个
 * ReleaseRunStatus 时，穷尽 Record 那份会编译期报错，字面量数组那几份只会静默漏算。
 *
 * 所以这里两件事一起钉：常量只定义一次 + 字面量写法不许再出现。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

/** 剥掉注释再扫，否则本文件说明里举的反面例子会把守卫自己绊倒。 */
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

/**
 * 允许出现成功状态字面量组合的文件。
 *   - release-retention.ts：判定源本身；
 *   - release-events.ts：status → 事件名的映射表，是另一件事（每个状态一个事件名），
 *     不是「是否成功」的判定；
 *   - deploy-drain.ts：排空用的终态穷尽 Record，同样是全状态表不是成功判定。
 * 新增豁免必须写明它为什么不是「成功判定」的第二份拷贝。
 */
const ALLOWED_STATUS_TABLE_FILES = [
  'src/services/release-retention.ts',
  'src/services/release-events.ts',
  'src/services/deploy-drain.ts',
];

describe('发布成功判定只有一个源', () => {
  it('isSuccessfulReleaseRun 只在 release-retention.ts 定义一次', () => {
    const definitions = walk('src', ['.ts'])
      .filter((file) => /export function isSuccessfulReleaseRun\b/.test(read(file)));

    expect(definitions).toEqual(['src/services/release-retention.ts']);
  });

  it('没有第二处把 success / rollback_success 拼成自己的成功判定', () => {
    const offenders = walk('src', ['.ts'])
      .filter((file) => !ALLOWED_STATUS_TABLE_FILES.includes(file))
      .filter((file) => {
        const source = stripComments(read(file));
        // 事故写法一：['success', 'rollback_success'].includes(...)
        const literalArray = /\[\s*'success'\s*,\s*'rollback_success'\s*\]/.test(source);
        // 事故写法二：run.status === 'success' || run.status === 'rollback_success'
        const orChain = /===\s*'success'\s*\|\|[^\n]*===\s*'rollback_success'/.test(source);
        return literalArray || orChain;
      });

    expect(offenders).toEqual([]);
  });

  it('回滚校验与版本下拉都走同一个判定函数', () => {
    expect(stripComments(read('src/services/release-service.ts')))
      .toContain('isSuccessfulReleaseRun(previous)');
    const routes = stripComments(read('src/routes/releases.ts'));
    expect(routes).toContain('targetRuns.filter(isSuccessfulReleaseRun)');
    // 下拉条数也必须读常量：它和保留策略保住的条数是同一件事。
    expect(routes).toContain('successfulRuns.slice(0, KEEP_SUCCESSFUL_RELEASE_RUNS)');
    expect(routes).not.toMatch(/successfulRuns\.slice\(\s*0\s*,\s*\d/);
  });

  it('DORA 的终态 / 恢复判定借的是同一份，不是自己的字面量 Set', () => {
    const source = stripComments(read('src/services/release-dora.ts'));
    expect(source).toContain('isReleaseRunTerminal(');
    expect(source).toContain('isSuccessfulReleaseRun(');
    expect(source).not.toMatch(/new Set\(\[\s*'success'/);
  });

  /**
   * 行为侧兜底：穷尽 Record 的两个判定必须对全部状态给出一致答案。
   * 光扫源码挡不住「有人把 isSuccessfulReleaseRun 的实现改坏」。
   */
  it('成功状态一定是终态（成功却非终态 = 保留策略会把它当在途永久保护）', () => {
    const all: ReleaseRunStatus[] = [
      'queued', 'running', 'healthchecking', 'rollback_running',
      'success', 'failed', 'rollback_success', 'rollback_failed',
    ];
    const successful = all.filter((status) => isSuccessfulReleaseRun({ status }));

    expect(successful).toEqual(['success', 'rollback_success']);
    for (const status of successful) expect(isReleaseRunTerminal(status)).toBe(true);
  });
});
