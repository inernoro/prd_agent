import { describe, it, expect } from 'vitest';
import {
  slugifyBranchForDb,
  applyPerBranchDbIsolation,
  previewPerBranchDbDiff,
} from '../../src/services/db-scope-isolation.js';

/**
 * Phase 5(2026-05-01)— 多分支 DB 隔离测试。
 *
 * 锁住"per-branch dbScope 把 DB env 后缀 branchSlug,shared 模式 noop"的行为。
 * 北极星目标:任意 schemaful DB 项目接 CDS,多分支不互相破坏数据。
 */

describe('slugifyBranchForDb', () => {
  it('保留小写字母数字下划线,其它字符替换为 _', () => {
    expect(slugifyBranchForDb('main')).toBe('main');
    expect(slugifyBranchForDb('feat/login')).toBe('feat_login');
    expect(slugifyBranchForDb('claude/fix-bug-X2y')).toBe('claude_fix_bug_x2y');
    expect(slugifyBranchForDb('feat/auth/login')).toBe('feat_auth_login');
  });

  it('合并连续 _ + 去头尾 _', () => {
    expect(slugifyBranchForDb('--main--')).toBe('main');
    expect(slugifyBranchForDb('a___b')).toBe('a_b');
  });

  it('空字符串 / 全特殊字符返回空', () => {
    expect(slugifyBranchForDb('')).toBe('');
    expect(slugifyBranchForDb('---')).toBe('');
  });
});

describe('applyPerBranchDbIsolation — shared 模式(默认)', () => {
  it('dbScope 未传 → 原样返回(noop)', () => {
    const env = { MYSQL_DATABASE: 'app', MYSQL_USER: 'root' };
    const out = applyPerBranchDbIsolation(env, undefined, 'feat/x');
    expect(out).toEqual(env);
  });

  it('dbScope=shared → 原样返回(noop)', () => {
    const env = { MYSQL_DATABASE: 'app', POSTGRES_DB: 'mydb' };
    const out = applyPerBranchDbIsolation(env, 'shared', 'main');
    expect(out).toEqual(env);
  });

  it('shared 模式直接返回入参引用(noop 更高效),内容也等于入参', () => {
    const env = { MYSQL_DATABASE: 'app' };
    const out = applyPerBranchDbIsolation(env, 'shared', 'main');
    // shared 是 noop;为效率直接返回入参,合法实现选择
    expect(out).toEqual(env);
  });

  it('per-branch 模式返回新对象,不修改入参', () => {
    const env = { MYSQL_DATABASE: 'app' };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'main');
    expect(out).not.toBe(env);  // 新对象
    expect(env.MYSQL_DATABASE).toBe('app');  // 入参未被修改
    expect(out.MYSQL_DATABASE).toBe('app_main');  // 新对象有新值
  });
});

