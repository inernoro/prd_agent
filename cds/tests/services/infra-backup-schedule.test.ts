import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_FREE_BYTES,
  backupFileName,
  backupKindOf,
  isAutoBackupFile,
  parseDfAvailableBytes,
  planInfraBackups,
  selectExpiredBackups,
  shouldSkipForDiskPressure,
  summarizeBackupRound,
  type BackupCandidate,
  type ExistingBackup,
} from '../../src/services/infra-backup-schedule.js';

/**
 * 基础设施周期备份的判定层。
 *
 * 守两条不变量：
 * 1. **不能把盘写满**——根盘满会同时打死所有预览、构建和 CDS 自己，比没有备份更糟。
 * 2. **不能删到一份不剩**——保留策略把最后一份也清掉，等于回到零备份，
 *    而且这种退化悄无声息。
 */

const cand = (o: Partial<BackupCandidate> & { id: string }): BackupCandidate => ({
  projectId: 'proj-a',
  containerName: `cds-infra-${o.id}`,
  dockerImage: 'mongo:8.0',
  running: true,
  ...o,
});

const NOW = new Date('2026-08-16T12:00:00.000Z');
const daysAgo = (n: number): number => NOW.getTime() - n * 24 * 60 * 60_000;

describe('选谁备份', () => {
  it('只备 mongo 与 redis，其余明说不支持而不是静默跳过', () => {
    const plan = planInfraBackups([
      cand({ id: 'mongodb' }),
      cand({ id: 'redis', dockerImage: 'redis:7-alpine' }),
      cand({ id: 'kafka', dockerImage: 'apache/kafka:3.7' }),
    ], { now: NOW });
    expect(plan.targets.map((t) => t.id)).toEqual(['mongodb', 'redis']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain('不支持');
  });

  it('没在跑的容器跳过并说明原因', () => {
    const plan = planInfraBackups([cand({ id: 'mongodb', running: false })], { now: NOW });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('未运行');
  });

  it('两类库各用各的扩展名', () => {
    expect(backupKindOf('mongo:8.0')).toBe('mongo');
    expect(backupKindOf('redis:7-alpine')).toBe('redis');
    expect(backupKindOf('mysql:8')).toBeNull();
    expect(backupFileName('mongodb', 'mongo', NOW.toISOString())).toMatch(/\.archive\.gz$/);
    expect(backupFileName('redis', 'redis', NOW.toISOString())).toMatch(/\.rdb$/);
  });

  /** 保留策略靠排序选旧的，名字排不出时间序就会删错。 */
  it('文件名的字典序等于时间序', () => {
    const early = backupFileName('x', 'mongo', '2026-08-16T09:00:00.000Z');
    const late = backupFileName('x', 'mongo', '2026-08-16T12:00:00.000Z');
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('保留策略', () => {
  const files = (count: number): ExistingBackup[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `mongodb-auto-2026081${i}T000000Z.archive.gz`,
      mtimeMs: daysAgo(i),
    }));

  it('超出份数的删掉', () => {
    const doomed = selectExpiredBackups(files(10), { id: 'mongodb', now: NOW, keepCount: 3, keepDays: 999 });
    expect(doomed).toHaveLength(7);
    // 删的是最旧的那批
    expect(doomed).toContain('mongodb-auto-20260819T000000Z.archive.gz');
  });

  it('超期的删掉', () => {
    const doomed = selectExpiredBackups(files(5), { id: 'mongodb', now: NOW, keepCount: 99, keepDays: 3 });
    expect(doomed.length).toBeGreaterThan(0);
  });

  /**
   * 闲置很久的实例，所有备份都会超期。按天数规则会被清空——那等于回到零备份，
   * 而且没有任何人会注意到。最新一份必须永远留着。
   */
  it('全部超期时仍然保留最新一份', () => {
    const old = files(4).map((f) => ({ ...f, mtimeMs: daysAgo(400) }));
    const doomed = selectExpiredBackups(old, { id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 });
    expect(doomed).toHaveLength(3);
    expect(doomed.length).toBeLessThan(old.length);
  });

  it('只有一份时什么都不删', () => {
    expect(selectExpiredBackups(files(1), { id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 })).toEqual([]);
  });

  /** restore 前的救命快照与别人的文件都不归周期清理管。 */
  it('不碰非本模块产出的文件', () => {
    const mixed: ExistingBackup[] = [
      { name: 'mongodb-auto-20260810T000000Z.archive.gz', mtimeMs: daysAgo(1) },
      { name: 'mongodb-pre-restore-20260101', mtimeMs: daysAgo(300) },
      { name: 'redis-auto-20260101T000000Z.rdb', mtimeMs: daysAgo(300) },
      { name: '别人的备份.tar', mtimeMs: daysAgo(300) },
    ];
    const doomed = selectExpiredBackups(mixed, { id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 });
    expect(doomed).toEqual([]);   // 自己只有一份，其余都不属于 mongodb 的自动备份
    expect(isAutoBackupFile('mongodb-pre-restore-20260101', 'mongodb')).toBe(false);
    expect(isAutoBackupFile('redis-auto-x.rdb', 'mongodb')).toBe(false);
  });
});

describe('磁盘闸', () => {
  it('空间充足才放行', () => {
    expect(shouldSkipForDiskPressure(50 * 1024 ** 3)).toBe(false);
    expect(shouldSkipForDiskPressure(DEFAULT_MIN_FREE_BYTES + 1)).toBe(false);
  });

  it('空间不足时跳过本轮', () => {
    expect(shouldSkipForDiskPressure(100 * 1024 * 1024)).toBe(true);
    expect(shouldSkipForDiskPressure(0)).toBe(true);
  });

  /** 读不到可用空间时不许当作充足——不确定就不写盘。 */
  it('读不到可用空间按不足处理', () => {
    expect(shouldSkipForDiskPressure(null)).toBe(true);
    expect(shouldSkipForDiskPressure(undefined)).toBe(true);
    expect(shouldSkipForDiskPressure(Number.NaN)).toBe(true);
  });

  it('解析 df 的真实输出', () => {
    const out = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      '/dev/vda1        103080204  61234567  36600000      63% /',
    ].join('\n');
    expect(parseDfAvailableBytes(out)).toBe(36600000 * 1024);
    expect(parseDfAvailableBytes('')).toBeNull();
    expect(parseDfAvailableBytes('只有一行表头')).toBeNull();
  });
});

describe('结论可读', () => {
  it('全成功也说清备了几个，不静默', () => {
    const s = summarizeBackupRound([{ id: 'a', ok: true }, { id: 'b', ok: true }], 1);
    expect(s).toContain('成功 2 个');
    expect(s).toContain('跳过 1 个');
  });

  it('失败要点名到具体服务', () => {
    const s = summarizeBackupRound([{ id: 'a', ok: true }, { id: 'mongodb', ok: false, error: 'x' }], 0);
    expect(s).toContain('mongodb');
    expect(s).toContain('失败');
  });

  it('没有目标时如实说，不装作成功', () => {
    expect(summarizeBackupRound([], 0)).toContain('没有可备份的目标');
  });
});

/** 接线守卫：判定写好没人调用，表现和「一切正常」一模一样。 */
describe('自动备份真的被启动了', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');

  it('index.ts 启动了周期备份', () => {
    expect(CODE).toMatch(/const\s+infraAutoBackup\s*=\s*startInfraAutoBackup\(/);
  });

  it('磁盘闸排在写盘之前', () => {
    const gate = CODE.indexOf('shouldSkipForDiskPressure(');
    const dump = CODE.indexOf('mongodump');
    expect(gate).toBeGreaterThan(0);
    expect(dump).toBeGreaterThan(gate);
  });

  it('落盘目录与手工备份同一处，备份历史接口不用改就能看到', () => {
    expect(CODE).toContain('/backups');
    expect(CODE).toContain('projectSlug');
  });

  it('产物为空要当失败处理，不留零字节文件冒充成功', () => {
    expect(CODE).toContain('导出产物为空');
  });
});
