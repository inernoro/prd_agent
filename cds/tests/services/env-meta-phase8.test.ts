import { describe, it, expect } from 'vitest';
import { parseCdsCompose } from '../../src/services/compose-parser.js';

/**
 * Phase 8 — env 三色 metadata + deploy block + cross-branch defaultEnv 测试。
 *
 * 锁住"用户必填项不填 deploy block + 自动生成密钥不打扰用户"的契约。
 *
 * 测点:
 *  - parseCdsCompose 读 x-cds-env-meta 段,kind 'auto' / 'required' / 'infra-derived' 全识别
 *  - 不带 x-cds-env-meta 的旧 yaml 兼容:envMeta 是空 dict,行为同前(不 block)
 *  - kind 字段大小写 / 未知值兜底为 'auto'(不破坏导入)
 */

describe('Phase 8 — parseCdsCompose envMeta', () => {
  it('标识 required / auto / infra-derived 三类', () => {
    const yaml = `
x-cds-project:
  name: demo

x-cds-env:
  POSTGRES_PASSWORD: "abc123"
  DATABASE_URL: "postgresql://postgres:\${POSTGRES_PASSWORD}@db:5432/app"
  SMTP_PASSWORD: ""

x-cds-env-meta:
  POSTGRES_PASSWORD:
    kind: auto
    hint: "Postgres 密码(自动生成)"
  DATABASE_URL:
    kind: infra-derived
    hint: "由 CDS 推导"
  SMTP_PASSWORD:
    kind: required
    hint: "请填写你的 SMTP 邮箱密码"

services:
  app:
    image: node:20
    volumes:
      - "./app:/app"
    ports:
      - "3000"
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed).not.toBeNull();
    expect(parsed!.envMeta.POSTGRES_PASSWORD).toEqual({
      kind: 'auto',
      hint: 'Postgres 密码(自动生成)',
    });
    expect(parsed!.envMeta.DATABASE_URL.kind).toBe('infra-derived');
    expect(parsed!.envMeta.SMTP_PASSWORD.kind).toBe('required');
    expect(parsed!.envMeta.SMTP_PASSWORD.hint).toContain('SMTP');
  });

  it('未知 kind 兜底为 auto(不破坏导入)', () => {
    const yaml = `
x-cds-project:
  name: demo
x-cds-env:
  WEIRD_KEY: "value"
x-cds-env-meta:
  WEIRD_KEY:
    kind: unknown_value
services:
  app:
    image: node:20
    volumes:
      - "./app:/app"
    ports:
      - "3000"
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed!.envMeta.WEIRD_KEY.kind).toBe('auto');
  });

  it('kind 大小写不敏感(REQUIRED 也认)', () => {
    const yaml = `
x-cds-project:
  name: demo
x-cds-env:
  KEY1: ""
x-cds-env-meta:
  KEY1:
    kind: REQUIRED
services:
  app:
    image: node:20
    volumes:
      - "./app:/app"
    ports:
      - "3000"
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed!.envMeta.KEY1.kind).toBe('required');
  });

  it('旧 yaml 不带 x-cds-env-meta 时,envMeta 是空 dict(向后兼容)', () => {
    const yaml = `
x-cds-env:
  KEY1: "value1"
services:
  app:
    image: node:20
    volumes:
      - "./app:/app"
    ports:
      - "3000"
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed!.envMeta).toEqual({});
  });

  it('hint 缺失时不报错', () => {
    const yaml = `
x-cds-project:
  name: demo
x-cds-env:
  K1: ""
x-cds-env-meta:
  K1:
    kind: required
services:
  app:
    image: node:20
    volumes:
      - "./app:/app"
    ports:
      - "3000"
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed!.envMeta.K1.kind).toBe('required');
    expect(parsed!.envMeta.K1.hint).toBeUndefined();
  });

  it('只有 x-cds-env-meta 没 services 也能识别(纯 env 模板)', () => {
    const yaml = `
x-cds-project:
  name: env-only
x-cds-env:
  K1: ""
x-cds-env-meta:
  K1:
    kind: required
`;
    const parsed = parseCdsCompose(yaml);
    expect(parsed).not.toBeNull();
    expect(parsed!.envMeta.K1.kind).toBe('required');
  });
});
