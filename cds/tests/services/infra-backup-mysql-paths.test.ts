import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMysqlRestoreScript, buildMysqlTableCountScript } from '../../src/services/infra-backup-schedule.js';

/**
 * E41：mysql 的手工下载与恢复。
 *
 * 下载端点此前只有 mongo 和 redis 两个分支，**mysql 掉进兜底的 `tar -C /data`**——
 * 而 mysql 的数据在 /var/lib/mysql，于是 2026-08-18 实测三个 mysql 全都返回
 * **22 字节的空 gzip 壳，HTTP 却是 200**。拿它当迁移数据源或动手前的兜底，
 * 等于什么都没有；更糟的是它看起来成功了。
 *
 * 恢复端点则**根本没有 mysql 分支**：能导出却灌不回去，等于没有备份。
 * 两个缺口合起来的后果很具体——当天想给一个 170MB、303 张表的 mysql 补数据卷再重建，
 * 因为「没有可信导出 + 没有恢复入口」而只能中止。
 */
const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');

describe('mysql 下载走真正的导出', () => {
  it('detectKind 认得 mysql/mariadb，不再掉进 generic', () => {
    expect(SRC).toMatch(/includes\('mysql'\)\s*\|\|\s*lower\.includes\('mariadb'\)/);
  });

  it('下载用与周期备份同一段 mysqldump 脚本，不是 tar /data', () => {
    expect(SRC).toContain('buildMysqlDumpScript()');
    // 兜底 tar 仍然存在（给数据确实在 /data 的类型），但 mysql 不该再走到它
    const mysqlBranch = SRC.slice(SRC.indexOf("} else if (kind === 'mysql') {"));
    const untilNext = mysqlBranch.slice(0, mysqlBranch.indexOf('} else {'));
    expect(untilNext).not.toContain("'-C', '/data'");
  });

  it('导出失败不许当成功下载', () => {
    // 22 字节的空壳配 HTTP 200 正是这次的坑：失败必须让调用方看得出来。
    expect(SRC).toMatch(/mysqldump exit \$\{code\}/);
    expect(SRC).toMatch(/res\.destroy\(new Error\(`mysqldump exit/);
  });

  it('文件名按真实格式命名 .sql.gz', () => {
    expect(SRC).toContain("kind === 'mysql' ? 'sql.gz'");
  });
});

describe('mysql 恢复入口', () => {
  it('恢复有 mysql 分支，不再一律 400', () => {
    const restorePart = SRC.slice(SRC.indexOf("router.post('/infra/:id/restore'"));
    expect(restorePart).toContain("} else if (kind === 'mysql') {");
  });

  it('恢复前先存一份当前状态，存不下就中止——没有退路的恢复不该开始', () => {
    expect(SRC).toMatch(/恢复前快照失败，已中止/);
  });

  it('大 dump 走文件 + docker cp，不走 stdin 字符串', () => {
    // 170MB 的库塞进 JS 字符串会直接把进程顶爆。
    const restorePart = SRC.slice(SRC.indexOf("} else if (kind === 'mysql') {"));
    expect(restorePart).toContain('docker cp');
    expect(restorePart).toContain('createWriteStream');
  });

  it('口令只在容器内展开，不进宿主命令行', () => {
    // 断言的是「脚本里带着容器内展开的写法」，不是某个文件里有这行字面量——
    // 脚本搬去 builder 之后，字面量断言会变红，而它守的事其实一点没变。
    for (const script of [buildMysqlRestoreScript('/tmp/x.sql.gz'), buildMysqlTableCountScript()]) {
      expect(script).toContain('export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"');
    }
  });

  it('容器内的中转文件用完就删', () => {
    const restorePart = SRC.slice(SRC.indexOf("} else if (kind === 'mysql') {"));
    expect(restorePart).toMatch(/rm -f \$\{shq\(inContainer\)\}/);
  });

  it('空上传当场拒绝，不往下走到「已恢复」', () => {
    expect(SRC).toContain('uploadBytes === 0');
    expect(SRC).toMatch(/上传内容为空/);
  });

  it('「已恢复」这句话带着可核对的数字', () => {
    // 上一版的响应只有 restored:true——真成功和假成功长得一模一样，没人能分辨。
    expect(SRC).toContain('tablesBefore');
    expect(SRC).toContain('tablesAfter');
    expect(SRC).toContain('uploadBytes,');
  });
});

/**
 * 真跑一遍脚本，而不是读它长什么样。
 *
 * 2026-08-18 那次假成功是 `gunzip -c f | mysql -uroot` 加 `code=$?` 造成的：
 * **管道的退出码只是最后一环的**。上游 gunzip 失败、下游 mysql 收到零字节正常退出，
 * `$?` 就是 0，接口回「已恢复」，库里一张表都没多。
 *
 * 这一类错误光看代码看不出来（那一行读起来完全正常），所以这里在 PATH 前面塞两个假的
 * gunzip / mysql，用真 `sh` 把脚本跑一遍，直接断言退出码。把实现改回裸管道，
 * 「上游失败、下游成功」那条会立刻变红。
 */
describe('mysql 恢复脚本：管道两端的失败都要报出来', () => {
  /** 造一个只有假 gunzip / mysql 的 PATH，behaviour 由参数决定。 */
  function runScript(opts: { testExit: number; catExit: number; mysqlExit: number }): number {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mysql-restore-'));
    try {
      // 假 gunzip：`-t` 走完整性校验分支，`-c` 走解压分支，各自可以单独失败。
      fs.writeFileSync(path.join(dir, 'gunzip'), [
        '#!/bin/sh',
        `[ "$1" = "-t" ] && exit ${opts.testExit}`,
        'echo "SELECT 1;"',
        `exit ${opts.catExit}`,
      ].join('\n'), { mode: 0o755 });
      // 假 mysql：把 stdin 吃掉再退出。真 mysql 在收到零字节时也是这样——退 0。
      fs.writeFileSync(path.join(dir, 'mysql'), [
        '#!/bin/sh',
        'cat > /dev/null',
        `exit ${opts.mysqlExit}`,
      ].join('\n'), { mode: 0o755 });
      const script = buildMysqlRestoreScript(`${dir}/dump.sql.gz`);
      try {
        execFileSync('sh', ['-s'], {
          input: script,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return 0;
      } catch (err) {
        return Number((err as { status?: number }).status ?? -1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('两端都成功：退 0', () => {
    expect(runScript({ testExit: 0, catExit: 0, mysqlExit: 0 })).toBe(0);
  });

  it('事故原形——解压失败、mysql 却退 0：整条必须失败', () => {
    // 裸管道版本在这里会返回 0，也就是那句「已恢复」的由来。
    expect(runScript({ testExit: 0, catExit: 1, mysqlExit: 0 })).not.toBe(0);
  });

  it('mysql 报错：整条失败', () => {
    expect(runScript({ testExit: 0, catExit: 0, mysqlExit: 1 })).not.toBe(0);
  });

  it('完整性校验不过：一步都不许动库', () => {
    // 空文件 / 传了一半的文件在这里出局，而不是灌进去半截 SQL 才发现。
    expect(runScript({ testExit: 1, catExit: 0, mysqlExit: 0 })).toBe(65);
  });
});
