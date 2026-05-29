/**
 * infra cmd 白名单 SSOT 测试 — 2026-05-29 Cursor Bugbot(PR #684):白名单此前在
 * pending-import.ts 和 project-infra-resync.ts 各抄一份,有漂移风险,抽到
 * config/infra-cmd-whitelist.ts。本测试锁住命中/放行边界。
 */
import { describe, it, expect } from 'vitest';
import {
  findInfraCmdViolations,
  isInfraCommandEmpty,
  INFRA_NEEDS_CMD,
} from '../../src/config/infra-cmd-whitelist.js';

describe('isInfraCommandEmpty', () => {
  it('undefined / 空串 / 空数组 都算空', () => {
    expect(isInfraCommandEmpty(undefined)).toBe(true);
    expect(isInfraCommandEmpty('')).toBe(true);
    expect(isInfraCommandEmpty('   ')).toBe(true);
    expect(isInfraCommandEmpty([])).toBe(true);
  });
  it('非空 string / 数组 不算空', () => {
    expect(isInfraCommandEmpty('server /data')).toBe(false);
    expect(isInfraCommandEmpty(['server', '/data'])).toBe(false);
  });
});

describe('findInfraCmdViolations', () => {
  it('minio 缺 command → 违规,带修复示例', () => {
    const v = findInfraCmdViolations([
      { id: 'minio', dockerImage: 'minio/minio:latest' },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('minio');
    expect(v[0].example).toContain('server');
  });

  it('minio 带 command → 放行', () => {
    const v = findInfraCmdViolations([
      { id: 'minio', dockerImage: 'minio/minio:latest', command: ['server', '/data'] },
    ]);
    expect(v).toEqual([]);
  });

  it('elasticsearch 缺 command → 违规', () => {
    const v = findInfraCmdViolations([
      { id: 'es', dockerImage: 'docker.io/library/elasticsearch:8.12.0' },
    ]);
    expect(v).toHaveLength(1);
  });

  it('不在白名单的 image(redis/postgres)缺 command → 不违规', () => {
    const v = findInfraCmdViolations([
      { id: 'redis', dockerImage: 'redis:7-alpine' },
      { id: 'pg', dockerImage: 'postgres:16-alpine' },
    ]);
    expect(v).toEqual([]);
  });

  it('白名单非空(防误删)', () => {
    expect(INFRA_NEEDS_CMD.length).toBeGreaterThan(0);
  });
});
