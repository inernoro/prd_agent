import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildNacosDumpScript,
  buildNacosRestoreScript,
  buildNacosConfigCountScript,
} from '../../src/services/infra-backup-schedule.js';

/**
 * nacos 配置备份与恢复的**运行时**判据：真起一个 nacos、真写配置、真导出、真删掉、真灌回去。
 *
 * ## 为什么假 curl 不够
 *
 * 同目录的 `infra-backup-nacos.test.ts` 用假 curl 跑过全部控制流与失败模式，
 * 那证明的是「脚本的分支对」。它证明不了下面这几件事，而每一件都能让备份变成废纸：
 *
 * - **官方镜像里到底有没有 curl 或 wget**。一个都没有的话这条路根本走不通，
 *   而那只有真容器能告诉我们。脚本会退 78 并说清楚，但「退 78」和「能备」是两回事。
 * - 配置导出接口的**真实路径与参数**（`/v1/cs/configs?export=true&tenant=`）在这一版
 *   nacos 上是不是这个样子，回的是不是一个能被 import 吃回去的 zip。
 * - `import=true&policy=OVERWRITE` 是不是真的覆盖同名配置。
 * - 命名空间列表接口的 JSON 形状，能不能被脚本里那条 sed 抠出 id 来。
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

/** 与线上那两台在跑的实例同一个镜像——测的必须是真正在用的那一版。 */
const IMAGE = 'nacos/nacos-server:v2.3.2-slim';
const DOCKER_OK = dockerAvailable();
const READY = DOCKER_OK && imageAvailable(IMAGE);

if (!READY) {
  console.warn(
    `[infra-backup-nacos] 跳过真容器判据：${DOCKER_OK ? `拉不到镜像 ${IMAGE}` : '本机没有可用的 docker daemon'}。`
    + ' 镜像里有没有 curl / wget、配置导出接口回的东西能不能灌回去，本次**未验证**——'
    + '按「没演练过的备份不算备份」，这一条还没做完。',
  );
}

const NAME = `cds-nacos-backup-${Date.now()}`;
const DATA_ID = 'cds-probe.properties';

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/** 从宿主上打容器的 8848。用 docker exec 里的客户端，避免依赖端口映射。 */
function api(pathAndQuery: string, extra = ''): string {
  return execSync(
    `docker exec ${NAME} curl -sS ${extra} ${shq(`http://127.0.0.1:8848/nacos${pathAndQuery}`)}`,
    { encoding: 'utf8', timeout: 60_000 },
  );
}

let runCounter = 0;
let scratch = '';

