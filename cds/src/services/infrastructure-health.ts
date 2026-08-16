export type InfrastructureHealthLevel = 'ok' | 'warn' | 'critical';

export interface InfrastructureHealthItem {
  id: string;
  level: InfrastructureHealthLevel;
  message: string;
}

export interface InfrastructureHealthInput {
  now: Date;
  backupCompletedAt?: Date | null;
  remoteBackupVerifiedAt?: Date | null;
  maxBackupAgeMs?: number;
  disk?: { freeBytes: number; totalBytes: number } | null;
  certificates: Array<{ host: string; expiresAt?: Date | null; error?: string }>;
  containers: Array<{ name: string; running?: boolean | null }>;
  exposureCriticalCount?: number | null;
  exposureWarnCount?: number | null;
}

export interface InfrastructureHealthReport {
  ok: boolean;
  level: InfrastructureHealthLevel;
  summary: string;
  items: InfrastructureHealthItem[];
  signature: string;
}

const GIB = 1024 * 1024 * 1024;

export function evaluateInfrastructureHealth(input: InfrastructureHealthInput): InfrastructureHealthReport {
  const items: InfrastructureHealthItem[] = [];
  const maxBackupAge = input.maxBackupAgeMs ?? 8 * 60 * 60_000;
  const ageItem = (id: string, label: string, value?: Date | null): void => {
    if (!value || !Number.isFinite(value.getTime())) {
      items.push({ id, level: 'warn', message: `${label}时间未知，可能没有可恢复副本` });
      return;
    }
    const age = Math.max(0, input.now.getTime() - value.getTime());
    if (age > maxBackupAge) {
      items.push({ id, level: 'critical', message: `${label}已超过 ${Math.floor(age / 3_600_000)} 小时未更新` });
    } else {
      items.push({ id, level: 'ok', message: `${label}最近一次成功在 ${value.toISOString()}` });
    }
  };
  ageItem('backup-local', '本地备份', input.backupCompletedAt);
  ageItem('backup-remote', '离机备份', input.remoteBackupVerifiedAt);

  if (!input.disk || input.disk.totalBytes <= 0) {
    items.push({ id: 'disk', level: 'warn', message: '磁盘水位未知，无法确认是否有足够备份空间' });
  } else {
    const freeRatio = input.disk.freeBytes / input.disk.totalBytes;
    const level: InfrastructureHealthLevel = input.disk.freeBytes < 5 * GIB || freeRatio < 0.1
      ? 'critical'
      : input.disk.freeBytes < 10 * GIB || freeRatio < 0.2 ? 'warn' : 'ok';
    items.push({
      id: 'disk', level,
      message: `磁盘剩余 ${(input.disk.freeBytes / GIB).toFixed(1)} GiB（${(freeRatio * 100).toFixed(1)}%）`,
    });
  }

  if (input.certificates.length === 0) {
    items.push({ id: 'certificate:none', level: 'warn', message: '没有可检查的证书目标' });
  }
  for (const cert of input.certificates) {
    const id = `certificate:${cert.host}`;
    if (!cert.expiresAt || !Number.isFinite(cert.expiresAt.getTime())) {
      items.push({ id, level: 'warn', message: `${cert.host} 证书到期时间未知：${cert.error || '读取失败'}` });
      continue;
    }
    const days = Math.floor((cert.expiresAt.getTime() - input.now.getTime()) / 86_400_000);
    const level: InfrastructureHealthLevel = days < 7 ? 'critical' : days < 30 ? 'warn' : 'ok';
    items.push({ id, level, message: `${cert.host} 证书剩余 ${days} 天` });
  }

  for (const container of input.containers) {
    items.push({
      id: `container:${container.name}`,
      level: container.running === true ? 'ok' : container.running === false ? 'critical' : 'warn',
      message: container.running === true
        ? `${container.name} 正在运行`
        : container.running === false ? `${container.name} 未运行` : `${container.name} 状态未知`,
    });
  }

  if (input.exposureCriticalCount == null || input.exposureWarnCount == null) {
    items.push({ id: 'exposure', level: 'warn', message: '端口暴露面状态未知' });
  } else if (input.exposureCriticalCount > 0) {
    items.push({ id: 'exposure', level: 'critical', message: `${input.exposureCriticalCount} 个数据端口处于高风险状态` });
  } else if (input.exposureWarnCount > 0) {
    items.push({ id: 'exposure', level: 'warn', message: `${input.exposureWarnCount} 个数据端口仍依赖外围防护` });
  } else {
    items.push({ id: 'exposure', level: 'ok', message: '数据端口运行态检查正常' });
  }

  const level: InfrastructureHealthLevel = items.some((item) => item.level === 'critical')
    ? 'critical' : items.some((item) => item.level === 'warn') ? 'warn' : 'ok';
  const bad = items.filter((item) => item.level !== 'ok');
  return {
    ok: level === 'ok',
    level,
    summary: bad.length === 0 ? '基础设施健康检查全部正常' : `${bad.length} 项需要处理：${bad.map((item) => item.id).join('、')}`,
    items,
    signature: items.map((item) => `${item.id}:${item.level}:${item.message}`).sort().join('|'),
  };
}
