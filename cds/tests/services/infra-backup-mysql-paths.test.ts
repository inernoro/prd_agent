import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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
    expect(SRC).toContain('export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"');
  });

  it('容器内的中转文件用完就删', () => {
    const restorePart = SRC.slice(SRC.indexOf("} else if (kind === 'mysql') {"));
    expect(restorePart).toMatch(/rm -f \$\{shq\(inContainer\)\}/);
  });
});
