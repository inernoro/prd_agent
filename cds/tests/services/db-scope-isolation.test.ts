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
