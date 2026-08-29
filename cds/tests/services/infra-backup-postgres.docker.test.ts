import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildPostgresDumpScript,
  buildPostgresRestoreScript,
  buildPostgresTableCountScript,
  extractBackupGapNote,
  extractBackupScopeNote,
} from '../../src/services/infra-backup-schedule.js';
import { getInfraCatalogEntry } from '../../src/services/infra-catalog.js';
import { acquireDockerSlot, releaseDockerSlot, waitForService } from '../helpers/docker-container.js';

/**
 * postgres 备份与恢复的**运行时**判据：真起一个库、真塞数据、真导出、真清库、真灌回去。
 *
 * ## 为什么假 psql 不够
 *
 * 同目录的 `infra-backup-postgres-paths.test.ts` 用假 psql / 假 pg_dump 跑过退出码矩阵，
 * 那证明的是「脚本的控制流对」。它证明不了下面这几件事，而每一件都能让备份变成废纸：
 *
 * - `psql -U app` 走 unix socket 到底连不连得上（官方镜像 initdb 把本地配成 trust，
 *   但这是关于**镜像**的假设，不是关于我们脚本的）。
 * - `pg_dump --clean --if-exists --no-owner --no-privileges` 的产物能不能**灌回同一个库**。
 *   这是选它而不选 pg_dumpall 的全部理由；理由不成立的话，我们留下的是一份导得出、
 *   灌不回的备份——等于没有备份。
 * - `ON_ERROR_STOP=1` 是不是真的把 psql 那个「遇错继续、跑完照样 exit 0」的默认行为改掉了。
 *   这是 postgres 独有、连管道退出码都拦不住的假成功，也是本文件最该守的一条。
 *
 * 无 docker 的环境跳过，但**打印跳过原因**——一条静默空跑的绿灯比没有测试更糟，
 * 它会让人以为这件事已经验过了。
 */

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function imageAvailable(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    try {
      execSync(`docker pull ${image}`, { stdio: 'ignore', timeout: 300_000 });
      return true;
    } catch {
      return false;
    }
  }
}

const ENTRY = getInfraCatalogEntry('postgres')!;
const IMAGE = ENTRY.dockerImage;
const DOCKER_OK = dockerAvailable();
const READY = DOCKER_OK && imageAvailable(IMAGE);

if (!READY) {
  console.warn(
    `[infra-backup-postgres] 跳过真容器判据：${DOCKER_OK ? `拉不到镜像 ${IMAGE}` : '本机没有可用的 docker daemon'}。`
    + ' 导出能不能灌回去、ON_ERROR_STOP 是否真的生效，本次**未验证**——'
    + '按「没演练过的备份不算备份」，这一条还没做完。',
  );
}

const PASSWORD = 'pgbackuptest0123';
/** 目标库名。测试与预设必须用同一个值，两边各写一遍就会出现「探活说好了、查询打空」。 */
const DB = 'appdb';
const NAME = `cds-pg-backup-${Date.now()}`;
/** 建表塞多少行。数字本身不重要，重要的是恢复前后能对上。 */
const ROWS = 37;

/**
 * 在容器里跑一段 SQL，返回 stdout。
 *
 * 不传口令：官方镜像 initdb 把本地 socket 配成 trust，`docker exec` 进去用 `-U app`
 * 就能连上。这也正是导出脚本依赖的那条路径——测试用同一条，顺带把它验了。
 */
