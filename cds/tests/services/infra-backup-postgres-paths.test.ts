import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  backupKindOf,
  backupFileName,
  buildPostgresDumpScript,
  buildPostgresRestoreScript,
  buildPostgresTableCountScript,
  extractBackupGapNote,
  extractBackupScopeNote,
  summarizeBackupRound,
} from '../../src/services/infra-backup-schedule.js';
import { scriptedDump } from '../../src/routes/infra-backup.js';

/**
 * postgres 的备份缺口。
 *
 * 它是 CDS 的一等预设（`infra-catalog` 里排在 mysql 前面），但备份判据只认
 * mongo / redis / mysql，于是：
 *
 * - 周期备份把它记进「暂不支持的类型」，整轮健康长期红着——**红着不等于备着**，
 *   磁盘上一份 postgres 备份都没有；
 * - 手工下载掉进兜底的 `tar -C /data`，而 postgres 的数据在 /var/lib/postgresql/data，
 *   于是下载得到一个空壳、HTTP 还是 200（和 mysql 的 E41 一模一样的形状）；
 * - 恢复端点直接 400「暂不支持」。
 *
 * 本文件守住修好之后的三件事：判据认得它、脚本真的能跑、覆盖范围如实报出来。
 */
const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');

describe('postgres 进入备份判据', () => {
  it('判据认得 postgres / timescale，扩展名是 .sql.gz', () => {
    expect(backupKindOf('postgres:16-alpine')).toBe('postgres');
    expect(backupKindOf('timescale/timescaledb:latest-pg16')).toBe('postgres');
    expect(backupFileName('proj', 'postgres', 'postgres', '2026-08-21T00:00:00.000Z'))
      .toMatch(/\.sql\.gz$/);
  });

  it('镜像名认不出时用服务 id / 容器名兜底', () => {
    // 私有仓库的镜像名里可能一个产品名都没有。只看 image 会把一台真库判成
    // 「不认识的类型」直接跳过——那是静默零备份，比失败更难发现。
    expect(backupKindOf('registry.internal/db@sha256:abc')).toBeNull();
    expect(backupKindOf('registry.internal/db@sha256:abc', { id: 'postgres' })).toBe('postgres');
    expect(backupKindOf('registry.internal/db@sha256:abc', { containerName: 'proj-postgres-1' }))
      .toBe('postgres');
  });

  it('下载与恢复都走同一段 pg_dump 脚本，不是 tar /data', () => {
    // 断在「路由取到的脚本 === 周期备份那一段」这个事实上，而不是断在某个文件里
    // 还有没有那一行调用——路由改成查表取脚本时，字面量断言会变红而它守的事没变。
    expect(scriptedDump('postgres')?.dump()).toBe(buildPostgresDumpScript());
    expect(scriptedDump('postgres')?.restore('/tmp/x.sql.gz'))
      .toBe(buildPostgresRestoreScript('/tmp/x.sql.gz'));
  });
});

/**
 * 真跑一遍脚本，而不是读它长什么样。
 *
 * psql 这里有一个 mysql 侧没有的坑：**它默认遇错继续，跑完照样 exit 0**。
 * 一份灌到一半全是错的 dump，psql 把错误打在 stderr 上然后返回 0，
 * 调用方读到 0 就报「已恢复」——本文件被烧过三次的那种假成功，
 * 而且这一次连管道退出码都救不了，因为撒谎的就是最后一环自己。
 *
 * 所以这里在 PATH 前面塞假的 psql / pg_dump / gunzip / gzip，用真 `sh` 把脚本跑一遍，
 * 直接断言退出码与实际用到的账号。
 */
