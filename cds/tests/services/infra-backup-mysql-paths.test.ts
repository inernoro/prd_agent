import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  backupKindOf,
  buildMysqlDumpScript,
  buildMysqlRestoreScript,
  buildMysqlTableCountScript,
} from '../../src/services/infra-backup-schedule.js';
import { scriptedDump } from '../../src/routes/infra-backup.js';

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
  it('判据认得 mysql/mariadb，不再掉进 generic', () => {
    // 断言的是**判据的行为**，不是某个文件里还有没有那一行 includes()。
    // 下载端点原来自己判一遍镜像名（第三份拷贝），现在复用这一份；
    // 断言绑在行为上，判据搬家不会让这条误红，判据判错才会红。
    expect(backupKindOf('mysql:8.0')).toBe('mysql');
    expect(backupKindOf('mariadb:11')).toBe('mysql');
    expect(backupKindOf('nginx:alpine')).toBeNull();
  });

  it('下载用与周期备份同一段 mysqldump 脚本，不是 tar /data', () => {
    // 断言的是**同一段脚本**这个事实本身，不是某个文件里还有没有那一行调用。
    // 路由侧改成查表取脚本之后，字面量断言会变红，而它守的事一点没变（形状 4a）。
    expect(scriptedDump('mysql')?.dump()).toBe(buildMysqlDumpScript());
    // 兜底 tar 仍然存在（给数据确实在 /data 的类型），但 mysql 不该再走到它
    const scriptedBranch = SRC.slice(SRC.indexOf('} else if (scripted) {'));
    const untilNext = scriptedBranch.slice(0, scriptedBranch.indexOf('} else {'));
    expect(untilNext).not.toContain("'-C', '/data'");
  });

  it('查表判据不是恒真：不走脚本导出的类型必须取不到', () => {
    // 没有这条反面对照，上一条即使在 scriptedDump 恒返回 mysql 时也会绿。
    expect(scriptedDump('mongo')).toBeNull();
    expect(scriptedDump('redis')).toBeNull();
    expect(scriptedDump('generic')).toBeNull();
  });

  it('导出失败不许当成功下载', () => {
    // 22 字节的空壳配 HTTP 200 正是这次的坑：失败必须让调用方看得出来。
    expect(SRC).toMatch(/\$\{tool\} exit \$\{code\}/);
    expect(SRC).toMatch(/res\.destroy\(new Error\(`\$\{tool\} exit/);
  });

  it('文件名按真实格式命名 .sql.gz', () => {
    expect(scriptedDump('mysql')?.ext).toBe('sql.gz');
  });
});

describe('mysql 恢复入口', () => {
  it('恢复有 mysql 分支，不再一律 400', () => {
    // 有恢复脚本 = 有恢复入口。断在脚本上而不是断在分支的写法上。
    expect(scriptedDump('mysql')?.restore('/tmp/x.sql.gz')).toBe(buildMysqlRestoreScript('/tmp/x.sql.gz'));
    const restorePart = SRC.slice(SRC.indexOf("router.post('/infra/:id/restore'"));
    expect(restorePart).toContain('} else if (scripted) {');
  });

  it('恢复前先存一份当前状态，存不下就中止——没有退路的恢复不该开始', () => {
    expect(SRC).toMatch(/恢复前快照失败，已中止/);
  });

  it('大 dump 走文件 + docker cp，不走 stdin 字符串', () => {
    // 170MB 的库塞进 JS 字符串会直接把进程顶爆。
    const restorePart = SRC.slice(SRC.lastIndexOf('} else if (scripted) {'));
    expect(restorePart).toContain('docker cp');
    expect(restorePart).toContain('createWriteStream');
  });

  it('口令只在容器内展开，不进宿主命令行', () => {
    // 断言的是「脚本里带着容器内展开的写法」，不是某个文件里有这行字面量——
    // 脚本搬去 builder 之后，字面量断言会变红，而它守的事其实一点没变。
    for (const script of [buildMysqlRestoreScript('/tmp/x.sql.gz'), buildMysqlTableCountScript()]) {
      // 口令只以 env 变量名的形式出现，且经 MYSQL_PWD 传给客户端。
      expect(script).toMatch(/export MYSQL_PWD="\$CDS_(ROOT|APP)_PW"/);
      expect(script).toContain('MYSQL_ROOT_PASSWORD');
      // 绝不能出现 `-p<值>`：那会把口令摆进宿主的 ps 和 CDS 日志里。
      expect(script).not.toMatch(/-p\S/);
    }
  });

  it('容器内的中转文件用完就删', () => {
    const restorePart = SRC.slice(SRC.lastIndexOf('} else if (scripted) {'));
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
  /** 有 root 口令的容器（五个 mysql 里的四个）。 */
  const ROOT_ENV = { MYSQL_ROOT_PASSWORD: 'rootpw', MYSQL_USER: 'webhook', MYSQL_PASSWORD: 'apppw', MYSQL_DATABASE: 'webhook_platform' };
  /** 随机 root 口令的容器：只有应用账号可用（cloudbridge-db 的真实形态）。 */
  const APP_ONLY_ENV = { MYSQL_RANDOM_ROOT_PASSWORD: 'yes', MYSQL_USER: 'webhook', MYSQL_PASSWORD: 'apppw', MYSQL_DATABASE: 'webhook_platform' };

  /** 造一个只有假 gunzip / mysql 的 PATH，behaviour 由参数决定。 */
  function runScript(opts: {
    testExit: number; catExit: number; mysqlExit: number; flushExit?: number;
    env?: Record<string, string>;
  }): { code: number; flushed: boolean; mysqlUser: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mysql-restore-'));
    try {
      // 假 gunzip：`-t` 走完整性校验分支，`-c` 走解压分支，各自可以单独失败。
      fs.writeFileSync(path.join(dir, 'gunzip'), [
        '#!/bin/sh',
        `[ "$1" = "-t" ] && exit ${opts.testExit}`,
        'echo "SELECT 1;"',
        `exit ${opts.catExit}`,
      ].join('\n'), { mode: 0o755 });
      // 假 mysql：灌库那次把 stdin 吃掉再退出（真 mysql 收到零字节时也是这样——退 0）；
      // 带 -e 的那次是收尾的 FLUSH PRIVILEGES，落一个记号文件供断言。
      fs.writeFileSync(path.join(dir, 'mysql'), [
        '#!/bin/sh',
        'for a in "$@"; do',
        `  [ "$a" = "-e" ] && { echo "$@" > ${dir}/flushed; exit ${opts.flushExit ?? 0}; }`,
        'done',
        // 记下灌库这一次实际用的是哪个账号——凭据选错了会静默连上另一个身份。
        // 真实命令是 `mysql -uwebhook`（-u 与值连在一个 token 里），所以剥前缀而不是取 $2。
        `printf '%s\\n' "${'${1#-u}'}" > ${dir}/mysqluser`,
        'cat > /dev/null',
        `exit ${opts.mysqlExit}`,
      ].join('\n'), { mode: 0o755 });
      const script = buildMysqlRestoreScript(`${dir}/dump.sql.gz`);
      let code = 0;
      try {
        execFileSync('sh', ['-s'], {
          input: script,
          // 容器 env 由参数给定；把宿主继承来的同名变量清掉，免得测的是外面的值。
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            ...(opts.env ?? ROOT_ENV),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        code = Number((err as { status?: number }).status ?? -1);
      }
      const userFile = path.join(dir, 'mysqluser');
      return {
        code,
        flushed: fs.existsSync(path.join(dir, 'flushed')),
        mysqlUser: fs.existsSync(userFile) ? fs.readFileSync(userFile, 'utf8').trim() : '',
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('没有 root 口令时用应用账号，且不去 flush（它没有 RELOAD 权限）', () => {
    // cloudbridge-db 就是这一档：MYSQL_RANDOM_ROOT_PASSWORD 起的容器，root 口令
    // 只在首次初始化时打进容器日志，谁都拿不到。硬走 root 等于永远备不了。
    const r = runScript({ testExit: 0, catExit: 0, mysqlExit: 0, env: APP_ONLY_ENV });
    expect(r.code).toBe(0);
    expect(r.mysqlUser).toBe('webhook');
    expect(r.flushed, '应用账号没有 RELOAD 权限，强来只会让恢复整条失败').toBe(false);
  });

  it('应用账号档必须带 --no-tablespaces，root 档不带', () => {
    // 应用账号只有 `GRANT ALL ON <db>.*` + `GRANT USAGE ON *.*`，没有全局 PROCESS，
    // 而 mysqldump 8.0 默认要读 INFORMATION_SCHEMA.FILES 导表空间——少这个开关，
    // dump 一上来就 Access denied，产出 20 字节空 gzip（实测 cloudbridge-db 就这样）。
    const dump = buildMysqlDumpScript();
    expect(dump).toMatch(/CDS_MYSQL_SCOPE="--databases \$CDS_APP_DB --no-tablespaces"/);
    expect(dump).toMatch(/CDS_MYSQL_SCOPE="--all-databases"/);
  });

  it('凭据一套都凑不齐：明确退 78，不去连库', () => {
    const r = runScript({ testExit: 0, catExit: 0, mysqlExit: 0, env: {} });
    expect(r.code).toBe(78);
  });

  it('两端都成功：退 0，并且收尾 flush 过权限', () => {
    const r = runScript({ testExit: 0, catExit: 0, mysqlExit: 0 });
    expect(r.code).toBe(0);
    // 不 flush 的话，授权表明明写回去了、应用照样连不上，而恢复看起来是成功的。
    expect(r.flushed).toBe(true);
  });

  it('事故原形——解压失败、mysql 却退 0：整条必须失败', () => {
    // 裸管道版本在这里会返回 0，也就是那句「已恢复」的由来。
    expect(runScript({ testExit: 0, catExit: 1, mysqlExit: 0 }).code).not.toBe(0);
  });

  it('mysql 报错：整条失败', () => {
    expect(runScript({ testExit: 0, catExit: 0, mysqlExit: 1 }).code).not.toBe(0);
  });

  it('完整性校验不过：一步都不许动库，也不该走到 flush', () => {
    // 空文件 / 传了一半的文件在这里出局，而不是灌进去半截 SQL 才发现。
    const r = runScript({ testExit: 1, catExit: 0, mysqlExit: 0 });
    expect(r.code).toBe(65);
    expect(r.flushed).toBe(false);
  });

  it('flush 失败也算恢复失败：不许把「连不上的库」报成已恢复', () => {
    expect(runScript({ testExit: 0, catExit: 0, mysqlExit: 0, flushExit: 1 }).code).not.toBe(0);
  });
});
