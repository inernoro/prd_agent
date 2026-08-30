import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

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

/**
 * 只截 clone-tasks 路由那一段，避免全文 contains 给出假绿。
 *
 * 边界取「下一个 router.<method>( 声明」而不是一个魔数长度：2026-08-30 这段
 * 路由加了权限档位与白名单之后长了约 40 行，原来写死的 6000 字符窗口把断言要找的
 * 内容切在了外面，四条用例一起变红——**判据自己漂了**，而不是被守的东西坏了。
 * 一个会因为无关改动而误报的守卫，和一个不会红的守卫一样不可信。
 */
function cloneTasksRouteSlice(source: string): string {
  const at = source.indexOf("router.post('/branches/:id/resources/:resourceId/clone-tasks'");
  expect(at, '找不到 clone-tasks 路由').toBeGreaterThan(-1);
  const nextRoute = source.slice(at + 1).search(/\n {2}router\.(get|post|put|patch|delete)\(/);
  const end = nextRoute === -1 ? source.length : at + 1 + nextRoute;
  const slice = source.slice(at, end);
  // 切片必须真的覆盖到这条路由的执行体，否则后面的断言是在半截文本上找东西。
  expect(slice, 'clone-tasks 切片没覆盖到执行体').toContain('createMysqlBranchDatabase(rawInfra');
  return slice;
}

/**
 * 截出「所有权白名单 + 默认目标」那一段，并**只保留代码行**。
 *
 * 注释里会正当地写出 `baseDb`（解释为什么不能用它），把散文算进判据就会误报——
 * 判据要判的是代码在读什么，不是文档在说什么。
 */
function ownershipCodeOnly(source: string): string {
  const slice = cloneTasksRouteSlice(source);
  const from = slice.indexOf('const ownedFromLedger');
  const to = slice.indexOf('const targetDatabase');
  expect(from, '找不到所有权白名单起点').toBeGreaterThan(-1);
  expect(to, '找不到 targetDatabase').toBeGreaterThan(from);
  // 结束于 defaultTarget 的**非 reset 分支**：那一支正当地用 baseDb（其余 mode 就是
  // 「按当前绑定库派生一个新分支库」），不属于本判据要管的范围。
  const nonResetArm = slice.indexOf(': branchDatabaseName(baseDb, branch);', from);
  expect(nonResetArm, '找不到 defaultTarget 的非 reset 分支').toBeGreaterThan(from);
  expect(nonResetArm).toBeLessThan(to);
  return slice.slice(from, nonResetArm)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
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

  /**
   * Codex 在 PR #1453 的 P1：reset 走 `cloneAction` 的 fallback 落到 `database-clone`，
   * 只要 developer；而破坏性更弱的 `data-clear`（清表数据）要求 admin。
   * DROP DATABASE 比清数据更狠，门槛却更低——权限档位反了。
   */
  it('reset 必须走 admin 档权限，不得落到 developer 档的 database-clone', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("mode === 'reset'\n          ? 'data-clear'");
    // data-clear 在权限表里确实是 admin 档，否则上面那行等于没提权
    const source = readBranchesRoute();
    const at = source.indexOf('function requiredResourceRole(');
    expect(at, '找不到 requiredResourceRole').toBeGreaterThan(-1);
    const roleFn = source.slice(at, at + 700);
    expect(roleFn).toContain("action === 'data-clear'");
    expect(roleFn).toContain("return 'admin'");
  });

  it('红用例：把 reset 放回 database-clone，守卫必须变红', () => {
    const guard = (source: string) => {
      expect(cloneTasksRouteSlice(source)).toContain("mode === 'reset'\n          ? 'data-clear'");
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, "mode === 'reset'\n          ? 'data-clear'", "mode === 'reset'\n          ? 'database-clone'"),
    );
  });

  /**
   * Codex 在 PR #1453 的另一条 P1：只排除基础库是黑名单思路，
   * targetDatabase 来自请求体，排掉基础库之后**兄弟分支预览的库**照样能被
   * root 权限的建库助手 DROP 掉。必须改成白名单。
   */
  it('白名单：reset 只允许落到本分支拥有的库', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain('branchOwnedDatabases');
    expect(slice).toContain('reset_refuses_foreign_database');
    expect(slice).toContain('!branchOwnedDatabases.has(targetDatabase)');
    // 白名单只许由「CDS 能证明的事实」构成：可复算的命名规则 + CDS 自己写的建库台账。
    expect(slice).toContain('[branchDatabaseName(projectBaseDb, branch), ...ownedFromLedger]');
    expect(slice).toContain("listResourceCloneTasks({ projectId, branchId: branch.id, resourceId })");
    expect(slice).toContain("t.status === 'completed'");
  });

  it('reset 的默认目标来自台账，不叠分支后缀也不读可变 env', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain('ownedFromLedger[ownedFromLedger.length - 1]');
  });

  /**
   * Codex 在 PR #1454 的 P1：白名单原本含 baseDb，而它来自分支 scope 的
   * MYSQL_DATABASE——**可变**的项目配置。那个值被手工改过或过期指向兄弟分支的库时，
   * 白名单会把别人的库认成「本分支拥有」，reset 用 root 凭据 DROP 掉。
   * 护栏被自己的取值来源绕开了。所有权必须从不可变记录推导。
   */
  it('白名单与默认目标都不得读分支 scope 的可变 env', () => {
    // 只看代码行：注释里正当地解释了「为什么不用 baseDb」，把散文算进判据会误报。
    expect(ownershipCodeOnly(readBranchesRoute()), '白名单/默认目标的代码里不该出现 baseDb')
      .not.toContain('baseDb');
  });

  it('红用例：把 baseDb 放回白名单，守卫必须变红', () => {
    const guard = (source: string) => {
      expect(ownershipCodeOnly(source)).not.toContain('baseDb');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, '[branchDatabaseName(projectBaseDb, branch), ...ownedFromLedger]', '[baseDb, branchDatabaseName(projectBaseDb, branch), ...ownedFromLedger]'),
    );
  });

  it('红用例：白名单拿掉后守卫必须变红', () => {
    const guard = (source: string) => {
      const slice = cloneTasksRouteSlice(source);
      expect(slice).toContain('reset_refuses_foreign_database');
      expect(slice).toContain('!branchOwnedDatabases.has(targetDatabase)');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(guard, real, mutate(real, 'reset_refuses_foreign_database', 'noop_code'));
  });

  it('硬拦：reset 绝不允许落到项目共享基础库上', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain('targetDatabase === projectBaseDb');
    expect(slice).toContain('reset_refuses_base_database');
    // 拦截必须在真正执行之前返回
    const guardAt = slice.indexOf('reset_refuses_base_database');
    const execAt = slice.indexOf('createMysqlBranchDatabase(rawInfra');
    expect(guardAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(guardAt);
  });

  /**
   * 2026-08-30 线上实测撞到：第一版判据写的是 `targetDatabase === baseDb`，
   * 而 baseDb 来自 `resourceDatabaseForRuntime` → `mysqlDatabaseForBranch`，
   * 它**分支 scope 优先**，分支库建好之后那里存的就是 `imp_b_<token>` 本身。
   * 于是 target === base 恒成立，reset 被自己永久挡死；反过来若某分支 scope
   * 指回共享库，判据又会放行 DROP。判据取的值不是它要判的那个事实（形状 6）。
   *
   * 这两条守卫锁住修法：基础库判据必须走不看分支 scope 的项目级解析函数。
   */
  it('基础库判据必须走项目级解析，不得读分支 scope', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('function projectBaseDatabaseForRuntime(');
    expect(at, '找不到 projectBaseDatabaseForRuntime').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 1600);
    // 项目级解析：resolvedInfraEnv 不许传 branch，也不许碰 getCustomEnvScope
    expect(fn).toContain('resolvedInfraEnv(service)');
    expect(fn).not.toContain('getCustomEnvScope');
    expect(fn).not.toContain('ForBranch(');
  });

  it('红用例：把判据改回分支感知的 baseDb，守卫必须变红', () => {
    const guard = (source: string) => {
      expect(cloneTasksRouteSlice(source)).toContain('targetDatabase === projectBaseDb');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(guard, real, mutate(real, 'targetDatabase === projectBaseDb', 'targetDatabase === baseDb'));
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
    const guard = (source: string) => {
      expect(cloneTasksRouteSlice(source)).toContain('reset_refuses_base_database');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(guard, real, mutate(real, 'reset_refuses_base_database', 'noop_error_code'));
  });

  it('红用例：把 DROP 改成无条件执行，守卫必须变红', () => {
    const guard = (source: string) => {
      expect(createMysqlBranchDatabaseSlice(source)).toMatch(/options\.dropFirst\s*\?\s*\[`DROP DATABASE IF EXISTS/);
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(
        real,
        '...(options.dropFirst ? [`DROP DATABASE IF EXISTS ${sqlIdent(targetDatabase)}`] : []),',
        '`DROP DATABASE IF EXISTS ${sqlIdent(targetDatabase)}`,',
      ),
    );
  });
});