/**
 * 把一段脚本经 stdin 送进容器里的 sh 跑。
 *
 * stdout / stderr 一律**重定向到宿主文件**再读回来，不靠 execSync 的返回值：
 * 它成功时只给 stdout、失败时才给 stderr，而这里有用例恰恰要断言
 * **成功路径上的 stderr**（导出脚本用它报「没带走什么」）。
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
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  };
  return { code, stdout: opts.outFile ? '' : read(outPath), stderr: read(errPath) };
}

describe.skipIf(!READY)('nacos 配置备份与恢复：真容器', () => {
  const workDir = READY ? fs.mkdtempSync(path.join(os.tmpdir(), 'cds-nacos-backup-')) : '';
  scratch = workDir;
  const hostDump = path.join(workDir, 'configs.tar.gz');
  const inContainer = '/tmp/cds-restore.tar.gz';

  afterAll(() => {
    try { execSync(`docker rm -f ${NAME}`, { stdio: 'ignore', timeout: 20_000 }); } catch { /* 没起来过 */ }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('起服务 → 写配置 → 导出 → 删掉 → 灌回来，配置还在且内容一致', () => {
    execSync(`docker run -d --name ${NAME} -e MODE=standalone ${IMAGE}`, { stdio: 'ignore', timeout: 180_000 });

    let ready = false;
    for (let i = 0; i < 180 && !ready; i += 1) {
      try {
        const r = execSync(
          `docker exec ${NAME} curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8848/nacos/v1/console/health/readiness`,
          { encoding: 'utf8', timeout: 15_000 },
        ).trim();
        ready = r === '200';
      } catch { /* 还在启动 */ }
      if (!ready) execSync('sleep 1');
    }
    expect(ready, 'nacos 在 180 秒内没有就绪').toBe(true);

    // 容器里有没有 curl，是这条路能不能走通的前提。这里顺带把它证了——
    // 上面那个 readiness 探测本身就是用容器内的 curl 发的。
    execSync(`docker exec ${NAME} sh -c 'command -v curl'`, { stdio: 'ignore', timeout: 20_000 });

    // 写一条配置进 public 命名空间。
    api('/v1/cs/configs', `-X POST --data-urlencode ${shq(`dataId=${DATA_ID}`)} `
      + `--data-urlencode 'group=DEFAULT_GROUP' --data-urlencode 'content=cds.probe=hello-42'`);
    const written = api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`);
    expect(written).toContain('hello-42');

    // 条数取证走产品那段脚本本身，不是测试另写一句命令。
    const before = runScript(buildNacosConfigCountScript());
    expect(before.code, `数配置失败：${before.stderr}`).toBe(0);
    expect(Number(before.stdout.trim().split('\n').pop())).toBeGreaterThanOrEqual(1);

    // ---- 导出 ----
    const dump = runScript(buildNacosDumpScript(), { outFile: hostDump });
    expect(dump.code, `导出失败：${dump.stderr}`).toBe(0);
    expect(fs.statSync(hostDump).size, '导出产物为空').toBeGreaterThan(0);
    execSync(`gzip -t ${shq(hostDump)}`, { timeout: 60_000 });

    // **本文件最该守的一条**：包里必须真的有 public 命名空间那一份，
    // 而且那份 zip 里要含刚写进去的 dataId。少了它，这就是一份看起来成功的空壳。
    const listed = execSync(`tar -tzf ${shq(hostDump)}`, { encoding: 'utf8', timeout: 60_000 });
    expect(listed).toContain('__public__.zip');
    execSync(`tar -xzf ${shq(hostDump)} -C ${shq(workDir)}`, { timeout: 60_000 });
    const zipList = execSync(`unzip -l ${shq(path.join(workDir, '__public__.zip'))}`, {
      encoding: 'utf8', timeout: 60_000,
    });
    expect(zipList).toContain(DATA_ID);

    // 范围注记：不含服务注册与用户权限，必须当场说出来。
    expect(dump.stderr).toContain('cds-backup-scope:');
    expect(dump.stderr).toContain('不含服务注册列表');

    // ---- 毁掉配置 ----
    api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`, '-X DELETE');
    expect(api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`)).not.toContain('hello-42');

    // ---- 灌回来 ----
    execSync(`docker cp ${shq(hostDump)} ${NAME}:${inContainer}`, { stdio: 'ignore', timeout: 120_000 });
    const restore = runScript(buildNacosRestoreScript(inContainer));
    expect(restore.code, `恢复失败：${restore.stderr}`).toBe(0);

    // 「已恢复」这句话必须带着能被核对的东西：不只是配置回来了，内容也要一致。
    expect(api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`)).toContain('hello-42');
  }, 900_000);

  it('policy=OVERWRITE 真的覆盖，而不是跳过同名配置', () => {
    // 恢复场景里最要命的假成功：接口回 200、说导入了，实际同名配置被跳过，
    // 库里还是被改坏的那一份。
    api('/v1/cs/configs', `-X POST --data-urlencode ${shq(`dataId=${DATA_ID}`)} `
      + `--data-urlencode 'group=DEFAULT_GROUP' --data-urlencode 'content=cds.probe=CORRUPTED'`);
    expect(api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`)).toContain('CORRUPTED');

    const restore = runScript(buildNacosRestoreScript(inContainer));
    expect(restore.code, `恢复失败：${restore.stderr}`).toBe(0);
    expect(api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`)).toContain('hello-42');
  }, 300_000);

  it('文件不是 gz：在动配置之前就出局，退 65', () => {
    execSync(`docker exec ${NAME} sh -c 'echo not-a-gzip > /tmp/notgz.tar.gz'`, { timeout: 30_000 });
    const restore = runScript(buildNacosRestoreScript('/tmp/notgz.tar.gz'));
    expect(restore.code).toBe(65);
    // 配置没被动过：上一条用例恢复出来的还在。
    expect(api(`/v1/cs/configs?dataId=${DATA_ID}&group=DEFAULT_GROUP`)).toContain('hello-42');
  }, 120_000);

  it('连不上就退 78，不产出一份空备份', () => {
    // 把端口换成一个没人监听的：脚本必须停在探活那一步。
    const script = buildNacosDumpScript().replace(
      '${NACOS_APPLICATION_PORT:-8848}',
      '${NACOS_APPLICATION_PORT:-18848}',
    );
    const r = runScript(script);
    expect(r.code).toBe(78);
    expect(r.stderr).toContain('连不上 nacos');
  }, 120_000);
});