describe('applyPerBranchDbIsolation — per-branch 模式', () => {
  it('给 MYSQL_DATABASE 加 branch slug 后缀', () => {
    const env = { MYSQL_DATABASE: 'app', MYSQL_USER: 'root' };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'feat/login');
    expect(out.MYSQL_DATABASE).toBe('app_feat_login');
    expect(out.MYSQL_USER).toBe('root');  // 非 DB-name key 不动
  });

  it('支持 POSTGRES_DB / MARIADB_DATABASE / MONGO_INITDB_DATABASE', () => {
    const env = {
      POSTGRES_DB: 'app',
      MARIADB_DATABASE: 'app',
      MONGO_INITDB_DATABASE: 'mydb',
      OTHER: 'untouched',
    };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'main');
    expect(out.POSTGRES_DB).toBe('app_main');
    expect(out.MARIADB_DATABASE).toBe('app_main');
    expect(out.MONGO_INITDB_DATABASE).toBe('mydb_main');
    expect(out.OTHER).toBe('untouched');
  });

  // Bugbot regression(PR #521,2026-05-01)— Phase 8.8 把 cdscli 生成的 env
  // 一律改成 CDS_* 前缀,但 PER_BRANCH_DB_ENV_KEYS 漏更新 → 函数找不到匹配
  // 静默 noop → 多分支隔离失效。这条测试锁住 CDS_* 版本一定能被 isolate。
  it('Phase 8.8 CDS_* 前缀的 DB env 也能被 isolate(Bugbot regression)', () => {
    const env = {
      CDS_MYSQL_DATABASE: 'app',
      CDS_POSTGRES_DB: 'app',
      CDS_MARIADB_DATABASE: 'app',
      CDS_MONGO_INITDB_DATABASE: 'mydb',
      CDS_MYSQL_USER: 'root',  // 非 DB-name 不动
    };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'feat/login');
    expect(out.CDS_MYSQL_DATABASE).toBe('app_feat_login');
    expect(out.CDS_POSTGRES_DB).toBe('app_feat_login');
    expect(out.CDS_MARIADB_DATABASE).toBe('app_feat_login');
    expect(out.CDS_MONGO_INITDB_DATABASE).toBe('mydb_feat_login');
    expect(out.CDS_MYSQL_USER).toBe('root');
  });

  it('幂等:已含 _<slug> 后缀的不重复加(防 reconcile 重复跑)', () => {
    const env = { MYSQL_DATABASE: 'app_feat_login' };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'feat/login');
    expect(out.MYSQL_DATABASE).toBe('app_feat_login');
  });

  it('空 / 缺失 DB env key 不报错', () => {
    const out1 = applyPerBranchDbIsolation({}, 'per-branch', 'main');
    expect(out1).toEqual({});
    const out2 = applyPerBranchDbIsolation({ MYSQL_DATABASE: '' }, 'per-branch', 'main');
    expect(out2.MYSQL_DATABASE).toBe('');  // 空字符串跳过
  });

  it('branch slug 为空(全特殊字符) → noop,不破坏 env', () => {
    const env = { MYSQL_DATABASE: 'app' };
    const out = applyPerBranchDbIsolation(env, 'per-branch', '---');
    expect(out.MYSQL_DATABASE).toBe('app');
  });

  it('多分支同时跑 → 每个分支拿到不同 database name', () => {
    const env = { MYSQL_DATABASE: 'app' };
    const branchA = applyPerBranchDbIsolation(env, 'per-branch', 'main');
    const branchB = applyPerBranchDbIsolation(env, 'per-branch', 'feat/x');
    const branchC = applyPerBranchDbIsolation(env, 'per-branch', 'claude/fix');
    expect(branchA.MYSQL_DATABASE).toBe('app_main');
    expect(branchB.MYSQL_DATABASE).toBe('app_feat_x');
    expect(branchC.MYSQL_DATABASE).toBe('app_claude_fix');
    // 三个互相不冲突
    expect(new Set([branchA.MYSQL_DATABASE, branchB.MYSQL_DATABASE, branchC.MYSQL_DATABASE]).size).toBe(3);
  });

  it('不破坏非 DB-name 的 env 即使含 MYSQL_ 前缀', () => {
    const env = {
      MYSQL_DATABASE: 'app',
      MYSQL_ROOT_PASSWORD: 'secret',
      MYSQL_USER: 'app',
      MYSQL_PASSWORD: 'pass',
    };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'main');
    expect(out.MYSQL_DATABASE).toBe('app_main');  // 改
    expect(out.MYSQL_ROOT_PASSWORD).toBe('secret');  // 不改(不在白名单)
    expect(out.MYSQL_USER).toBe('app');  // 不改
    expect(out.MYSQL_PASSWORD).toBe('pass');  // 不改
  });
});

describe('previewPerBranchDbDiff(给 SSE 摘要用)', () => {
  it('shared 模式 → 空 diff', () => {
    expect(previewPerBranchDbDiff({ MYSQL_DATABASE: 'app' }, 'shared', 'main')).toEqual([]);
  });

  it('per-branch 模式 → 列出每个被改写的 key(顺序按白名单)', () => {
    const env = { MYSQL_DATABASE: 'app', POSTGRES_DB: 'pgdb' };
    const diff = previewPerBranchDbDiff(env, 'per-branch', 'feat/x');
    // 白名单顺序:MYSQL_DATABASE 在 POSTGRES_DB 前
    expect(diff).toEqual([
      { key: 'MYSQL_DATABASE', from: 'app', to: 'app_feat_x' },
      { key: 'POSTGRES_DB', from: 'pgdb', to: 'pgdb_feat_x' },
    ]);
  });

  it('幂等场景 → 空 diff(已有后缀的不重复)', () => {
    const env = { MYSQL_DATABASE: 'app_main' };
    expect(previewPerBranchDbDiff(env, 'per-branch', 'main')).toEqual([]);
  });
});

/**
 * 收敛 2（2026-09-03）：分支独立库接入连接串改写。
 *
 * 此前 per-branch 只给库名变量加后缀，应用真正读的连接串（DATABASE_URL / SPRING_DATASOURCE_URL /
 * mongodb://…）里写死的库名原样不动——分支独立库对这类项目是假的。规则：
 *   - 连接串库名段等于某个**被改写**的库名变量原值 → 跟着改（同一个库，同一个后缀）；
 *   - 服务里根本没有库名变量、只有硬编码连接串 → 连接串库名段直接加后缀；
 *   - 库名段是模板 `${CDS_POSTGRES_DB}` → 不动（模板展开后自然跟随）；
 *   - 库名段对不上任何库名变量（指向别的库）→ 不动，但 explain 报「连接串未跟随」让用户看见；
 *   - 框架家族变量按项目约定不加后缀，其连接串同样不动（保持一致）；
 *   - redis:// 之类不是数据库连接串的不碰；幂等。
 */
