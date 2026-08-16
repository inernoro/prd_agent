import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_FREE_BYTES,
  backupDirCandidates,
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
  it('只备有一致性导出手段的类型，其余明说不支持而不是静默跳过', () => {
    const plan = planInfraBackups([
      cand({ id: 'mongodb' }),
      cand({ id: 'redis', dockerImage: 'redis:7-alpine' }),
      cand({ id: 'mysql', dockerImage: 'mysql:8' }),
      cand({ id: 'kafka', dockerImage: 'apache/kafka:3.7' }),
      cand({ id: 'minio', dockerImage: 'minio/minio:latest' }),
    ], { now: NOW });
    expect(plan.targets.map((t) => t.id)).toEqual(['mongodb', 'redis', 'mysql']);
    expect(plan.skipped.map((s) => s.id)).toEqual(['kafka', 'minio']);
    // 跳过的必须写明为什么，否则「没备份」和「不需要备份」分不开
    for (const s of plan.skipped) expect(s.reason).toContain('不支持');
  });

  it('没在跑的容器跳过并说明原因', () => {
    const plan = planInfraBackups([cand({ id: 'mongodb', running: false })], { now: NOW });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('未运行');
  });

  it('每类库各用各的扩展名', () => {
    expect(backupKindOf('mongo:8.0')).toBe('mongo');
    expect(backupKindOf('redis:7-alpine')).toBe('redis');
    expect(backupKindOf('mysql:8')).toBe('mysql');
    expect(backupKindOf('apache/kafka:3.7')).toBeNull();
    expect(backupFileName('mongodb', 'mongo', NOW.toISOString())).toMatch(/\.archive\.gz$/);
    expect(backupFileName('redis', 'redis', NOW.toISOString())).toMatch(/\.rdb$/);
    expect(backupFileName('mysql', 'mysql', NOW.toISOString())).toMatch(/\.sql\.gz$/);
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

  /**
   * 断言的是「两边走同一份候选」这个不变量，不是某段路径字面量——
   * 路径搬家是合理重构，不该让守卫变红；两边分叉才该变红。
   */
  it('自动备份与手工备份解析同一份目录候选', () => {
    const manual = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');
    expect(CODE).toContain('backupDirCandidates(');
    expect(manual).toContain('backupDirCandidates(');
    // 两边都不许再写死历史路径
    for (const src of [CODE, manual]) {
      expect(src).not.toMatch(/`\/data\/cds\/\$\{stateService\.projectSlug\}\/backups`/);
    }
  });

  it('产物为空要当失败处理，不留零字节文件冒充成功', () => {
    expect(CODE).toContain('导出产物为空');
  });
});

/**
 * 备份目录候选。
 *
 * 真实事故（2026-08-16）：目录写死 `/data/cds/<slug>/backups`，那个路径在宿主上
 * 不存在，而手工备份的 `ls` 带着 `2>/dev/null` —— 目录不存在时返回的空列表，与
 * 「备份过但没有匹配项」长得一模一样。于是「一份备份都没有」可以一直不被发现。
 */
describe('备份目录候选', () => {
  it('显式指定优先级最高', () => {
    const c = backupDirCandidates({ slug: 'x', repoRoot: '/root/app', env: { CDS_BACKUP_DIR: '/mnt/bak' } });
    expect(c[0]).toBe('/mnt/bak');
  });

  it('历史路径仍在候选里，存量部署不受影响', () => {
    expect(backupDirCandidates({ slug: 'prd-agent', env: {} })).toContain('/data/cds/prd-agent/backups');
  });

  /** 兜底放在 repoRoot **旁边**而不是里面：里面会被 git 操作与自更新波及。 */
  it('给出可写兜底，且不落在 repoRoot 内部', () => {
    const c = backupDirCandidates({ slug: 'x', repoRoot: '/root/inernoro/prd_agent', env: {} });
    const fallback = c[c.length - 1];
    expect(fallback).toBe('/root/inernoro/cds-backups/x');
    expect(fallback.startsWith('/root/inernoro/prd_agent/')).toBe(false);
  });

  it('候选不重复（显式指定恰好等于历史路径时）', () => {
    const c = backupDirCandidates({ slug: 'x', env: { CDS_BACKUP_DIR: '/data/cds/x/backups' } });
    expect(new Set(c).size).toBe(c.length);
  });

  it('尾部斜杠不会拼出双斜杠', () => {
    expect(backupDirCandidates({ slug: 'x', env: { CDS_BACKUP_DIR: '/mnt/bak/' } })[0]).toBe('/mnt/bak');
  });
});

