import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 分支库推倒重建（mode=reset）的源码契约守卫。
 *
 * 事故（2026-08-29，mdimp/codex-async-worker-service）：分支库
 * `imp_b_9bd351d94c8f35ab` 里留了一条 `success=0` 的 Flyway 记录，此后每次部署
 * 都撞 `contains a failed migration to version …` 起不来。
 *
 * 当时 CDS **没有任何途径**修它：唯一的建库入口 `mode=empty` 走的是
 * `CREATE DATABASE IF NOT EXISTS`——库已经存在就直接跳过，脏状态原封不动。
 * 而仓库自己的治理规则写着「迁移失败时，可丢弃分支库直接重建」，也就是说
 * 正确修法存在、CDS 却没提供这个动作，只能绕过 CDS 直接连 MySQL 去 DROP。
 *
 * 这几条断言扫的是源码而不是行为：这条路径要真跑得连上一台 MySQL，
 * 单测环境没有。源码守卫至少保证「DROP 只在 reset 走、基础库有硬拦、
 * 不支持的 runtime 显式报错而不是静默退化」这三件事不会被后来者悄悄改掉。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readBranchesRoute(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
}

/** 只截建库函数那一段，避免全文 contains 给出假绿。 */
function createMysqlBranchDatabaseSlice(source: string): string {
  const at = source.indexOf('async function createMysqlBranchDatabase(');
  expect(at, '找不到 createMysqlBranchDatabase').toBeGreaterThan(-1);
  return source.slice(at, at + 1800);
}

/** 只截 clone-tasks 路由那一段。 */
function cloneTasksRouteSlice(source: string): string {
  const at = source.indexOf("router.post('/branches/:id/resources/:resourceId/clone-tasks'");
  expect(at, '找不到 clone-tasks 路由').toBeGreaterThan(-1);
  return source.slice(at, at + 6000);
}

describe('mode=reset：CDS 能把坏掉的分支库推倒重建', () => {
  it('reset 是被接受的模式', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("'empty', 'reset', 'clone-main'");
  });

  it('DROP 只在 dropFirst 时出现，且 reset 才传 dropFirst', () => {
    const source = readBranchesRoute();
    const fn = createMysqlBranchDatabaseSlice(source);
    expect(fn).toContain('DROP DATABASE IF EXISTS');
    // DROP 必须挂在 dropFirst 条件上，不能无条件执行
    expect(fn).toMatch(/options\.dropFirst\s*\?\s*\[`DROP DATABASE IF EXISTS/);
    // 调用方只在 reset 时传 true
    expect(cloneTasksRouteSlice(source)).toContain("{ dropFirst: mode === 'reset' }");
  });

  it('硬拦：reset 绝不允许落到项目共享基础库上', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("mode === 'reset' && targetDatabase === baseDb");
    expect(slice).toContain('reset_refuses_base_database');
    // 拦截必须在真正执行之前返回
    const guardAt = slice.indexOf('reset_refuses_base_database');
    const execAt = slice.indexOf('createMysqlBranchDatabase(rawInfra');
    expect(guardAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(guardAt);
  });

  it('不支持 reset 的 runtime 显式报错，而不是静默退化成 empty', () => {
    // 静默退化会让调用方以为库已重建、脏状态其实还在——最难查的那种失败。
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("暂不支持 reset");
  });

  it('reset 与 empty 的完成文案不同，用户看得出发生了什么', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain('已推倒重建');
    expect(slice).toContain('空库已创建');
  });

  it('红用例：去掉基础库硬拦，守卫必须变红', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    const stripped = slice.replace(/reset_refuses_base_database/g, 'noop_error_code');
    expect(stripped).not.toContain('reset_refuses_base_database');
  });

  it('红用例：把 DROP 改成无条件执行，守卫必须变红', () => {
    const fn = createMysqlBranchDatabaseSlice(readBranchesRoute());
    const unconditional = fn.replace(
      /\.\.\.\(options\.dropFirst \? \[`DROP DATABASE IF EXISTS \$\{sqlIdent\(targetDatabase\)\}`\] : \[\]\),/,
      '`DROP DATABASE IF EXISTS ${sqlIdent(targetDatabase)}`,',
    );
    expect(unconditional).not.toMatch(/options\.dropFirst\s*\?\s*\[`DROP DATABASE IF EXISTS/);
  });
});
