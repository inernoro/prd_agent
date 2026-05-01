/**
 * Bugbot regression(PR #521)— B16 自引用 + profile-local 引用同时 work。
 *
 * 验证 container.ts 用 `{ ...isolatedEnv, ...customEnv }` 作 vars 源时,
 * 两个本应都成立的场景:
 *   1. B16: profile.env.PG_DATABASE_URL = "${PG_DATABASE_URL}",customEnv 有完整值
 *      → 应该解析成 customEnv 的值(不是死循环或拿到字面量)
 *   2. profile-local: profile.env 的 URL=${HOST}:${PORT},HOST/PORT 在 isolatedEnv,
 *      不在 customEnv → 应该解析成 isolatedEnv 的拼接值
 */
import { describe, it, expect } from 'vitest';
import { resolveEnvTemplates } from '../../src/services/compose-parser.js';

describe('Bugbot regression — env resolve 同时支持 B16 自引用 + profile-local 引用', () => {
  it('B16 场景:profile.env 自引用 customEnv 同名 key,vars 源用 merged(customEnv 优先)', () => {
    // 模拟 container.ts 的 mergedEnv + isolatedEnv + customEnv 关系
    const customEnv = {
      PG_DATABASE_URL: 'postgresql://user:pass@db:5432/app',
    };
    // profile.env 写了显式 ${PG_DATABASE_URL} 自引用 → 进入 isolatedEnv 后是字面量
    const isolatedEnv = {
      PG_DATABASE_URL: '${PG_DATABASE_URL}', // 自引用,会死循环如果 vars 用 isolatedEnv 自身
      OTHER_KEY: 'static',
    };
    // 修复后的 vars 源:merge,customEnv 覆盖同名 key
    const resolveVars = { ...isolatedEnv, ...customEnv };
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.PG_DATABASE_URL).toBe('postgresql://user:pass@db:5432/app');
    expect(out.OTHER_KEY).toBe('static');
  });

  it('profile-local:URL=${HOST}:${PORT}, HOST/PORT 只在 isolatedEnv', () => {
    const customEnv = {
      // customEnv 里没 HOST/PORT,只有不相关的 SMTP_USER
      SMTP_USER: 'mailer',
    };
    const isolatedEnv = {
      HOST: 'redis',
      PORT: '6379',
      URL: '${HOST}:${PORT}',
    };
    const resolveVars = { ...isolatedEnv, ...customEnv };
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    // 旧 fix(只用 customEnv 作 vars)会让 URL = ":" 因为找不到 HOST/PORT
    // 新 fix:merged vars 包含 HOST/PORT → URL = "redis:6379"
    expect(out.URL).toBe('redis:6379');
  });

  it('两个都同时存在:profile.env 自引用 + profile-local 引用各自正确解析', () => {
    const customEnv = {
      PG_DATABASE_URL: 'postgresql://real:pass@db:5432/app',
    };
    const isolatedEnv = {
      // 自引用 customEnv
      PG_DATABASE_URL: '${PG_DATABASE_URL}',
      // profile-local 引用
      HOST: 'redis',
      PORT: '6379',
      REDIS_URL: '${HOST}:${PORT}',
      // 混合引用(用了 customEnv 中的同名 + isolatedEnv 中的)
      MIXED: '${PG_DATABASE_URL} via ${HOST}',
    };
    const resolveVars = { ...isolatedEnv, ...customEnv };
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.PG_DATABASE_URL).toBe('postgresql://real:pass@db:5432/app');
    expect(out.REDIS_URL).toBe('redis:6379');
    expect(out.MIXED).toBe('postgresql://real:pass@db:5432/app via redis');
  });

  it('customEnv 为空时退化(merge {} → 行为与裸 isolatedEnv 一致)', () => {
    const customEnv = {};
    const isolatedEnv = {
      HOST: 'redis',
      URL: '${HOST}',
    };
    const resolveVars = { ...isolatedEnv, ...customEnv };
    const out = resolveEnvTemplates(isolatedEnv, resolveVars);
    expect(out.URL).toBe('redis');
  });
});