describe('目录与磁盘失败必须说清原因', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');

  it('逐个候选试写，而不是写死单一路径', () => {
    expect(CODE).toContain('backupDirCandidates(');
    expect(CODE).not.toMatch(/const dir = `\/data\/cds\/\$\{stateService\.projectSlug\}/);
  });

  /** 只说「读不到」，下一个人除了重跑一遍没有别的办法。 */
  it('df 失败时带上退出码与 stderr', () => {
    expect(CODE).toContain('dfExitCode');
    expect(CODE).toContain('dfStderr');
  });

  it('没有可写目录时列出试过哪些、并指出逃生阀', () => {
    expect(CODE).toContain("action: 'infra.backup.skipped.nodir'");
    expect(CODE).toContain('CDS_BACKUP_DIR');
  });
});

/**
 * 首轮实跑抓出来的两件事。单测当时全绿——这两个都是只有真跑才会暴露的形状。
 */
describe('首轮实跑暴露的缺陷', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
    .join('\n');

  /**
   * 台账里表示存活的字段叫 `status`，不是 `running`。直接把台账对象丢进
   * `planInfraBackups`，`running === false` 这一档永远不成立——一个已停止的 mongo
   * 因此被当成目标，`docker exec` 报 No such container。
   *
   * 可选字段缺省即 undefined，编译器发现不了这种字段名对不上。
   */
  it('调用点把台账的 status 映射成 running', () => {
    expect(CODE).toMatch(/running:\s*s\.status === 'running'/);
  });

  it('已停止的目标确实会被判定层剔除（映射之后这一档才生效）', () => {
    const ledgerLike = [{ id: 'm', projectId: 'p', containerName: 'c', dockerImage: 'mongo:8', status: 'stopped' }];
    const mapped = ledgerLike.map((s) => ({ ...s, running: s.status === 'running' }));
    expect(planInfraBackups(mapped, { now: NOW }).targets).toHaveLength(0);
    // 不映射就会漏进去——这正是首轮的失败原因
    expect(planInfraBackups(ledgerLike as never, { now: NOW }).targets).toHaveLength(1);
  });

  it('MySQL 纳入备份范围（四个项目的库此前完全没有自动备份）', () => {
    expect(backupKindOf('mysql:8')).toBe('mysql');
    expect(backupKindOf('mariadb:11')).toBe('mysql');
    expect(backupFileName('mysql', 'mysql', NOW.toISOString())).toMatch(/\.sql\.gz$/);
    expect(CODE).toContain('mysqldump');
    expect(CODE).toContain('--single-transaction');
  });

  /**
   * 凭据必须在**容器内部**展开：不进宿主命令行（因而不进 CDS 日志与宿主 ps），
   * 也不依赖 CDS 台账里那份 env——台账看不到 compose 导入 / 手工起的容器的真实
   * 凭据，照台账取会在有认证的库上静默失败。
   */
  it('备份命令不把凭据插进宿主命令行', () => {
    // 判据要盯「从台账取凭据」这个动作本身，别用 `-p ${shq(` 这种形状去猜——
    // 它会把 `mkdir -p ${shq(dir)}` 一起匹配上（判据太宽，今天已经栽过同款）。
    expect(CODE).not.toMatch(/const pw = env\./);
    expect(CODE).not.toMatch(/MONGO_INITDB_ROOT_PASSWORD \|\| env\./);
    // TS 源码里 `$` 写成 `${'$'}` 转义。断言必须针对**渲染出来的 shell 文本**，
    // 不是源码字面量——直接扫源码就是在读一个和运行时不同的值（今天栽过同款）。
    const SHELL = CODE.replace(/\$\{'\$'\}/g, '$');
    expect(SHELL).toContain('MYSQL_PWD="${MYSQL_ROOT_PASSWORD');
    expect(SHELL).toMatch(/\$\{MONGO_INITDB_ROOT_PASSWORD:-/);
  });
});