import { explainPerBranchDbIsolation } from '../../src/services/db-scope-isolation.js';

describe('applyPerBranchDbIsolation — 连接串跟随（收敛 2）', () => {
  it('库名变量 + 同库连接串：变量与连接串一起加后缀，保留凭据/端口/查询串', () => {
    const out = applyPerBranchDbIsolation({
      CDS_MYSQL_DATABASE: 'app',
      DATABASE_URL: 'mysql://u:p%40w@mysql:3306/app?charset=utf8',
    }, 'per-branch', 'feat/x');
    expect(out.CDS_MYSQL_DATABASE).toBe('app_feat_x');
    expect(out.DATABASE_URL).toBe('mysql://u:p%40w@mysql:3306/app_feat_x?charset=utf8');
  });

  it('只有硬编码 JDBC 串、没有库名变量的服务：串里的库名段直接加后缀', () => {
    const out = applyPerBranchDbIsolation({
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/imp?useSSL=false&serverTimezone=UTC',
      SPRING_DATASOURCE_USERNAME: 'imp',
    }, 'per-branch', 'feat/x');
    expect(out.SPRING_DATASOURCE_URL).toBe('jdbc:mysql://mysql:3306/imp_feat_x?useSSL=false&serverTimezone=UTC');
    expect(out.SPRING_DATASOURCE_USERNAME).toBe('imp');
  });

  it('模板库名段不动（展开后自然跟随）；指向别的库的连接串不动；redis 不碰', () => {
    const env = {
      CDS_POSTGRES_DB: 'shop',
      DATABASE_URL: 'postgres://db:5432/${CDS_POSTGRES_DB}',
      REPORTING_URL: 'postgres://db:5432/reporting',
      REDIS_URL: 'redis://redis:6379/0',
    };
    const out = applyPerBranchDbIsolation(env, 'per-branch', 'feat/x');
    expect(out.CDS_POSTGRES_DB).toBe('shop_feat_x');
    expect(out.DATABASE_URL).toBe('postgres://db:5432/${CDS_POSTGRES_DB}');
    expect(out.REPORTING_URL).toBe('postgres://db:5432/reporting');
    expect(out.REDIS_URL).toBe('redis://redis:6379/0');
  });

  it('框架家族变量按约定不加后缀，其 mongodb 连接串同样不动', () => {
    const env = { MongoDB__DatabaseName: 'prdagent', MongoDB__ConnectionString: 'mongodb://mongo:27017/prdagent?authSource=admin' };
    expect(applyPerBranchDbIsolation(env, 'per-branch', 'feat/x')).toEqual(env);
  });

  it('幂等：连接串库名段已带后缀不重复加', () => {
    const env = { CDS_MYSQL_DATABASE: 'app_feat_x', DATABASE_URL: 'mysql://mysql:3306/app_feat_x' };
    expect(applyPerBranchDbIsolation(env, 'per-branch', 'feat/x')).toEqual(env);
  });

  it('shared 仍是 noop', () => {
    const env = { SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/imp' };
    expect(applyPerBranchDbIsolation(env, 'shared', 'feat/x')).toBe(env);
  });
});

describe('explainPerBranchDbIsolation — 每个变量发生了什么，给配置检查器标「连接串已跟随 / 未跟随」', () => {
  it('分别报出：库名加后缀、连接串已跟随、连接串未跟随（指向别的库）、模板跟随、框架变量按约定不动', () => {
    const rows = explainPerBranchDbIsolation({
      CDS_MYSQL_DATABASE: 'app',
      DATABASE_URL: 'mysql://mysql:3306/app',
      REPORTING_URL: 'mysql://mysql:3306/reporting',
      TPL_URL: 'mysql://mysql:3306/${CDS_MYSQL_DATABASE}',
      MongoDB__DatabaseName: 'legacy',
    }, 'per-branch', 'feat/x');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.CDS_MYSQL_DATABASE).toMatchObject({ kind: 'db-name-suffix', from: 'app', to: 'app_feat_x' });
    expect(byKey.DATABASE_URL).toMatchObject({ kind: 'url-followed', to: 'mysql://mysql:3306/app_feat_x' });
    expect(byKey.REPORTING_URL.kind).toBe('url-unfollowed');
    expect(byKey.REPORTING_URL.reason).toContain('reporting');
    expect(byKey.TPL_URL.kind).toBe('url-template');
    expect(byKey.MongoDB__DatabaseName.kind).toBe('db-name-kept');
  });

  it('shared → 空', () => {
    expect(explainPerBranchDbIsolation({ CDS_MYSQL_DATABASE: 'app' }, 'shared', 'feat/x')).toEqual([]);
  });
});
