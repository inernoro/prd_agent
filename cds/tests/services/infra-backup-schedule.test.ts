import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MIN_FREE_BYTES,
  backupDirCandidates,
  backupFileName,
  buildMysqlDumpScript,
  buildRedisBackupProbeScript,
  buildRedisRdbPathScript,
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
    expect(CODE).toContain('let inFlight = false');
    expect(CODE).toMatch(/if \(inFlight\) \{/);
    expect(CODE).toMatch(/\} finally \{\s*\n[^}]*inFlight = false;/);
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
   * 凭据解析**真的跑一遍**，不是断言源码里有那几行。
   *
   * 只做字面量断言的话，把这段变成死分支（`if false`）照样全绿——那正是
   * predicate-and-wiring-discipline 里的形状 8：一份不成立的证据。
   * 这里造真的 NUL 分隔 cmdline，用真 shell 跑脚本的凭据段，看它到底抽出了什么。
   */
  const resolveCred = (cmdline: string, env: Record<string, string> = {}): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-proc-'));
    fs.mkdirSync(path.join(dir, '17'));
    fs.writeFileSync(path.join(dir, '17', 'cmdline'), cmdline);
    // 只取到 export 那一行为止：后面要连真的 redis，这里只验凭据怎么解析出来的。
    const head = SCRIPT.split('\n');
    const cut = head.findIndex((l) => l.startsWith('export REDISCLI_AUTH'));
    expect(cut).toBeGreaterThan(0);
    const prefix = `${head.slice(0, cut + 1).join('\n')}\nprintf '%s' "$REDISCLI_AUTH"`;
    return execFileSync('/bin/sh', ['-s'], {
      input: prefix,
      encoding: 'utf8',
      // PATH 必须带上：脚本要用 tr / awk，环境清空的话它们找不到，
      // 抽取会「静默返回空」——那正是这条用例要防的假象。
      env: { PATH: process.env.PATH || '/usr/bin:/bin', ...env, CDS_BACKUP_PROC_DIR: dir },
    });
  };

  it('env 拿不到密码时，从进程命令行里真的抽得出 --requirepass', () => {
    // `redis-server --requirepass secret` 且 env 里一个字都没有，是 compose 导入
    // 最常见的配法。只读 env 会拿到空密码 → NOAUTH → 每一轮备份都失败。
    expect(resolveCred('redis-server\0--requirepass\0s3cr3t\0')).toBe('s3cr3t');
  });

  it('`--requirepass=v` 连写也认', () => {
    expect(resolveCred('redis-server\0--requirepass=eqform\0')).toBe('eqform');
  });

  it('没配密码就是空，不瞎猜一个', () => {
    expect(resolveCred('redis-server\0--appendonly\0yes\0')).toBe('');
  });

  it('env 优先于命令行扫描', () => {
    expect(resolveCred('redis-server\0--requirepass\0fromcmd\0', { REDIS_PASSWORD: 'fromenv' }))
      .toBe('fromenv');
  });

  it('密码只在容器内展开，不进宿主命令行', () => {
    expect(SCRIPT).toContain('export REDISCLI_AUTH="$A"');
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
      `#!/bin/sh\ncase "$*" in\n  'CONFIG GET dir') printf 'dir\\n%s\\n' ${JSON.stringify(realDir)} ;;\n`
      + `  'CONFIG GET dbfilename') printf 'dbfilename\\n%s\\n' ${JSON.stringify(opts.dbfilename)} ;;\nesac\n`,
      { mode: 0o755 },
    );
    if (opts.touch !== false) fs.writeFileSync(path.join(realDir, opts.dbfilename), 'RDB');
    // start 是 mtime 下界：0 等于只考察「解析到哪个路径」，1 用来验「文件不在就判失败」
    // （文件缺失时 stat 失败 → mt=0，0 >= 1 不成立）。
    const tail = SCRIPT.split('\n');
    const cut = tail.findIndex((l) => l.startsWith('D=$(redis-cli CONFIG GET dir'));
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

  it('CONFIG GET 取不到时退回官方默认，不留空路径', () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-redis-empty-'));
    fs.writeFileSync(path.join(box, 'redis-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const tail = SCRIPT.split('\n');
    const cut = tail.findIndex((l) => l.startsWith('D=$(redis-cli CONFIG GET dir'));
    // 只取到 RDB 赋值为止，绕开 stat 判据——这里只看兜底值本身。
    const upto = tail.slice(cut).findIndex((l) => l.startsWith('RDB='));
    const script = `${tail.slice(cut, cut + upto + 1).join('\n')}\nprintf '%s' "$RDB"`;
    const out = execFileSync('/bin/sh', ['-s'], {
      input: script, encoding: 'utf8', env: { PATH: `${box}:${process.env.PATH}` },
    });
    expect(out).toBe('/data/dump.rdb');
  });

  it('路径上没有文件时判失败，不让宿主去拷一个不存在的东西', () => {
    const r = resolvePath({ dir: 'DATA', dbfilename: 'missing.rdb', touch: false, start: 1 });
    expect(r.status).toBe(26);
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
      "#!/bin/sh\ncase \"$*\" in\n  'CONFIG GET dir') printf 'dir\\n/var/lib/redis\\n' ;;\n"
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