function sql(statement: string, db = DB): string {
  return execSync(
    `docker exec ${NAME} psql -U app -d ${db} -tAc ${shq(statement)}`,
    { encoding: 'utf8', timeout: 60_000 },
  ).trim();
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * 把一段脚本经 stdin 送进容器里的 sh 跑。
 *
 * stdout / stderr 一律**重定向到宿主文件**再读回来，不靠 execSync 的返回值：
 * 它成功时只给 stdout、失败时才给 stderr，而这里有一条用例恰恰要断言
 * **成功路径上的 stderr**（导出脚本用它报覆盖范围）。分两种拿法就会漏掉那一半。
 */
function runScript(script: string, opts: { outFile?: string } = {}): {
  code: number; stdout: string; stderr: string;
} {
  const outPath = opts.outFile ?? path.join(scratch, `stdout-${runCounter++}.bin`);
  const errPath = path.join(scratch, `stderr-${runCounter++}.txt`);
  let code = 0;
  try {
    execSync(`docker exec -i ${NAME} sh -s > ${shq(outPath)} 2> ${shq(errPath)}`, {
      input: script,
      timeout: 300_000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch (err) {
    code = Number((err as { status?: number }).status ?? -1);
  }
  const read = (p: string): string => {
    try {
      // 导出产物是二进制 gz；只有当调用方没有指定 outFile 时才当文本读。
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    code,
    stdout: opts.outFile ? '' : read(outPath),
    stderr: read(errPath),
  };
}

let runCounter = 0;
let scratch = '';

describe.skipIf(!READY)('postgres 备份与恢复：真容器', () => {
  const workDir = READY ? fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pg-backup-')) : '';
  scratch = workDir;
  const hostDump = path.join(workDir, 'dump.sql.gz');
  const inContainer = '/tmp/cds-restore.sql.gz';

  // 重型容器排队起，别几个数据库同时冷启动把 runner 压垮（首轮 CI 四个容器全挂就是这么来的，见 helpers/docker-container.ts）。
  beforeAll(() => { if (READY) acquireDockerSlot('postgres-backup'); }, 1_800_000);

  afterAll(() => {
    releaseDockerSlot();
    try { execSync(`docker rm -f ${NAME}`, { stdio: 'ignore', timeout: 20_000 }); } catch { /* 没起来过 */ }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('起库 → 塞数据 → 导出 → 清库 → 灌回来，行数对得上', () => {
    // 完全按 catalog 的产物起容器：env 取自预设，不在测试里另写一份，
    // 否则测的是测试自己编的配置，不是产品真正会用的那一套。
    const built = ENTRY.build({ password: PASSWORD }, { dbName: DB });
    const envFlags = Object.entries(built.env || {}).map(([k, v]) => `-e ${shq(`${k}=${v}`)}`).join(' ');
    execSync(`docker run -d --name ${NAME} ${envFlags} ${IMAGE}`, { stdio: 'ignore', timeout: 120_000 });

    // 探活必须是**拿目标库真跑一次查询**，不是 pg_isready。
    //
    // 官方镜像 initdb 阶段会先起一个临时服务器，那时 pg_isready 就已经返回成功，
    // 而 POSTGRES_DB 还没建出来——首轮 CI 的 `database "appdb" does not exist`
    // 正是这么来的：探活说好了，第一条 SQL 却打在一个不存在的库上。
    waitForService({
      name: NAME,
      label: 'postgres',
      timeoutMs: 180_000,
      probe: () => {
        execSync(`docker exec ${NAME} psql -U app -d ${DB} -tAc 'SELECT 1'`, { stdio: 'ignore', timeout: 10_000 });
        return true;
      },
    });

    sql('CREATE TABLE cds_probe (id serial primary key, note text not null)');
    sql(`INSERT INTO cds_probe (note) SELECT 'row-' || g FROM generate_series(1, ${ROWS}) g`);
    expect(sql('SELECT count(*) FROM cds_probe')).toBe(String(ROWS));

    // 表数取证走的是产品那段脚本本身，不是测试另写的一句 SQL——
    // 「恢复了几张表」这句话在真流程里就是它算出来的。
    const tablesBefore = runScript(buildPostgresTableCountScript());
    expect(tablesBefore.code, `数表脚本失败：${tablesBefore.stderr}`).toBe(0);
    expect(tablesBefore.stdout.trim().split('\n').pop()?.trim()).toBe('1');

    // ---- 导出 ----
    const dump = runScript(buildPostgresDumpScript(), { outFile: hostDump });
    expect(dump.code, `导出失败：${dump.stderr}`).toBe(0);
    const bytes = fs.statSync(hostDump).size;
    expect(bytes, '导出产物为空').toBeGreaterThan(0);

    // 非空不等于完整。gzip -t 是唯一能证明「这份压缩档能解开」的判据，
    // 周期备份转正前跑的也是它。
    execSync(`gzip -t ${shq(hostDump)}`, { timeout: 60_000 });
    // 这三条用正则而不是逐字匹配：pg_dump 的措辞会随版本微调，
    // 而这里要守的是**三个开关真的生效了**，不是某一版的输出长什么样。
    const plain = execSync(`gunzip -c ${shq(hostDump)}`, { encoding: 'utf8', timeout: 60_000 });
    expect(plain).toMatch(/CREATE TABLE\s+(public\.)?cds_probe/i);
    // --clean --if-exists 是「能灌回同一个库」的前提，产物里必须真的有 DROP。
    expect(plain).toMatch(/DROP TABLE IF EXISTS\s+(public\.)?cds_probe/i);
    // --no-owner / --no-privileges：目标集群没有源集群那些角色时，属主语句会整片失败。
    expect(plain).not.toMatch(/OWNER TO/i);

    // ---- 毁掉数据 ----
    sql('DROP TABLE cds_probe');
    expect(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).toBe('0');

    // ---- 灌回来 ----
    execSync(`docker cp ${shq(hostDump)} ${NAME}:${inContainer}`, { stdio: 'ignore', timeout: 120_000 });
    const restore = runScript(buildPostgresRestoreScript(inContainer));
    expect(restore.code, `恢复失败：${restore.stderr}`).toBe(0);

    // 「已恢复」这句话必须带着能被核对的数字。
    expect(sql('SELECT count(*) FROM cds_probe')).toBe(String(ROWS));
    expect(sql("SELECT note FROM cds_probe ORDER BY id LIMIT 1")).toBe('row-1');
    const tablesAfter = runScript(buildPostgresTableCountScript());
    expect(tablesAfter.stdout.trim().split('\n').pop()?.trim()).toBe('1');
  }, 600_000);

  it('灌进去的 SQL 有一句报错，整条恢复必须失败', () => {
    // **本文件最该守的一条。** psql 默认遇错继续、跑完照样 exit 0，
    // 于是一份灌到一半全是错的 dump 会被报成「已恢复」——而且这一次连管道退出码
    // 都救不了，因为撒谎的就是管道最后一环自己。ON_ERROR_STOP=1 就是为这个加的。
    const badGz = path.join(workDir, 'bad.sql.gz');
    fs.writeFileSync(path.join(workDir, 'bad.sql'), 'SELECT 1;\nTHIS IS NOT SQL;\nSELECT 2;\n');
    execSync(`gzip -c ${shq(path.join(workDir, 'bad.sql'))} > ${shq(badGz)}`, { timeout: 30_000 });
    execSync(`docker cp ${shq(badGz)} ${NAME}:/tmp/bad.sql.gz`, { stdio: 'ignore', timeout: 60_000 });

    const restore = runScript(buildPostgresRestoreScript('/tmp/bad.sql.gz'));
    expect(restore.code, '有语法错的 dump 灌进去居然报成功——ON_ERROR_STOP 没有生效').not.toBe(0);
  }, 180_000);

  it('文件不是 gz：在动库之前就出局，退 65', () => {
    execSync(`docker exec ${NAME} sh -c 'echo not-a-gzip > /tmp/notgz.sql.gz'`, { timeout: 30_000 });
    const restore = runScript(buildPostgresRestoreScript('/tmp/notgz.sql.gz'));
    expect(restore.code).toBe(65);
    // 库没被动过：上一条用例恢复出来的数据还在。
    expect(sql('SELECT count(*) FROM cds_probe')).toBe(String(ROWS));
  }, 120_000);

  it('同实例还有别的库时，导出脚本当场把范围说清楚', () => {
    // 这份 dump 只带走 POSTGRES_DB 那一个库。不报出来的话，
    // 「成功 1 个」会被读成全量备份——「备了」和「备全了」是两件事。
    sql('CREATE DATABASE analytics', 'postgres');
    try {
      const dump = runScript(buildPostgresDumpScript(), { outFile: path.join(workDir, 'scoped.sql.gz') });
      expect(dump.code, `导出失败：${dump.stderr}`).toBe(0);
      // 走 gap 标记：同实例别的库没备走是「本可以带走却没带走」，该拉低健康位。
      // 与 rabbitmq「definitions 天生不含消息」那种纯说明分开——后者每轮无条件报，
      // 当缺口会让健康位永远刷不新（2026-08-26 Codex review P1）。
      expect(extractBackupGapNote(dump.stderr)).toContain('analytics');
      expect(extractBackupScopeNote(dump.stderr), '同一轮不该两个标记都报').toBeNull();
    } finally {
      try { sql('DROP DATABASE analytics', 'postgres'); } catch { /* 清不掉不影响结论 */ }
    }
  }, 180_000);

  it('连不上就退 78 并说清用的是哪个账号哪个库，不往下猜', () => {
    // 把凭据换成一个不存在的账号：脚本必须在探活那一步停住，
    // 而不是带着一个猜出来的库名往下走。
    const script = buildPostgresDumpScript().replace(
      'CDS_PG_USER="${POSTGRES_USER:-${PGUSER:-postgres}}"',
      'CDS_PG_USER=nosuchuser',
    );
    const r = runScript(script);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('用户=nosuchuser');
  }, 120_000);
});
