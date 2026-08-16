import { describe, expect, it } from 'vitest';
import { evaluateInfrastructureHealth } from '../../src/services/infrastructure-health.js';

const now = new Date('2026-08-17T12:00:00Z');

describe('统一基础设施健康检查', () => {
  it('未知状态从严，不会被当成正常', () => {
    const report = evaluateInfrastructureHealth({
      now, disk: null, certificates: [], containers: [{ name: 'db', running: null }],
      exposureCriticalCount: null, exposureWarnCount: null,
    });
    expect(report.ok).toBe(false);
    expect(report.items.filter((item) => item.level === 'warn').map((item) => item.id))
      .toEqual(expect.arrayContaining(['backup-local', 'backup-remote', 'disk', 'certificate:none', 'container:db', 'exposure']));
  });

  it('备份陈旧、磁盘不足、证书临期和容器停止会明确点名', () => {
    const report = evaluateInfrastructureHealth({
      now,
      backupCompletedAt: new Date('2026-08-16T00:00:00Z'),
      remoteBackupVerifiedAt: new Date('2026-08-16T00:00:00Z'),
      disk: { freeBytes: 2 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      certificates: [{ host: 'configured-host', expiresAt: new Date('2026-08-20T00:00:00Z') }],
      containers: [{ name: 'database-a', running: false }],
      exposureCriticalCount: 1,
      exposureWarnCount: 0,
    });
    expect(report.level).toBe('critical');
    expect(report.summary).toContain('backup-local');
    expect(report.items.find((item) => item.id === 'container:database-a')?.level).toBe('critical');
  });

  it('所有运行真值正常时才返回 ok', () => {
    const report = evaluateInfrastructureHealth({
      now,
      backupCompletedAt: new Date('2026-08-17T10:00:00Z'),
      remoteBackupVerifiedAt: new Date('2026-08-17T10:00:00Z'),
      disk: { freeBytes: 30 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      certificates: [{ host: 'configured-host', expiresAt: new Date('2026-12-20T00:00:00Z') }],
      containers: [{ name: 'database-a', running: true }],
      exposureCriticalCount: 0,
      exposureWarnCount: 0,
    });
    expect(report.ok).toBe(true);
  });
});
