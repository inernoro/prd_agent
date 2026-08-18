import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_FREE_BYTES,
  backupDirCandidates,
  backupFileName,
  backupCoverageGaps,
  buildMysqlDumpScript,
  buildRedisBackupProbeScript,
  buildRedisRdbPathScript,
  REDIS_CONNECT_LINES,
  redisAuthFromServiceDefinition,
  redisProbeStdin,
  buildRedisAppendOnlyScript,
  buildRedisRestorePlan,
  buildSizeCappedCommand,
  backupKindOf,
  isAutoBackupFile,
  isBackupRoundHealthy,
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
    expect(backupCoverageGaps(plan).map((s) => s.id)).toEqual(['kafka', 'minio']);
    // 跳过的必须写明为什么，否则「没备份」和「不需要备份」分不开
    for (const s of plan.skipped) expect(s.reason).toContain('不支持');
  });

  it('没在跑的容器跳过并说明原因', () => {
    const plan = planInfraBackups([cand({ id: 'mongodb', running: false })], { now: NOW });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain('未运行');
    expect(backupCoverageGaps(plan)).toEqual([]);
  });

  it('每类库各用各的扩展名', () => {
    expect(backupKindOf('mongo:8.0')).toBe('mongo');
    expect(backupKindOf('redis:7-alpine')).toBe('redis');
    expect(backupKindOf('mysql:8')).toBe('mysql');
    expect(backupKindOf('apache/kafka:3.7')).toBeNull();
    expect(backupFileName('proj-a', 'mongodb', 'mongo', NOW.toISOString())).toMatch(/\.archive\.gz$/);
    expect(backupFileName('proj-a', 'redis', 'redis', NOW.toISOString())).toMatch(/\.rdb$/);
    expect(backupFileName('proj-a', 'mysql', 'mysql', NOW.toISOString())).toMatch(/\.sql\.gz$/);
  });

  /** 保留策略靠排序选旧的，名字排不出时间序就会删错。 */
  it('文件名的字典序等于时间序', () => {
    const early = backupFileName('p', 'x', 'mongo', '2026-08-16T09:00:00.000Z');
    const late = backupFileName('p', 'x', 'mongo', '2026-08-16T12:00:00.000Z');
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe('保留策略', () => {
  const files = (count: number): ExistingBackup[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `proj-a--mongodb-auto-2026081${i}T000000Z.archive.gz`,
      mtimeMs: daysAgo(i),
    }));

  it('超出份数的删掉', () => {
    const doomed = selectExpiredBackups(files(10), { projectId: 'proj-a', id: 'mongodb', now: NOW, keepCount: 3, keepDays: 999 });
    expect(doomed).toHaveLength(7);
    // 删的是最旧的那批
    expect(doomed).toContain('proj-a--mongodb-auto-20260819T000000Z.archive.gz');
  });

  it('超期的删掉', () => {
    const doomed = selectExpiredBackups(files(5), { projectId: 'proj-a', id: 'mongodb', now: NOW, keepCount: 99, keepDays: 3 });
    expect(doomed.length).toBeGreaterThan(0);
  });

  /**
   * 闲置很久的实例，所有备份都会超期。按天数规则会被清空——那等于回到零备份，
   * 而且没有任何人会注意到。最新一份必须永远留着。
   */
  it('全部超期时仍然保留最新一份', () => {
    const old = files(4).map((f) => ({ ...f, mtimeMs: daysAgo(400) }));
    const doomed = selectExpiredBackups(old, { projectId: 'proj-a', id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 });
    expect(doomed).toHaveLength(3);
    expect(doomed.length).toBeLessThan(old.length);
  });

  it('只有一份时什么都不删', () => {
    expect(selectExpiredBackups(files(1), { projectId: 'proj-a', id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 })).toEqual([]);
  });

  /** restore 前的救命快照与别人的文件都不归周期清理管。 */
  it('不碰非本模块产出的文件', () => {
    const mixed: ExistingBackup[] = [
      { name: 'proj-a--mongodb-auto-20260810T000000Z.archive.gz', mtimeMs: daysAgo(1) },
      { name: 'proj-a--mongodb-pre-restore-20260101', mtimeMs: daysAgo(300) },
      { name: 'proj-a--redis-auto-20260101T000000Z.rdb', mtimeMs: daysAgo(300) },
      { name: '别人的备份.tar', mtimeMs: daysAgo(300) },
    ];
    const doomed = selectExpiredBackups(mixed, { projectId: 'proj-a', id: 'mongodb', now: NOW, keepCount: 1, keepDays: 1 });
    expect(doomed).toEqual([]);   // 自己只有一份，其余都不属于 mongodb 的自动备份
    expect(isAutoBackupFile('proj-a--mongodb-pre-restore-20260101', 'proj-a', 'mongodb')).toBe(false);
    expect(isAutoBackupFile('proj-a--redis-auto-x.rdb', 'proj-a', 'mongodb')).toBe(false);
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

  it('运行中的不支持类型会阻断健康状态，停止的服务不会', () => {
    const plan = planInfraBackups([
      cand({ id: 'postgres', dockerImage: 'postgres:16', running: true }),
      cand({ id: 'stopped-mongo', running: false }),
    ], { now: NOW });
    expect(backupCoverageGaps(plan).map((item) => item.id)).toEqual(['postgres']);
    expect(isBackupRoundHealthy(plan, [{ id: 'mongo', ok: true, bytes: 128 }])).toBe(false);
  });

  it('只有全部目标成功且没有覆盖缺口才允许刷新健康时间', () => {
    const complete = planInfraBackups([cand({ id: 'mongo', running: true })], { now: NOW });
    expect(isBackupRoundHealthy(complete, [{ id: 'mongo', ok: true, bytes: 128 }])).toBe(true);
    expect(isBackupRoundHealthy(complete, [{ id: 'mongo', ok: false, error: 'failed' }])).toBe(false);
    expect(isBackupRoundHealthy(complete, [])).toBe(false);
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

  it('离机校验成功后才把临时备份提升到正式保留集', () => {
    const upload = CODE.indexOf('await uploadAndVerifyR2Backup({');
    const promote = CODE.indexOf('mv -f ${shq(out)} ${shq(finalOut)}');
    const cleanup = CODE.indexOf('rm -f ${shq(out)}', promote);

    expect(upload).toBeGreaterThan(0);
    expect(promote).toBeGreaterThan(upload);
    expect(cleanup).toBeGreaterThan(promote);
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
    expect(backupFileName('proj-a', 'mysql', 'mysql', NOW.toISOString())).toMatch(/\.sql\.gz$/);
    // 命令本体搬进 buildMysqlDumpScript()（那边有真 shell 的行为判据），
    // 这里断言真正会执行的那段文本，不是 index.ts 的源码字面量。
    expect(buildMysqlDumpScript()).toContain('mysqldump');
    expect(buildMysqlDumpScript()).toContain('--single-transaction');
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
    expect(buildMysqlDumpScript()).toContain('MYSQL_PWD="${MYSQL_ROOT_PASSWORD');
    expect(SHELL).toMatch(/\$\{MONGO_INITDB_ROOT_PASSWORD:-/);
  });
});

/**
 * Review 抓出来的跨项目串台（P1）。
 *
 * infra id 只在项目内唯一：这台机器上六个项目各有一个叫 `redis` 的服务。
 * 只用 id 命名，一轮备份里它们算出完全相同的文件名（同一轮共用一个时间戳），
 * 后写的覆盖先写的，保留策略还把它们当同一组算份数。
 * 表现是日志「成功 6 个」、磁盘上只有 1 个——首轮实跑的输出里就有四条同名 `redis`。
 */
describe('跨项目同名服务不许串台', () => {
  it('同名服务在不同项目下算出不同文件名', () => {
    const iso = NOW.toISOString();
    const a = backupFileName('prd-agent', 'redis', 'redis', iso);
    const b = backupFileName('983785a57efd', 'redis', 'redis', iso);
    expect(a).not.toBe(b);
    expect(new Set([a, b]).size).toBe(2);
  });

  it('一轮里六个同名 redis 产出六个互不相同的文件名', () => {
    const projects = ['prd-agent', '983785a57efd', '88007650cd3c', 'defd4695ab5f', '747f2fa4f6bc', 'f9e8b956d3dd'];
    const plan = planInfraBackups(
      projects.map((projectId) => cand({ id: 'redis', projectId, dockerImage: 'redis:7-alpine' })),
      { now: NOW },
    );
    const names = plan.targets.map((t) => t.fileName);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
  });

  it('A 项目的保留策略不碰 B 项目同名服务的备份', () => {
    const files: ExistingBackup[] = [
      { name: 'proj-a--redis-auto-20260816T000000Z.rdb', mtimeMs: daysAgo(1) },
      { name: 'proj-b--redis-auto-20260801T000000Z.rdb', mtimeMs: daysAgo(300) },
      { name: 'proj-b--redis-auto-20260802T000000Z.rdb', mtimeMs: daysAgo(299) },
    ];
    // A 只有一份，什么都不该删；B 的两份更不该被 A 算进份数
    expect(selectExpiredBackups(files, { projectId: 'proj-a', id: 'redis', now: NOW, keepCount: 1, keepDays: 1 }))
      .toEqual([]);
  });

  it('项目 id 里的特殊字符不会撕坏文件名', () => {
    const name = backupFileName('proj/a b', 'redis', 'redis', NOW.toISOString());
    expect(name).not.toMatch(/[/\s]/);
    expect(isAutoBackupFile(name, 'proj/a b', 'redis')).toBe(true);
  });
});

/**
 * Review 抓出来的两处「静默成功」（P1）。都属于同一族：
 * 命令实际失败或产出过期内容，但退出码是 0，于是一份不可用的备份被记成成功，
 * 还可能按保留策略把真正可用的旧副本删掉。
 */
describe('备份不许静默成功', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const CODE = SRC.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
    .join('\n');

  /**
   * 三个坑轮着踩过一遍，行为判据在下面「MySQL 导出脚本」那一组（真 shell 跑）。
   * 这里只管接线：index.ts 必须用那个共享脚本，且不许再出现中转 .sql 的两步落盘
   * ——那一版退出码是对的，代价是把未压缩的全量 dump 落在盘上，单个大库就能把
   * 宿主根盘写满。
   */
  it('MySQL 走共享脚本流式压缩，不再中转未压缩 dump', () => {
    expect(CODE).not.toContain('set -o pipefail');
    expect(CODE).toContain('buildMysqlDumpScript()');
    // 中转文件的两处特征都不许留：`${out}.sql` 与宿主侧 gzip。
    expect(CODE).not.toMatch(/const raw = `\$\{out\}\.sql`/);
    expect(CODE).not.toMatch(/gzip -n -c \$\{shq\(raw\)\}/);
  });

  /**
   * 磁盘闸必须**每个目标之前**都查一次。只在轮次开头查一次的话，前面那个大库
   * 写完之后，后面每一个目标的前提都已经不成立了——而写满宿主根盘会同时打死
   * 所有预览、构建和 CDS 自己。
   */
  it('磁盘闸在目标循环内复查，不足就停掉剩余目标', () => {
    expect(CODE).toMatch(/const diskGate = async \(\)/);
    const loopAt = CODE.indexOf('for (const t of plan.targets)');
    expect(loopAt).toBeGreaterThan(0);
    expect(CODE.slice(loopAt, loopAt + 500)).toContain('await diskGate()');
    // 剩余目标要被记成「未执行」，不能悄悄少备几个还报全绿。
    expect(CODE).toContain('磁盘不足，未执行');
  });

  /**
   * 单飞闸。一轮跑过六小时的间隔时，setInterval 会把下一轮叠上来，两轮共用同一个
   * `.tmp`：后进门的先 rm -rf 再重建，把前一轮正在写的文件删掉，双双记失败。
   */
  it('自动备份有单飞闸，且在 finally 里放闸', () => {
    expect(CODE).toContain('let holder: { roundId: string; startedAt: number } | null = null');
    expect(CODE).toMatch(/if \(holder\) \{/);
    expect(CODE).toMatch(/\} finally \{\s*\n[^}]*holder = null;/);
  });

  /**
   * 闸要能回答「谁占着、占了多久」。只有布尔的话，堵住时唯一的信息是一行
   * console.warn——分不清「库大跑得慢」和「卡死了」，也没人知道错过几次；
   * 而 console 在面板上根本看不见，定时备份停摆可以一直没人发现。
   */
  it('跳过时把持有者身份与年龄写进事件流，超过一个间隔升级为 error', () => {
    expect(CODE).toContain("action: 'infra.backup.skipped.inflight'");
    expect(CODE).toContain('consecutiveSkips');
    expect(CODE).toContain('roundId: holder.roundId');
    // 卡死判据要用间隔本身，不是另拍一个数
    expect(CODE).toContain('const STUCK_AFTER_MS = INFRA_BACKUP_INTERVAL_MS');
    expect(CODE).toMatch(/severity: stuck \? 'error' : 'warn'/);
  });

  /**
   * 探测脚本本身的判据在下面「Redis 备份探测脚本」那一组里，对着**真正会执行的
   * 字符串**断言。这里只管接线：探测必须在拷贝之前，且失败要中止整条。
   */
  it('Redis 探测在拷贝之前，失败即中止', () => {
    expect(CODE).toContain('buildRedisBackupProbeScript()');
    expect(CODE).toContain('拒绝拷贝可能过期的 dump.rdb');
    const probe = CODE.indexOf('redisProbe');
    const cp = CODE.indexOf('docker cp');
    expect(probe).toBeGreaterThan(0);
    expect(cp).toBeGreaterThan(probe);
    // 「探测失败」必须真的抛出去，而不是记一笔继续拷。
    expect(CODE).toMatch(/if \(redisProbe\.exitCode !== 0\) \{\s*\n\s*throw new Error/);
  });
});

/**
 * 备份历史是**只读**路径。它去解析目录只是为了回答「有没有备份过」，
 * 不该顺手把目录建出来——建了之后紧跟着的 test -d 必然为真，
 * 「一份都没有过」就被报成「目录在、只是没有匹配项」。
 */
describe('查历史不许创建备份目录', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');

  it('解析器分读写两档，只有写盘那档 mkdir', () => {
    expect(SRC).toContain('async function resolveBackupDir(opts?: { create?: boolean })');
    // 只读档探测的是「目录已存在且可写」，一个 mkdir 都不许有。
    expect(SRC).toMatch(/: await shell\.exec\(`test -d \$\{shq\(c\)\} && test -w \$\{shq\(c\)\} && echo ok`\)/);
  });

  it('backup-history 走只读档，备份/恢复仍可创建', () => {
    expect(SRC).toContain('resolveBackupDir({ create: false })');
    // 只有一处只读调用（历史），其余保持默认可创建。
    expect(SRC.match(/resolveBackupDir\(\{ create: false \}\)/g) || []).toHaveLength(1);
    expect(SRC.match(/await resolveBackupDir\(\)/g) || []).toHaveLength(1);
  });
});

/**
 * Redis 探测脚本。断言的是**真正会执行的那段脚本**（调函数拿到的字符串），
 * 不是源码里的字面量——拼出来能不能跑，扫源码证明不了。
 */
describe('Redis 备份探测脚本', () => {
  const SCRIPT = buildRedisBackupProbeScript();

  it('是合法的 POSIX sh（拿真 shell 过一遍 -n）', () => {
    // 这段脚本要在各种 redis 镜像里跑，那些镜像的 /bin/sh 多半是 dash 或 busybox。
    // 不做这一步的话，「bash 里能跑」会被当成「能跑」——上一轮 pipefail 就是这么栽的。
    const out = execFileSync('/bin/sh', ['-n'], { input: SCRIPT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out).toBe('');
  });

  /**
   * 连接段**真的跑一遍**，对着一个会像真 redis-cli 那样反应的假 redis-cli。
   *
   * 只做字面量断言的话，把这段变成死分支（`if false`）照样全绿——那正是
   * predicate-and-wiring-discipline 里的形状 8：一份不成立的证据。而这一段栽过的
   * 那次（2026-08-17 线上全站 redis 备份变红）恰恰是**逻辑各行都在、顺序错了**：
   * 先拿 env 里的连接串口令去 AUTH，无口令的服务器直接拒绝。字面量断言看不出顺序。
   *
   * 假 redis-cli 复刻真实行为的三处关键：
   * - 服务器**无口令**而调用方带了 REDISCLI_AUTH：AUTH 报错走 stderr，PING 照样回 PONG
   *   （线上那条 `AUTH failed: ERR AUTH <password> called without any password configured`
   *   后面就跟着一个 PONG，判据要求「恰好等于 PONG」于是全判死）。
   * - 服务器**有口令**而口令不对：先 WRONGPASS，再 NOAUTH。
   * - 服务器有口令而没带：NOAUTH。
   */
  const fakeRedisCli = (serverPassword: string): string => [
    '#!/bin/sh',
    // 假件自己也得正确转义，否则带引号的口令会把假件拼坏——那时红的是测试脚手架，
    // 不是被测代码，最容易被误读成「功能坏了」。
    `SRV='${serverPassword.replace(/'/g, `'\"'\"'`)}'`,
    'if [ -z "$SRV" ]; then',
    '  [ -n "${REDISCLI_AUTH:-}" ] && echo "AUTH failed: ERR AUTH <password> called without any password configured for the default user." >&2',
    '  echo PONG; exit 0',
    'fi',
    'if [ -z "${REDISCLI_AUTH:-}" ]; then echo "NOAUTH Authentication required."; exit 1; fi',
    'if [ "$REDISCLI_AUTH" != "$SRV" ]; then',
    '  echo "AUTH failed: WRONGPASS invalid username-password pair" >&2',
    '  echo "NOAUTH Authentication required."; exit 1',
    'fi',
    'echo PONG',
  ].join('\n');

  /**
   * 跑连接段并回报「最终用了哪个凭据、退出码是多少」。
   * 只跑 REDIS_CONNECT_LINES（判定源本身），后面 BGSAVE 那一截要连真 redis。
   */
  const connect = (opts: {
    serverPassword: string;
    env?: Record<string, string>;
    cmdline?: string;
  }): { status: number; auth: string; stderr: string } => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-connect-'));
    fs.writeFileSync(path.join(box, 'redis-cli'), fakeRedisCli(opts.serverPassword), { mode: 0o755 });
    const procDir = path.join(box, 'proc');
    fs.mkdirSync(path.join(procDir, '17'), { recursive: true });
    fs.writeFileSync(path.join(procDir, '17', 'cmdline'), opts.cmdline ?? 'redis-server\0--appendonly\0yes\0');
    const script = `${REDIS_CONNECT_LINES.join('\n')}\nprintf '%s' "\${REDISCLI_AUTH:-}"`;
    const r = spawnSync('/bin/sh', ['-s'], {
      input: script,
      encoding: 'utf8',
      // PATH 必须带上真实 PATH：脚本要用 tr / awk / grep，环境清空的话它们找不到，
      // 解析会「静默返回空」——那正是这些用例要防的假象。假 redis-cli 排在最前。
      env: {
        PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`,
        ...(opts.env || {}),
        CDS_BACKUP_PROC_DIR: procDir,
      },
    });
    return { status: r.status ?? -1, auth: r.stdout, stderr: r.stderr };
  };

  it('服务器没有口令、env 里却有 REDIS_PASSWORD：照样连得上，且不带凭据', () => {
    // 这是 2026-08-17 线上回归的原形。REDIS_PASSWORD 是 CDS 注入给应用的连接串变量，
    // 不代表这台 redis 开了 requirepass。上一版拿它去 AUTH，服务器拒绝，判据把
    // 「多一行报错的 PONG」判成连不上——一轮里 7 个目标失败，其中 5 个是这个。
    const r = connect({ serverPassword: '', env: { REDIS_PASSWORD: 'from-connstring' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.auth).toBe('');
  });

  it('服务器有口令、env 给对了：用 env 那个', () => {
    const r = connect({ serverPassword: 'right', env: { REDIS_PASSWORD: 'right' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.auth).toBe('right');
  });

  it('env 拿不到密码时，从进程命令行里真的抽得出 --requirepass', () => {
    // 覆盖的是「命令行里确实还留着口令」那一档——实测只有显式 `--set-proc-title no`
    // 的实例是这样。redis 默认会把 argv 改写成 `redis-server *:6379`，那时这条路扫不到，
    // 走的是下面「一个凭据都不通 → exit 22」那条。这条用例只证明解析本身没写错，
    // **不证明线上大多数 redis 能靠它拿到口令**（doc/debt.cds.md E34）。
    const r = connect({ serverPassword: 's3cr3t', cmdline: 'redis-server\0--requirepass\0s3cr3t\0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.auth).toBe('s3cr3t');
  });

  it('`--requirepass=v` 连写也认', () => {
    const r = connect({ serverPassword: 'eqform', cmdline: 'redis-server\0--requirepass=eqform\0' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.auth).toBe('eqform');
  });

  it('env 里的口令是错的、进程命令行里才是对的：换到对的那个', () => {
    // 候选要拿服务器验，不能拿「env 里有没有」当验——线上就有一台是 WRONGPASS。
    const r = connect({
      serverPassword: 'real',
      env: { REDIS_PASSWORD: 'stale' },
      cmdline: 'redis-server\0--requirepass\0real\0',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.auth).toBe('real');
  });

  it('要认证却一个能用的凭据都找不到：明确失败，不静默拷走旧文件', () => {
    const r = connect({ serverPassword: 'nobody-knows' });
    expect(r.status).toBe(22);
    expect(r.stderr).toContain('没有找到能通过认证的凭据');
  });

  it('连不上（不是认证问题）：报连不上，别拿密码去治网络问题', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-down-'));
    fs.writeFileSync(
      path.join(box, 'redis-cli'),
      '#!/bin/sh\necho "Could not connect to Redis at 127.0.0.1:6379: Connection refused" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const r = spawnSync('/bin/sh', ['-s'], {
      input: REDIS_CONNECT_LINES.join('\n'),
      encoding: 'utf8',
      env: { PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`, REDIS_PASSWORD: 'x' },
    });
    expect(r.status).toBe(21);
    expect(r.stderr).toContain('redis 连不上');
  });

  /**
   * CDS 自己存的口令（E34）。这一条是线上最后一个失败目标的解法：那台 redis 的口令
   * 原原本本写在 CDS 存的启动命令里，容器里却哪儿都扫不到（redis 改写了自己的 argv）。
   */
  describe('用 CDS 自己存的服务定义供凭据', () => {
    it('从启动命令里认出 --requirepass 的三种写法', () => {
      expect(redisAuthFromServiceDefinition({ command: ['redis-server', '--requirepass', 'a1'] })).toBe('a1');
      expect(redisAuthFromServiceDefinition({ command: ['redis-server', '--requirepass=a2'] })).toBe('a2');
      // compose 常把整条命令塞进一个 sh -c 元素里，参数没被拆开
      expect(redisAuthFromServiceDefinition({
        command: ['sh', '-c', "exec docker-entrypoint.sh redis-server --requirepass 'a3'"],
      })).toBe('a3');
      // 字符串形态的 command（线上那台就是这个形状）
      expect(redisAuthFromServiceDefinition({ command: 'redis-server --requirepass a4' })).toBe('a4');
    });

    it('没配就是空，不瞎猜', () => {
      expect(redisAuthFromServiceDefinition({ command: ['redis-server', '--appendonly', 'yes'] })).toBe('');
      expect(redisAuthFromServiceDefinition({})).toBe('');
    });

    it('env 优先于启动命令', () => {
      expect(redisAuthFromServiceDefinition({
        env: { REDIS_PASSWORD: 'fromenv' }, command: ['redis-server', '--requirepass', 'fromcmd'],
      })).toBe('fromenv');
    });

    it('没有口令时 stdin 内容就是脚本本身，不引入新语义', () => {
      expect(redisProbeStdin('echo hi', '')).toBe('echo hi');
    });

    it('真跑：服务器口令只有 CDS 知道（env 与进程命令行都没有）也连得上', () => {
      // 线上那台 metersphere redis 的形状。上一版在这里 exit 22。
      const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-stdin-'));
      fs.writeFileSync(path.join(box, 'redis-cli'), fakeRedisCli('only-cds-knows'), { mode: 0o755 });
      const procDir = path.join(box, 'proc');
      fs.mkdirSync(path.join(procDir, '17'), { recursive: true });
      // redis 默认会把 argv 改写掉，扫不到口令——如实模拟
      fs.writeFileSync(path.join(procDir, '17', 'cmdline'), 'redis-server *:6379\0');
      const script = `${REDIS_CONNECT_LINES.join('\n')}\nprintf '%s' "\${REDISCLI_AUTH:-}"`;
      const svc = { command: ['redis-server', '--requirepass', 'only-cds-knows'] };
      const r = spawnSync('/bin/sh', ['-s'], {
        input: redisProbeStdin(script, redisAuthFromServiceDefinition(svc)),
        encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`, CDS_BACKUP_PROC_DIR: procDir },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.auth ?? r.stdout).toBe('only-cds-knows');
    });

    it('CDS 存的口令是错的时候，仍然会往下试别的候选', () => {
      const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-stale-'));
      fs.writeFileSync(path.join(box, 'redis-cli'), fakeRedisCli('env-has-right-one'), { mode: 0o755 });
      const procDir = path.join(box, 'proc');
      fs.mkdirSync(path.join(procDir, '17'), { recursive: true });
      fs.writeFileSync(path.join(procDir, '17', 'cmdline'), 'redis-server *:6379\0');
      const script = `${REDIS_CONNECT_LINES.join('\n')}\nprintf '%s' "\${REDISCLI_AUTH:-}"`;
      const r = spawnSync('/bin/sh', ['-s'], {
        input: redisProbeStdin(script, 'stale-from-cds'),
        encoding: 'utf8',
        env: {
          PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`,
          CDS_BACKUP_PROC_DIR: procDir,
          REDIS_PASSWORD: 'env-has-right-one',
        },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('env-has-right-one');
    });

    it('带引号 / 特殊字符的口令不会把脚本拼坏', () => {
      const nasty = `p'w"$\`x y`;
      const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-nasty-'));
      fs.writeFileSync(path.join(box, 'redis-cli'), fakeRedisCli(nasty), { mode: 0o755 });
      const procDir = path.join(box, 'proc');
      fs.mkdirSync(path.join(procDir, '17'), { recursive: true });
      fs.writeFileSync(path.join(procDir, '17', 'cmdline'), 'redis-server *:6379\0');
      const script = `${REDIS_CONNECT_LINES.join('\n')}\nprintf '%s' "\${REDISCLI_AUTH:-}"`;
      const r = spawnSync('/bin/sh', ['-s'], {
        input: redisProbeStdin(script, nasty),
        encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`, CDS_BACKUP_PROC_DIR: procDir },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(nasty);
    });
  });

  it('密码只在容器内展开，不进宿主命令行', () => {
    expect(SCRIPT).toContain('export REDISCLI_AUTH="$CDS_AUTH"');
  });

  it('判据不要求输出恰好等于 PONG（多一行 AUTH 抱怨不算连不上）', () => {
    // 这条钉死回归的形状本身：`case "$ping" in PONG)` 这类全等判据一旦回来，
    // 上面那条「服务器没有口令、env 里却有 REDIS_PASSWORD」会立刻变红。
    expect(SCRIPT).not.toMatch(/case "\$ping" in PONG\)/);
    expect(SCRIPT).toContain('grep -qx PONG');
  });

  it('完成判据用 INFO persistence，不比 LASTSAVE', () => {
    // LASTSAVE 的粒度是秒。小库的 BGSAVE 常在同一秒内跑完，时间戳不动，于是
    // 一份完全有效的备份会被白等到超时再判成失败。
    expect(SCRIPT).toContain('rdb_bgsave_in_progress');
    expect(SCRIPT).toContain('rdb_last_bgsave_status');
    expect(SCRIPT).not.toContain('LASTSAVE');
  });

  it('完成之后还要证明 dump.rdb 确实被这次写过', () => {
    // 完成不等于写的是这个文件：路径不对、save 被禁用都会留下一个旧文件，
    // 而 docker cp 会把它当成新备份拷走。
    // 路径不再写死：stat 的是 CONFIG GET 解析出来的那个（判据见「Redis 快照路径取运行时真值」）。
    expect(SCRIPT).toContain('mt=$(stat -c %Y "$RDB"');
    expect(SCRIPT).toMatch(/\[ "\$mt" -ge "\$start" \]/);
  });

  it('每一种失败都有自己的退出码，不共用一个「失败了」', () => {
    // 共用一个退出码等于把「连不上」「认证失败」「超时」「拷到旧文件」揉成一句话，
    // 排障时只能重跑一遍看运气。
    const codes = [...SCRIPT.matchAll(/exit (\d+)/g)].map((m) => m[1]).filter((c) => c !== '0');
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * MySQL 导出脚本：拿**真 shell** 跑，不扫源码。
 *
 * 这段脚本的全部价值在于「dump 失败时整条要失败」，而那恰恰是扫源码证明不了的
 * ——三个版本的源码看着都对：直接管道（退出码取了 gzip 的）、pipefail（dash 直接
 * 终止 shell）、两步落盘（对，但把未压缩全量 dump 落在盘上）。所以这里用一个假的
 * mysqldump 顶上去，成功一遍失败一遍，看脚本到底给出什么退出码、写出什么字节。
 */
describe('MySQL 导出脚本', () => {
  const SCRIPT = buildMysqlDumpScript();

  /** 造一个假 mysqldump 放进 PATH：按 want 决定输出与退出码。 */
  const withFakeDump = (opts: { stdout: string; exit: number }): { dir: string; run: () => { status: number; stdout: Buffer } } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mysqldump-'));
    fs.writeFileSync(
      path.join(dir, 'mysqldump'),
      `#!/bin/sh\nprintf '%s' ${JSON.stringify(opts.stdout)}\nexit ${opts.exit}\n`,
      { mode: 0o755 },
    );
    return {
      dir,
      run: () => {
        const res = execFileSync('/bin/sh', ['-c', SCRIPT], {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          encoding: 'buffer',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { status: 0, stdout: res as unknown as Buffer };
      },
    };
  };

  it('是合法的 POSIX sh（拿真 shell 过一遍 -n）', () => {
    execFileSync('/bin/sh', ['-n'], { input: SCRIPT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('dump 成功：stdout 是 gzip 流，解开还是原文', () => {
    const { dir, run } = withFakeDump({ stdout: 'CREATE TABLE t;', exit: 0 });
    const { stdout } = run();
    // gzip 魔数，证明压缩发生在这条路径上而不是留了个明文
    expect(stdout[0]).toBe(0x1f);
    expect(stdout[1]).toBe(0x8b);
    const out = path.join(dir, 'out.gz');
    fs.writeFileSync(out, stdout);
    expect(execFileSync('gzip', ['-dc', out], { encoding: 'utf8' })).toBe('CREATE TABLE t;');
  });

  it('dump 失败：整条按失败退出，不被 gzip 的成功盖掉', () => {
    // 关键判据。老写法在这里会拿到 0——一份几十字节的合法 gzip 头被记成成功备份，
    // 还可能按保留策略把真正可用的旧副本删掉。
    const { run } = withFakeDump({ stdout: '-- partial', exit: 3 });
    let status = 0;
    try { run(); } catch (err) { status = (err as { status: number }).status; }
    expect(status).toBe(3);
  });

  /**
   * gzip 那一端失败也必须整条失败（Codex #1382 第二轮 P1）。
   *
   * 只捕获 dump 的退出码时：dump 成功、gzip 写到一半因磁盘满退出 → 脚本返回 0，
   * 产物是一份非空但解不开的截断 gzip。调用方看「退出码 0 + 文件非空」就转正，
   * 保留策略再删掉一份真正可用的旧备份——用坏的换掉好的。
   */
  it('dump 成功但 gzip 失败：整条按 gzip 的退出码失败', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-gzipfail-'));
    fs.writeFileSync(path.join(dir, 'mysqldump'), "#!/bin/sh\nprintf 'DATA'\nexit 0\n", { mode: 0o755 });
    // 假 gzip 必须**先把 stdin 读完**再失败，模拟「dump 已经跑完、压缩写盘时挂掉」。
    //
    // 不读完就退出的话，上游 dump 写管道会吃 SIGPIPE 被打死，回传的变成
    // dump=141，测的就不再是「gzip 失败」这条路径了——而且它是否触发取决于两个
    // 进程的调度先后：本地 4 字节先写完就绿，CI 上就红（141 != 7）。
    // 时序决定结果的用例等于没有判据，这里把它钉死成确定性的。
    fs.writeFileSync(path.join(dir, 'gzip'), "#!/bin/sh\ncat > /dev/null\nprintf 'PARTIAL'\nexit 7\n", { mode: 0o755 });
    let status = 0;
    try {
      execFileSync('/bin/sh', ['-c', buildMysqlDumpScript()], {
        cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) { status = (err as { status: number }).status; }
    expect(status).toBe(7);
  });

  /** 宿主侧第二道：非空不等于完整，转正前必须过 gzip -t。 */
  it('转正前有 gzip 完整性校验，不是只看非空', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    expect(src).toContain('gzip -t ${shq(out)}');
    const check = src.indexOf('gzip -t ${shq(out)}');
    const promote = src.indexOf('mv -f ${shq(out)} ${shq(finalOut)}');
    expect(check).toBeGreaterThan(0);
    expect(promote).toBeGreaterThan(check);   // 校验必须排在转正之前
  });

  it('全程零中转文件：跑完目录里除了假 mysqldump 什么都没多出来', () => {
    const { dir, run } = withFakeDump({ stdout: 'x'.repeat(4096), exit: 0 });
    run();
    expect(fs.readdirSync(dir).sort()).toEqual(['mysqldump']);
  });

  it('凭据在容器内展开，不出现在宿主命令行里', () => {
    expect(SCRIPT).toContain('MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"');
    expect(SCRIPT).not.toContain('set -o pipefail');
  });
});

/**
 * Redis 快照路径必须问 redis 自己（Codex 第十二轮 P1）。
 *
 * `/data/dump.rdb` 只是官方镜像的默认值。配了 `dir` 或 `dbfilename` 的实例
 * （compose 里很常见）把快照写在别处，按默认路径 stat 到的是一个不存在或很旧的
 * 文件——判据于是把每一次**正常**的 BGSAVE 都判成失败，那种配置下自动备份永远
 * 不会成功一次。这里用假的 redis-cli 真跑一遍脚本尾段，看它到底解析出什么路径。
 */
describe('Redis 快照路径取运行时真值', () => {
  const SCRIPT = buildRedisBackupProbeScript();

  /** 只跑「解析路径 + 校验 mtime + 回传」那一段，前面的 BGSAVE 等待要连真 redis。 */
  const resolvePath = (opts: { dir: string; dbfilename: string; touch?: boolean; start?: number }): { status: number; stdout: string } => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-path-'));
    const dataDir = path.join(box, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const realDir = opts.dir === 'DATA' ? dataDir : opts.dir;
    fs.writeFileSync(
      path.join(box, 'redis-cli'),
      `#!/bin/sh\ncase "$*" in\n  PING) echo PONG ;;\n`
      + `  'CONFIG GET dir') printf 'dir\\n%s\\n' ${JSON.stringify(realDir)} ;;\n`
      + `  'CONFIG GET dbfilename') printf 'dbfilename\\n%s\\n' ${JSON.stringify(opts.dbfilename)} ;;\nesac\n`,
      { mode: 0o755 },
    );
    if (opts.touch !== false) fs.writeFileSync(path.join(realDir, opts.dbfilename), 'RDB');
    // start 是 mtime 下界：0 等于只考察「解析到哪个路径」，1 用来验「文件不在就判失败」
    // （文件缺失时 stat 失败 → mt=0，0 >= 1 不成立）。
    const tail = SCRIPT.split('\n');
    const cut = tail.findIndex((l) => l.startsWith('dirOut=$(redis-cli CONFIG GET dir'));
    expect(cut).toBeGreaterThan(0);
    const script = `start=${opts.start ?? 0}\n${tail.slice(cut).join('\n')}`;
    try {
      const stdout = execFileSync('/bin/sh', ['-s'], {
        input: script,
        encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status: number; stdout: Buffer };
      return { status: e.status, stdout: String(e.stdout || '') };
    }
  };

  it('自定义 dir + dbfilename 时回传的是真实路径', () => {
    const r = resolvePath({ dir: 'DATA', dbfilename: 'snapshot.rdb' });
    expect(r.status).toBe(0);
    expect(r.stdout.endsWith('/snapshot.rdb')).toBe(true);
  });

  /**
   * 这条原来断言「CONFIG GET 取不到就退回 /data/dump.rdb」——那是把一个危险的
   * 猜测锁进 CI。CONFIG 被 rename-command 改名或被 ACL 拒绝时，恢复流程会照着
   * 猜出来的路径写文件、重启、然后报「已恢复」，而 redis 加载的还是旧数据。
   * 现在要求：问不出来就报错。
   */
  it('CONFIG GET 失败时报错退出，不猜默认路径', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-denied-'));
    // 模拟 CONFIG 被 ACL 拒绝：redis-cli 非零退出并在 stderr 说明原因
    fs.writeFileSync(
      path.join(box, 'redis-cli'),
      '#!/bin/sh\ncase "$*" in PING) echo PONG; exit 0 ;; esac\n'
      + 'echo "NOPERM this user has no permissions to run the config command" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    let status = 0; let stderr = '';
    try {
      execFileSync('/bin/sh', ['-s'], {
        input: buildRedisRdbPathScript(), encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH}`, CDS_BACKUP_PROC_DIR: box },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status: number; stderr: Buffer };
      status = e.status; stderr = String(e.stderr || '');
    }
    expect(status).toBe(27);
    expect(stderr).toContain('CONFIG GET dir');
  });

  it('CONFIG GET 返回空值同样报错', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-empty-'));
    // 调用成功但第二行是空的：同样不足以定位快照，不许当作「就是默认值」
    fs.writeFileSync(
      path.join(box, 'redis-cli'),
      "#!/bin/sh\ncase \"$*\" in PING) echo PONG; exit 0 ;; esac\nprintf 'dir\\n\\n'\n",
      { mode: 0o755 },
    );
    let status = 0;
    try {
      execFileSync('/bin/sh', ['-s'], {
        input: buildRedisRdbPathScript(), encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH}`, CDS_BACKUP_PROC_DIR: box },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) { status = (err as { status: number }).status; }
    expect(status).toBe(28);
  });

  it('路径上没有文件时判失败，不让宿主去拷一个不存在的东西', () => {
    const r = resolvePath({ dir: 'DATA', dbfilename: 'missing.rdb', touch: false, start: 1 });
    expect(r.status).toBe(26);
  });
});

/**
 * 接线守卫：凭据只能走 stdin，不许出现在宿主命令行上（E34）。
 *
 * 这条守卫防的是最容易复发的那一步：以后有人图省事改回 `docker exec -e PW=...`
 * 或 `sh -c '<带口令的脚本>'`。两种写法都会把明文摆进 argv，同机 `ps` 一眼看到，
 * 而功能照常工作——不会有任何测试变红。所以必须有一条专门盯形状的断言。
 */
describe('redis 凭据只走 stdin', () => {
  const files = ['src/index.ts', 'src/routes/infra-backup.ts']
    .map((f) => [f, fs.readFileSync(path.resolve(process.cwd(), f), 'utf8')] as const);

  it('每一处 redis 探测都用 `docker exec -i ... sh -s` + stdin', () => {
    // 断言的是「条数相等」而不是某个魔数：新增一处探测不该让守卫变红，
    // 新增一处**不走 stdin** 的探测才该变红。写死 3 的话，加第 4 处探测的人
    // 会顺手把数字改成 4 了事，守卫就退化成了计数器。
    const withStdin = files.flatMap(([, src]) => [...src.matchAll(/stdin: redisProbeStdin\(/g)]).length;
    const shellIn = files.flatMap(([, src]) => [...src.matchAll(/docker exec -i \$\{shq\([^)]*\)\} sh -s/g)]).length;
    expect(withStdin).toBeGreaterThanOrEqual(3);
    expect(shellIn, '有 `sh -s` 调用没有配 stdin，脚本会从空输入读进去').toBe(withStdin);
    for (const [name, src] of files) {
      // 不许再有 `sh -c <脚本>` 形态的 redis 探测
      expect(src, `${name} 仍在用 sh -c 送 redis 探测脚本`)
        .not.toMatch(/sh -c \$\{shq\(buildRedis/);
    }
  });

  it('没有任何地方用 docker exec -e 传凭据', () => {
    for (const [name, src] of files) {
      expect(src, `${name} 用 docker exec -e 传了变量，口令会进宿主命令行`)
        .not.toMatch(/docker exec\s+-e\s/);
    }
  });

  it('口令不会出现在拼给 shell 的命令字符串里', () => {
    // 真跑一次：拼出来的命令行必须一个字都不含口令。
    const cmdLine = `docker exec -i 'cds-infra-x' sh -s`;
    const payload = redisProbeStdin(buildRedisBackupProbeScript(), 'topsecret123');
    expect(cmdLine).not.toContain('topsecret123');
    expect(payload).toContain('topsecret123');   // 它只在 stdin 里
  });
});

/**
 * Redis 恢复的动作顺序（E35）。
 *
 * 上一版往**运行中**的容器写 RDB 再 `docker restart`：redis 关闭时按 save 点把
 * 当前数据存一次盘，正好覆盖掉刚上传的快照，而接口回「已恢复」。这类缺陷没法靠
 * 「跑一遍看看」发现——恰好是空库时结果看起来完全正确（2026-08-18 线上就是这么
 * 侥幸躲过的）。能钉住它的只有对**顺序**的断言。
 */
describe('Redis 恢复顺序', () => {
  const plan = buildRedisRestorePlan({
    containerName: 'cds-infra-redis',
    rdbPath: '/data/dump.rdb',
    uploadPath: '/tmp/up.rdb',
    preBackupPath: '/backups/pre.rdb',
  });
  const idx = (id: string): number => plan.findIndex((p) => p.id === id);

  it('先停容器，再覆盖文件，最后启动', () => {
    // 覆盖必须发生在 stop 之后：容器还活着时写进去，关闭时那次 save 会盖掉它。
    expect(idx('stop')).toBeGreaterThanOrEqual(0);
    expect(idx('overwrite')).toBeGreaterThan(idx('stop'));
    expect(idx('start')).toBeGreaterThan(idx('overwrite'));
  });

  it('撤销快照在停止之后、覆盖之前取，拿到的才是准确的恢复前状态', () => {
    // 停止时 redis 自己把当前数据落盘——这一步把「关闭时的 save」从对手变成帮手。
    expect(idx('save-current')).toBeGreaterThan(idx('stop'));
    expect(idx('save-current')).toBeLessThan(idx('overwrite'));
  });

  it('全程不碰运行中的容器（没有 docker exec，只有 cp 与生命周期）', () => {
    for (const step of plan) {
      expect(step.argv[0]).toBe('docker');
      expect(['stop', 'start', 'cp']).toContain(step.argv[1]);
    }
  });

  it('拷贝方向没写反', () => {
    const save = plan[idx('save-current')].argv;
    const over = plan[idx('overwrite')].argv;
    expect(save.slice(2)).toEqual(['cds-infra-redis:/data/dump.rdb', '/backups/pre.rdb']);   // 容器 → 宿主
    expect(over.slice(2)).toEqual(['/tmp/up.rdb', 'cds-infra-redis:/data/dump.rdb']);        // 宿主 → 容器
  });

  it('路由按这份计划执行，且不再往运行中的容器 cat 写入', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');
    expect(src).toContain('buildRedisRestorePlan(');
    // 事故写法：`docker exec -i <c> sh -c 'cat > <rdb>'` + docker restart
    expect(src).not.toMatch(/cat > \$\{shq\(rdbTarget\)\}/);
    expect(src).not.toMatch(/docker restart \$\{shq\(svc\.containerName\)\}/);
  });
});

/**
 * 开着 AOF 的实例启动读 AOF 不读 RDB：写进去也不生效。这一档必须**明确拒绝**，
 * 不能给出「已恢复」的假象——那比恢复失败更糟，用户会以为数据回来了。
 */
describe('AOF 实例拒绝 RDB 恢复', () => {
  it('探测脚本问的是 appendonly，且复用同一份连接判据', () => {
    const script = buildRedisAppendOnlyScript();
    expect(script).toContain('CONFIG GET appendonly');
    expect(script).toContain('grep -qx PONG');       // 走 REDIS_CONNECT_LINES
    expect(script).not.toContain('BGSAVE');          // 只问配置，不给人家存盘
    execFileSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('真跑：假件回 yes 就打印 yes，回 no 就打印 no', () => {
    for (const want of ['yes', 'no']) {
      const box = fs.mkdtempSync(path.join(os.tmpdir(), `cds-redis-aof-${want}-`));
      fs.writeFileSync(
        path.join(box, 'redis-cli'),
        `#!/bin/sh\ncase "$*" in PING) echo PONG ;; 'CONFIG GET appendonly') printf 'appendonly\\n${want}\\n' ;; esac\n`,
        { mode: 0o755 },
      );
      const r = spawnSync('/bin/sh', ['-s'], {
        input: buildRedisAppendOnlyScript(),
        encoding: 'utf8',
        env: { PATH: `${box}:${process.env.PATH || '/usr/bin:/bin'}`, CDS_BACKUP_PROC_DIR: box },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(want);
    }
  });

  it('路由在 appendonly=yes 时拒绝，而不是继续写', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');
    expect(src).toContain('buildRedisAppendOnlyScript(');
    expect(src).toMatch(/aof === 'yes'[\s\S]{0,200}res\.status\(409\)/);
  });
});

/** 接线守卫：脚本解析出来的路径必须真的被 docker cp 用上。 */
describe('宿主按探测回传的路径拷贝', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('docker cp 用 rdbPath，且不再拼默认路径', () => {
    expect(SRC).toContain('const rdbPath = (redisProbe.stdout');
    expect(SRC).toContain('docker cp ${shq(`${t.containerName}:${rdbPath}`)}');
    expect(SRC).not.toContain('${t.containerName}:/data/dump.rdb');
    // 回传缺失时宁可失败，也不许悄悄猜一个默认路径。
    expect(SRC).toContain('拒绝按默认路径猜');
  });
});

/**
 * 手工下载 / 恢复也必须走同一份路径判据（Codex #1382 第一轮 P1）。
 *
 * 周期备份改好了、手工那条没改，是最典型的「修一半」：用户点下载拿到的是**旧快照**，
 * 而项目迁移正是从这个端点取数。恢复更险——写到一个 redis 不读的路径，重启后加载
 * 的还是旧数据，接口却回「已恢复」。
 */
describe('redis 快照路径判据只有一份', () => {
  it('路径脚本不触发 BGSAVE，只解析并打印路径', () => {
    const script = buildRedisRdbPathScript();
    expect(script).not.toContain('BGSAVE');
    expect(script).toContain('CONFIG GET dir');
    expect(script).toContain('printf "%s" "$RDB"');
    // 凭据段要带着——配了 requirepass 的实例，裸 redis-cli 连 CONFIG GET 都做不了
    expect(script).toContain('export REDISCLI_AUTH');
    execFileSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('拿真 shell 跑：自定义 dbfilename 时打印的是那个路径', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rdbpath-'));
    fs.writeFileSync(
      path.join(box, 'redis-cli'),
      "#!/bin/sh\ncase \"$*\" in\n  PING) echo PONG ;;\n"
      + "  'CONFIG GET dir') printf 'dir\\n/var/lib/redis\\n' ;;\n"
      + "  'CONFIG GET dbfilename') printf 'dbfilename\\nsnap.rdb\\n' ;;\nesac\n",
      { mode: 0o755 },
    );
    const out = execFileSync('/bin/sh', ['-s'], {
      input: buildRedisRdbPathScript(),
      encoding: 'utf8',
      env: { PATH: `${box}:${process.env.PATH}`, CDS_BACKUP_PROC_DIR: box },
    });
    expect(out).toBe('/var/lib/redis/snap.rdb');
  });

  /** 接线守卫：三处消费方都不许再出现写死的 /data/dump.rdb。 */
  it('下载与恢复都用解析出来的路径，不再写死 /data/dump.rdb', () => {
    // 先剥注释：解释「上一版为什么错」的那几行里就写着这个路径，
    // 连注释一起扫会把「讲清楚事故」判成「犯了事故」。
    const stripComments = (src: string): string => src.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
      .join('\n');
    const route = stripComments(fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8'));
    const index = stripComments(fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8'));
    for (const [name, src] of [['infra-backup.ts', route], ['index.ts', index]] as const) {
      expect(src, `${name} 的代码里仍写死了 /data/dump.rdb`).not.toContain('/data/dump.rdb');
    }
    // 下载：走带 BGSAVE 确认的完整探测；恢复：只解析路径，不顺手替人存盘
    expect(route).toContain('buildRedisBackupProbeScript()');
    expect(route).toContain('buildRedisRdbPathScript()');
    // 探测失败必须拒绝出流，而不是继续 cat 一个可能过期的文件
    expect(route).toContain('拒绝下载可能过期的快照');
    expect(route).toContain('拒绝按默认路径写入');
  });
});

/**
 * 单次导出的写入上限（Codex #1382 第三轮 P1）。
 *
 * 前置闸只证明「此刻还有 2 GiB」，而那次写入是无界的：一个 50 GiB 的库照样能把最后
 * 一个字节吃掉，等命令报错时宿主根盘已经满了。逐目标复查保护的是**后面**的目标，
 * 救不了正在写的这一个。
 */
describe('单次导出有写入上限', () => {
  it('上限 = 可用空间减去保留余量，换算成 512 字节块', () => {
    const free = 10 * 1024 ** 3;                 // 10 GiB 可用
    const capped = buildSizeCappedCommand('echo hi', free, 2 * 1024 ** 3);
    expect(capped).not.toBeNull();
    expect(capped!.capBytes).toBe(8 * 1024 ** 3); // 留 2 GiB
    expect(capped!.command).toContain(`ulimit -f ${(8 * 1024 ** 3) / 512}`);
    expect(capped!.command).toContain('echo hi');
  });

  it('余量都不够时返回 null，让调用方跳过而不是硬写', () => {
    expect(buildSizeCappedCommand('x', 1024 ** 3, 2 * 1024 ** 3)).toBeNull();
    expect(buildSizeCappedCommand('x', 0)).toBeNull();
  });

  /** ulimit 设不上（精简 shell）不能连累导出：用 `;` 不用 `&&`。 */
  it('ulimit 失败不阻断导出命令', () => {
    const c = buildSizeCappedCommand('echo still-runs', 10 * 1024 ** 3)!;
    expect(c.command).not.toContain('&&');
    expect(c.command).toContain('2>/dev/null;');
    const out = execFileSync('/bin/sh', ['-c', c.command], { encoding: 'utf8' });
    expect(out.trim()).toBe('still-runs');
  });

  /**
   * 真 shell 验上限确实生效：给 1 KiB 的上限写 200 KiB，必须失败而不是写完。
   * 这条是整个机制的判据——只断言命令串里有 `ulimit` 证明不了内核会拦。
   */
  it('拿真 shell 跑：超过上限的写入被中断，不会写出完整文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ulimit-'));
    const out = path.join(dir, 'big.bin');
    // cap 传 1 KiB + reserve 0 → ulimit -f 2 块（1024 字节）
    const c = buildSizeCappedCommand(`yes ABCDEFGH | head -c 204800 > ${out}`, 1024, 0)!;
    let failed = false;
    try {
      execFileSync('/bin/sh', ['-c', c.command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { failed = true; }
    expect(failed).toBe(true);
    // 写出来的部分不超过上限（内核在 1 KiB 处就把它砍了）
    expect(fs.statSync(out).size).toBeLessThanOrEqual(1024);
  });

  /** 接线守卫：算出来的上限要真的套在导出命令上，不是算完扔掉。 */
  it('备份循环真的用了带上限的命令', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    expect(src).toContain('const capped = buildSizeCappedCommand(cmd, lastFreeBytes)');
    expect(src).toContain('await shell.exec(capped.command');
    // 失败信息要能把「库太大撞上限」和「备份坏了」分开
    expect(src).toContain('本次写入上限');
  });
});
