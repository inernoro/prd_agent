/**
 * env-classifier.test.ts — F6 fix: TS 版 _classify_env_kind 与 cdscli Python
 * 端 1:1 对齐回归。改一个不改另一个会导致前后端 envMeta 判定不一致 →
 * deploy block 行为漂移。
 *
 * SSOT 对照点:
 *   - .claude/skills/cds/cli/cdscli.py _classify_env_kind
 *   - .claude/skills/cds/tests/test_round13_helpers.py(全部 9 case)
 *
 * 此文件每加一个 case,Python 端的 test_round13_helpers.py 也应有对应 case。
 */

import { describe, it, expect } from 'vitest';
import { classifyEnvKind, deriveEnvMetaForVars } from '../../src/services/env-classifier.js';

describe('classifyEnvKind — 与 cdscli _classify_env_kind 1:1 对齐', () => {
  it('is_password=true → auto', () => {
    expect(classifyEnvKind('FOO', 'anything', { isPassword: true }).kind).toBe('auto');
  });

  it('${VAR} 模板引用 → infra-derived(优先于 marker 检查)', () => {
    expect(classifyEnvKind('DATABASE_URL', '${POSTGRES_URL}').kind).toBe('infra-derived');
  });

  it('关键回归:${REPLACE_ME_TOKEN} 含子串 REPLACE_ME 仍归 infra-derived', () => {
    // Bugbot 第十四轮 Bug 1 — 模板检查必须在 marker 检查之前
    expect(classifyEnvKind('TOKEN', '${REPLACE_ME_TOKEN}').kind).toBe('infra-derived');
  });

  it('字面 TODO/REPLACE_ME → required', () => {
    expect(classifyEnvKind('SERVER_URL', 'TODO_FILL_PREVIEW_URL').kind).toBe('required');
    expect(classifyEnvKind('TOKEN', 'REPLACE_ME').kind).toBe('required');
    expect(classifyEnvKind('PASS', '请填写邮箱密码').kind).toBe('required');
  });

  it('空值 + secret key → required', () => {
    expect(classifyEnvKind('SMTP_PASSWORD', null).kind).toBe('required');
    expect(classifyEnvKind('OAUTH_CLIENT_SECRET', '').kind).toBe('required');
    expect(classifyEnvKind('AI_ACCESS_KEY', '').kind).toBe('required');
  });

  it('空值 + 非 secret → auto(应用通常有默认)', () => {
    expect(classifyEnvKind('LOG_LEVEL', '').kind).toBe('auto');
    expect(classifyEnvKind('FEATURE_FLAGS', null).kind).toBe('auto');
    expect(classifyEnvKind('STORAGE_TYPE', '').kind).toBe('auto');
  });

  it('字面量值 → auto', () => {
    expect(classifyEnvKind('PG_DATABASE_HOST', 'db').kind).toBe('auto');
    expect(classifyEnvKind('PG_DATABASE_PORT', '5432').kind).toBe('auto');
    expect(classifyEnvKind('STORAGE_TYPE', 'local').kind).toBe('auto');
  });

  it('case-insensitive marker 命中(与 state.ts isPlaceholderValue 对齐)', () => {
    // Bugbot 第六轮 case-insensitive 修复
    expect(classifyEnvKind('X', 'Todo: fill').kind).toBe('required');
    expect(classifyEnvKind('X', 'replace_me').kind).toBe('required');
  });
});

describe('deriveEnvMetaForVars — 批量推断', () => {
  it('Twenty CRM 真实 yml 数据(F6 onboarding UAT 触发场景)', () => {
    // 数据来自 inernoro/cds-twenty-demo 的 cds-compose.yml(无 x-cds-env-meta)
    const envVars = {
      PG_DATABASE_USER: 'postgres',
      PG_DATABASE_PASSWORD: 'VsmV6CyOkL3rMfnNqxEqwQ',
      PG_DATABASE_NAME: 'default',
      PG_DATABASE_HOST: 'db',
      PG_DATABASE_PORT: '5432',
      PG_DATABASE_URL: 'postgres://${PG_DATABASE_USER}:${PG_DATABASE_PASSWORD}@${PG_DATABASE_HOST}:${PG_DATABASE_PORT}/${PG_DATABASE_NAME}',
      REDIS_URL: 'redis://redis:6379',
      APP_SECRET: 'Ph6ContractTestRandomSecretChange',
      SERVER_URL: 'TODO_FILL_PREVIEW_URL',
      STORAGE_TYPE: 'local',
      STORAGE_S3_REGION: '',
      STORAGE_S3_NAME: '',
      STORAGE_S3_ENDPOINT: '',
      DISABLE_DB_MIGRATIONS: '',
      DISABLE_CRON_JOBS_REGISTRATION: '',
    };
    const meta = deriveEnvMetaForVars(envVars);
    // 关键断言:SERVER_URL=TODO_... 必须 required(deploy 前 block)
    expect(meta.SERVER_URL.kind).toBe('required');
    // PG_DATABASE_URL 含 ${VAR} → infra-derived(由 CDS 推导)
    expect(meta.PG_DATABASE_URL.kind).toBe('infra-derived');
    // 字面密码 → auto(cdscli 已生成,可在 UI 改)
    expect(meta.PG_DATABASE_PASSWORD.kind).toBe('auto');
    expect(meta.APP_SECRET.kind).toBe('auto');
    // 空 + 非 secret → auto(STORAGE_S3_REGION 等可选)
    expect(meta.STORAGE_S3_REGION.kind).toBe('auto');
    expect(meta.DISABLE_DB_MIGRATIONS.kind).toBe('auto');
    // 字面量配置 → auto
    expect(meta.PG_DATABASE_HOST.kind).toBe('auto');
    expect(meta.STORAGE_TYPE.kind).toBe('auto');
    // 全量 envMeta 数 = envVars 数(无遗漏)
    expect(Object.keys(meta).length).toBe(Object.keys(envVars).length);
  });

  it('explicitMeta 覆盖推断 — 用户在 yml 显式声明的 wins', () => {
    const envVars = { LOG_LEVEL: 'info', SERVER_URL: 'TODO' };
    const explicit = { LOG_LEVEL: { kind: 'required' as const, hint: '强制必填' } };
    const meta = deriveEnvMetaForVars(envVars, explicit);
    expect(meta.LOG_LEVEL.kind).toBe('required');
    expect(meta.LOG_LEVEL.hint).toBe('强制必填');
    expect(meta.SERVER_URL.kind).toBe('required'); // TODO 推断
  });

  it('空 envVars → 空 meta', () => {
    expect(deriveEnvMetaForVars({})).toEqual({});
  });
});
