import { describe, expect, it } from 'vitest';
import { validateInfraCmds } from '../../src/routes/project-infra-resync.js';

describe('validateInfraCmds — cmd 白名单', () => {
  it('minio 缺 cmd → 错误', () => {
    expect(validateInfraCmds([{ id: 'minio', dockerImage: 'minio/minio:latest' }]))
      .toContain('minio (minio/minio:latest)');
  });

  it('minio 带 cmd 数组 → 通过', () => {
    expect(validateInfraCmds([
      { id: 'minio', dockerImage: 'minio/minio:latest', command: ['server', '/data'] },
    ])).toBeNull();
  });

  it('minio 带 cmd string → 通过', () => {
    expect(validateInfraCmds([
      { id: 'minio', dockerImage: 'minio/minio:latest', command: 'server /data' },
    ])).toBeNull();
  });

  it('elasticsearch 缺 cmd → 错误', () => {
    expect(validateInfraCmds([{ id: 'es', dockerImage: 'elasticsearch:8.10' }]))
      .toContain('es (elasticsearch:8.10)');
  });

  it('mongo / redis / postgres 不需要 cmd → 通过', () => {
    expect(validateInfraCmds([
      { id: 'mongo', dockerImage: 'mongo:7' },
      { id: 'redis', dockerImage: 'redis:7' },
      { id: 'pg', dockerImage: 'postgres:16' },
    ])).toBeNull();
  });

  it('空数组 → 通过', () => {
    expect(validateInfraCmds([])).toBeNull();
  });

  it('command 空字符串 / 空数组 → 视为缺失', () => {
    expect(validateInfraCmds([
      { id: 'minio', dockerImage: 'minio/minio:latest', command: '' },
    ])).toContain('minio');
    expect(validateInfraCmds([
      { id: 'minio', dockerImage: 'minio/minio:latest', command: [] },
    ])).toContain('minio');
  });
});
