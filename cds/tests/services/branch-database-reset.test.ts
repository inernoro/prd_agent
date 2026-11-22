import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 「分支库推倒重建」已撤下（2026-08-30）——本文件从「守着它能用」翻面成「守着它别回来」。
 *
 * 它要以 root 凭据 DROP DATABASE，安全性取决于「这个库是不是本分支的」。这个问题在
 * review 里被连续打穿四次，每次都是所有权的证据不成立：
 *   1. 分支 scope 的 MYSQL_DATABASE 是可写配置，改成兄弟分支的库名即可越权；
 *   2. 建库台账也不行——建空库接受调用方指定库名且「库在就跳过」，指向已存在的兄弟库
 *      照样写出完成记录；
 *   3. 按命名规则复算的名字并不唯一——分支 slug 被截断到 28 字符，实测两个真实风格的
 *      分支名会算出同一个库名；
 *   4. 补了撞名拒绝之后仍有进路：兄弟分支可先用建空库把自己绑到本分支会算出的名字上，
 *      而撞名检查只比对「重新算出来的名字」，从不看别人实际绑在哪。
 *
 * 每修一次就多一道拒绝，下一轮又出新进路——所有权模型不存在，护栏就补不完。
 * 重开条件写在 https://github.com/inernoro/prd_agent/blob/853023509128fb785541408fd88591db860ce9bf/doc/debt.cds.md：建库时记录「这个库是我建的」+ 破坏性操作改用抗碰撞身份。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readBranchesRoute(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'src/routes/branches.ts'), 'utf8');
}

function cloneTasksRouteSlice(source: string): string {
  const at = source.indexOf("router.post('/branches/:id/resources/:resourceId/clone-tasks'");
  expect(at, '找不到 clone-tasks 路由').toBeGreaterThan(-1);
  const nextRoute = source.slice(at + 1).search(/\n {2}router\.(get|post|put|patch|delete)\(/);
  const end = nextRoute === -1 ? source.length : at + 1 + nextRoute;
  const slice = source.slice(at, end);
  expect(slice, 'clone-tasks 切片没覆盖到执行体').toContain('createMysqlBranchDatabase(rawInfra');
  return slice;
}

describe('分支库推倒重建已撤下，且不许悄悄回来', () => {
  it('请求 reset 被显式拒绝，并说清为什么', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("if (mode === 'reset') {");
    expect(slice).toContain('reset_withdrawn');
    // 拒绝要给得出下一步，而不是一句「不支持」
    expect(slice).toContain('直连数据库处理；可在 CDS 工程债务的 cds 模块查看重开条件。');
  });

  it('reset 不在被接受的模式里', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    expect(slice).toContain("['empty', 'clone-main', 'restore-backup', 'connect-existing']");
    expect(slice).not.toContain("['empty', 'reset', 'clone-main'");
  });

  /**
   * 最要紧的一条：删库的代码本身必须不在了。
   * 留着一段「当前不可达」的破坏性代码，等于把洞留给下一个改这里的人——
   * 他只要在别处放开一个入口，DROP 就又活了。
   */
  it('建库路径里没有任何 DROP DATABASE', () => {
    const source = readBranchesRoute();
    const at = source.indexOf('async function createMysqlBranchDatabase(');
    expect(at, '找不到 createMysqlBranchDatabase').toBeGreaterThan(-1);
    const fn = source.slice(at, at + 2000);
    expect(fn).not.toContain('DROP DATABASE');
    expect(fn).not.toContain('dropFirst');
  });

  it('reset 时期的三道闸和目标计算都已随之移除，没有留下死代码', () => {
    const slice = cloneTasksRouteSlice(readBranchesRoute());
    for (const ghost of [
      'resetTargetDatabase',
      'resetTargetCollidingBranches',
      'reset_refuses_base_database',
      'reset_refuses_foreign_database',
      'reset_target_ambiguous',
      'branchOwnedDatabases',
      'ownedFromLedger',
    ]) {
      expect(slice, `${ghost} 是 reset 时期的残留，应随功能一起移除`).not.toContain(ghost);
    }
  });

  it('红用例：把 reset 放回被接受的模式，守卫必须变红', () => {
    const guard = (source: string) => {
      const slice = cloneTasksRouteSlice(source);
      expect(slice).not.toContain("['empty', 'reset', 'clone-main'");
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, "['empty', 'clone-main', 'restore-backup', 'connect-existing']", "['empty', 'reset', 'clone-main', 'restore-backup', 'connect-existing']"),
    );
  });

  it('红用例：把 DROP DATABASE 放回建库函数，守卫必须变红', () => {
    const guard = (source: string) => {
      const at = source.indexOf('async function createMysqlBranchDatabase(');
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 2000)).not.toContain('DROP DATABASE');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(
        real,
        '      `CREATE DATABASE IF NOT EXISTS ${sqlIdent(targetDatabase)}',
        '      `DROP DATABASE IF EXISTS ${sqlIdent(targetDatabase)}`,\n      `CREATE DATABASE IF NOT EXISTS ${sqlIdent(targetDatabase)}',
      ),
    );
  });

  it('红用例：拒绝文案里拿掉去处，守卫必须变红', () => {
    // 锚点必须落在**给用户的那句话**上，不能是随便一处出现。
    // 注释里的历史链接在移除提示后仍然存在。锚点应匹配给用户的消息。
    const guard = (source: string) => {
      expect(cloneTasksRouteSlice(source)).toContain('直连数据库处理；可在 CDS 工程债务的 cds 模块查看重开条件。');
    };
    const real = readBranchesRoute();
    expectGuardRedOnMutation(guard, real, mutate(real, '直连数据库处理；可在 CDS 工程债务的 cds 模块查看重开条件。', '直连数据库处理。'));
  });
});
