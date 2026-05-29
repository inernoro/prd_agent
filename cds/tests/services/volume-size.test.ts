/**
 * volume-size 测试 — feature-emerge E7「项目存储面板」的解析/格式化内核。
 * 这些是纯函数，断言 docker 输出解析的鲁棒性（列宽浮动、单位混用、降级返回 null）。
 */
import { describe, it, expect } from 'vitest';
import {
  parseDockerSize,
  formatBytes,
  parseDockerSystemDfVolumes,
  parseDfOutput,
} from '../../src/services/volume-size.js';
import { collectProjectVolumes } from '../../src/routes/project-storage.js';
import type { InfraVolume } from '../../src/types.js';

describe('parseDockerSize', () => {
  it('解析 SI/IEC 单位（统一按 1024）', () => {
    expect(parseDockerSize('800B')).toBe(800);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('1KB')).toBe(1024);
    expect(parseDockerSize('1KiB')).toBe(1024);
    expect(parseDockerSize('45.2MB')).toBeCloseTo(45.2 * 1024 ** 2, 0);
    expect(parseDockerSize('1.5GiB')).toBeCloseTo(1.5 * 1024 ** 3, 0);
  });

  it('带空格 / 大小写不敏感', () => {
    expect(parseDockerSize('  2 mb ')).toBeCloseTo(2 * 1024 ** 2, 0);
  });

  it('无单位默认按 B', () => {
    expect(parseDockerSize('512')).toBe(512);
  });

  it('无法解析 / N/A / 空 → null（不误报 0）', () => {
    expect(parseDockerSize('N/A')).toBeNull();
    expect(parseDockerSize('')).toBeNull();
    expect(parseDockerSize('  ')).toBeNull();
    expect(parseDockerSize(undefined)).toBeNull();
    expect(parseDockerSize(null)).toBeNull();
    expect(parseDockerSize('abc')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('null / 非有限 → 未知', () => {
    expect(formatBytes(null)).toBe('未知');
    expect(formatBytes(undefined)).toBe('未知');
    expect(formatBytes(NaN)).toBe('未知');
  });

  it('0 与字节级不带小数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('逐级进制 + 小数位规则', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(45.2 * 1024 ** 2)).toBe('45.2 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12.0 GB');
  });
});

describe('parseDockerSystemDfVolumes', () => {
  const SAMPLE = `Images space usage:

REPOSITORY   TAG   IMAGE ID   CREATED   SIZE   SHARED SIZE   UNIQUE SIZE   CONTAINERS
mongo        7     abc123     2 days    700MB  0B            700MB         1

Containers space usage:

CONTAINER ID   IMAGE   COMMAND   LOCAL VOLUMES   SIZE   CREATED   STATUS   NAMES
deadbeef       mongo   "mongod"  1               0B     2 days    Up       cds-infra-x

Local Volumes space usage:

VOLUME NAME            LINKS     SIZE
cds-mongodb-data       1         45.2MB
cds-redis-data         0         0B
cds-unparseable        1         N/A

Build cache usage:

CACHE ID   CACHE TYPE   SIZE   CREATED   LAST USED   USAGE   SHARED
xxxx       regular      10MB   1 day     1 day       1       false
`;

  it('只取 Local Volumes 区段，按空白切分拿 name + size', () => {
    const m = parseDockerSystemDfVolumes(SAMPLE);
    expect(m.get('cds-mongodb-data')).toBeCloseTo(45.2 * 1024 ** 2, 0);
    expect(m.get('cds-redis-data')).toBe(0);
    // N/A 无法解析 → null（在 map 里存在但值是 null）
    expect(m.has('cds-unparseable')).toBe(true);
    expect(m.get('cds-unparseable')).toBeNull();
  });

  it('不把 Images/Containers/Build 区段的行误当卷', () => {
    const m = parseDockerSystemDfVolumes(SAMPLE);
    expect(m.has('mongo')).toBe(false);
    expect(m.has('deadbeef')).toBe(false);
    expect(m.has('xxxx')).toBe(false);
  });

  it('空输入 → 空 map', () => {
    expect(parseDockerSystemDfVolumes('').size).toBe(0);
    expect(parseDockerSystemDfVolumes(null).size).toBe(0);
  });
});

describe('parseDfOutput', () => {
  it('解析 df -kP 数据行（1024-blocks → bytes）', () => {
    const out = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        102687672  41234567  56123456      43% /`;
    const d = parseDfOutput(out);
    expect(d).not.toBeNull();
    expect(d!.filesystem).toBe('/dev/sda1');
    expect(d!.totalBytes).toBe(102687672 * 1024);
    expect(d!.usedBytes).toBe(41234567 * 1024);
    expect(d!.availBytes).toBe(56123456 * 1024);
    expect(d!.usePercent).toBe(43);
    expect(d!.mountedOn).toBe('/');
  });

  it('只有表头 / 空 → null', () => {
    expect(parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on')).toBeNull();
    expect(parseDfOutput('')).toBeNull();
    expect(parseDfOutput(null)).toBeNull();
  });
});

describe('collectProjectVolumes', () => {
  const v = (name: string, containerPath: string, type?: 'volume' | 'bind'): InfraVolume => ({
    name,
    containerPath,
    ...(type ? { type } : {}),
  });

  it('聚合 infra 服务的卷，同名卷合并 mountedBy', () => {
    const map = collectProjectVolumes([
      { id: 'mongodb', volumes: [v('cds-mongodb-data', '/data/db')] },
      { id: 'redis', volumes: [v('cds-redis-data', '/data', 'volume')] },
      // 共享同名卷的第二个服务 → 合并 mountedBy
      { id: 'mongo-backup', volumes: [v('cds-mongodb-data', '/backup')] },
    ]);
    expect(map.get('cds-mongodb-data')?.mountedBy).toEqual(['mongodb', 'mongo-backup']);
    expect(map.get('cds-mongodb-data')?.containerPath).toBe('/data/db');
    expect(map.get('cds-redis-data')?.type).toBe('volume');
  });

  it('bind 类型标记为 bind', () => {
    const map = collectProjectVolumes([
      { id: 'app', volumes: [v('/host/path', '/app/data', 'bind')] },
    ]);
    expect(map.get('/host/path')?.type).toBe('bind');
  });

  it('跳过空卷名 / 无卷服务', () => {
    const map = collectProjectVolumes([
      { id: 'a', volumes: [v('', '/x')] },
      { id: 'b' },
    ]);
    expect(map.size).toBe(0);
  });
});