describe('postgres 脚本：真跑一遍', () => {
  const PRESET_ENV = { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'appdb' };

  interface Stubs {
    /** psql `SELECT 1` 探活的退出码——非零表示连不上。 */
    probeExit?: number;
    /** psql 灌库那一次的退出码。 */
    psqlExit?: number;
    /** 假 gunzip：`-t` 完整性校验的退出码。 */
    testExit?: number;
    /** 假 gunzip：`-c` 解压的退出码。 */
    catExit?: number;
    /** 假 pg_dump 的退出码。 */
    dumpExit?: number;
    /** 假 gzip 的退出码。 */
    gzipExit?: number;
    /** 同实例其它库的查询结果（空串 = 只有这一个库）。 */
    otherDbs?: string;
    env?: Record<string, string>;
  }

  function run(script: (dir: string) => string, s: Stubs): {
    code: number; stderr: string; stdout: string; pgUser: string; pgDb: string; onErrorStop: boolean;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pg-'));
    try {
      // 假 psql：三种用法要分开——`-tAc "SELECT 1"` 是探活，
      // `-tAc "SELECT string_agg..."` 是查其它库，不带 -c 的那次才是灌库。
      fs.writeFileSync(path.join(dir, 'psql'), [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${dir}/psql-args`,
        'for a in "$@"; do',
        `  case "$a" in`,
        `    "SELECT 1") exit ${s.probeExit ?? 0} ;;`,
        `    SELECT\\ string_agg*) printf '%s\\n' "${s.otherDbs ?? ''}"; exit 0 ;;`,
        `    SELECT\\ count*) echo 7; exit 0 ;;`,
        '  esac',
        'done',
        // 灌库这一次：记下账号与库名，把 stdin 吃掉（真 psql 收到零字节也退 0）。
        'u=""; d=""; stop=0; prev=""',
        'for a in "$@"; do',
        '  [ "$prev" = "-U" ] && u="$a"',
        '  [ "$prev" = "-d" ] && d="$a"',
        '  [ "$a" = "ON_ERROR_STOP=1" ] && stop=1',
        '  prev="$a"',
        'done',
        `printf '%s\\n' "$u" > ${dir}/pguser`,
        `printf '%s\\n' "$d" > ${dir}/pgdb`,
        `printf '%s\\n' "$stop" > ${dir}/onerrorstop`,
        'cat > /dev/null',
        `exit ${s.psqlExit ?? 0}`,
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'gunzip'), [
        '#!/bin/sh',
        `[ "$1" = "-t" ] && exit ${s.testExit ?? 0}`,
        'echo "SELECT 1;"',
        `exit ${s.catExit ?? 0}`,
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'pg_dump'), [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${dir}/pgdump-args`,
        'echo "-- dump"',
        `exit ${s.dumpExit ?? 0}`,
      ].join('\n'), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'gzip'), [
        '#!/bin/sh',
        'cat > /dev/null',
        'echo "gzipped"',
        `exit ${s.gzipExit ?? 0}`,
      ].join('\n'), { mode: 0o755 });

      let code = 0;
      let stderr = '';
      let stdout = '';
      try {
        stdout = execFileSync('sh', ['-s'], {
          input: script(dir),
          env: { PATH: `${dir}:${process.env.PATH}`, ...(s.env ?? PRESET_ENV) },
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
        code = Number(e.status ?? -1);
        stderr = (e.stderr || Buffer.from('')).toString();
        stdout = (e.stdout || Buffer.from('')).toString();
      }
      // 成功路径的 stderr 得单独跑一次才拿得到；execFileSync 成功时不回传它，
      // 所以用一个包一层的写法把它重定向到文件。
      if (code === 0) {
        const errFile = path.join(dir, 'stderr.txt');
        try {
          execFileSync('sh', ['-c', `sh -s 2> ${errFile} > /dev/null`], {
            input: script(dir),
            env: { PATH: `${dir}:${process.env.PATH}`, ...(s.env ?? PRESET_ENV) },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch { /* 第一次已经拿到退出码，这一次只为收 stderr */ }
        if (fs.existsSync(errFile)) stderr = fs.readFileSync(errFile, 'utf8');
      }
      const read = (f: string): string => (
        fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : ''
      );
      return {
        code,
        stderr,
        stdout,
        pgUser: read('pguser'),
        pgDb: read('pgdb'),
        onErrorStop: read('onerrorstop') === '1',
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const dump = (): string => buildPostgresDumpScript();
  const restore = (dir: string): string => buildPostgresRestoreScript(`${dir}/dump.sql.gz`);

  it('导出：两端都成功即退 0', () => {
    expect(run(dump, {}).code).toBe(0);
  });

  it('导出：pg_dump 失败而 gzip 成功——整条必须失败', () => {
    // 裸管道版本在这里会返回 0（管道只给最后一环的退出码），产出一份
    // 「非空但只有半截」的 gz，还会被保留策略拿去顶掉一份真正可用的旧备份。
    expect(run(dump, { dumpExit: 1 }).code).not.toBe(0);
  });

  it('导出：gzip 写盘失败——整条必须失败', () => {
    expect(run(dump, { gzipExit: 1 }).code).not.toBe(0);
  });

  it('连不上就退 78 并说清用的是哪个账号哪个库，不往下猜', () => {
    const r = run(dump, { probeExit: 2 });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('用户=app');
    expect(r.stderr).toContain('库=appdb');
  });

  it('凭据缺省链与官方镜像一致：POSTGRES_DB 缺省即 POSTGRES_USER', () => {
    const r = run(restore, { env: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw' } });
    expect(r.code).toBe(0);
    expect(r.pgDb).toBe('app');
  });

  it('口令只在容器内展开，不进宿主命令行', () => {
    for (const script of [buildPostgresDumpScript(), buildPostgresRestoreScript('/tmp/x.sql.gz'),
      buildPostgresTableCountScript()]) {
      expect(script).toContain('export PGPASSWORD="$CDS_PG_PW"');
      // 绝不能出现把口令拼进 URL 或参数的写法：那会摆进宿主的 ps 和 CDS 日志。
      expect(script).not.toMatch(/postgresql:\/\/[^"\s]*:/);
    }
  });

  it('恢复：psql 必须带 ON_ERROR_STOP=1', () => {
    // 少了它，psql 遇错继续、跑完退 0，接口照样回「已恢复」——
    // 这是 postgres 独有的、连管道退出码都拦不住的假成功。
    const r = run(restore, {});
    expect(r.code).toBe(0);
    expect(r.onErrorStop).toBe(true);
    expect(r.pgUser).toBe('app');
    expect(r.pgDb).toBe('appdb');
  });

  it('恢复：解压失败而 psql 退 0——整条必须失败', () => {
    expect(run(restore, { catExit: 1 }).code).not.toBe(0);
  });

  it('恢复：psql 报错——整条失败', () => {
    expect(run(restore, { psqlExit: 1 }).code).not.toBe(0);
  });

  it('恢复：完整性校验不过就退 65，一步都不许动库', () => {
    const r = run(restore, { testExit: 1 });
    expect(r.code).toBe(65);
    expect(r.pgUser, '库都没连，更不该有灌库那一次').toBe('');
  });

  it('同实例还有别的库时，当场把范围说清楚，且算成真的缺口', () => {
    // 这份 dump 只带走一个库。不报出来的话，「成功 1 个」会被读成全量备份。
    //
    // 走 gap 标记而不是 scope 标记：这是「本可以带走却没带走」，该拉低健康位。
    // 与 rabbitmq「definitions 天生不含消息」那种纯说明分开——后者无条件每轮都报，
    // 当缺口会让健康位永远刷不新（2026-08-26 Codex review P1）。
    const r = run(dump, { otherDbs: 'analytics,billing' });
    expect(r.code).toBe(0);
    const gap = extractBackupGapNote(r.stderr);
    expect(gap, '别的库没备走是真的缺口，不是说明').toContain('analytics,billing');
    expect(extractBackupScopeNote(r.stderr), '同一轮不该两个标记都报').toBeNull();
  });

  it('只有一个库时不报噪音', () => {
    const stderr = run(dump, { otherDbs: '' }).stderr;
    expect(extractBackupGapNote(stderr)).toBeNull();
    expect(extractBackupScopeNote(stderr)).toBeNull();
  });
});

describe('范围说明一路走到用户看得见的地方', () => {
  it('从 stderr 里认得出来', () => {
    expect(extractBackupScopeNote('cds-backup-scope: 本次只导出库 appdb；同实例另有：x'))
      .toBe('本次只导出库 appdb；同实例另有：x');
    expect(extractBackupScopeNote('pg_dump: warning: something')).toBeNull();
  });

  it('进了一轮结论那句话——只活在对象里等于没人看见', () => {
    const s = summarizeBackupRound([{ id: 'postgres', ok: true, note: '只导出库 appdb' }], 0);
    expect(s).toContain('成功 1 个');
    expect(s).toContain('范围提示');
    expect(s).toContain('只导出库 appdb');
  });
});
