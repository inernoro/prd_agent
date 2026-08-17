import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getInfraCatalogEntry } from '../../src/services/infra-catalog.js';

/**
 * redis 预设的**运行时**判据：真起一个容器，看进程到底以谁的身份在跑。
 *
 * 为什么必须用真容器：这一处的两个不变量都是「声明看不出来」的类型。
 *
 * 1. 口令要真的生效（`AUTH` 能通过、不带口令连不上）。命令字符串里有
 *    `--requirepass` 只能证明我们写了这个参数，证明不了 redis 真的启用了认证。
 * 2. redis 必须**降权到 `redis` 用户**跑。官方镜像的 entrypoint 只在第一个参数是
 *    `redis-server` 时才修 `/data` 属主并降权；一旦把 CMD 写成 `sh -c '…'`，
 *    entrypoint 看到 `$1 = sh` 就走兜底 `exec "$@"`，redis 以 root 起，持久化文件
 *    也变成 root 属主。**这个差别在生成的命令字符串里完全看不出来**——两种写法
 *    长得几乎一样，只有跑起来 `id -u` 才分得清。上一版就是这么漏过去的
 *    （Codex review P1，2026-08-17）：源码扫描全绿，容器里却是 root。
 *
 * 无 docker 的环境（本地沙箱）跳过，但**打印跳过原因**——一条静默空跑的绿灯比
 * 没有测试更糟，它会让人以为这件事已经验过了。
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
      execSync(`docker pull ${image}`, { stdio: 'ignore', timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  }
}

const ENTRY = getInfraCatalogEntry('redis')!;
const IMAGE = ENTRY.dockerImage;
const DOCKER_OK = dockerAvailable();
const READY = DOCKER_OK && imageAvailable(IMAGE);

if (!READY) {
  console.warn(
    `[redis-preset-privilege] 跳过真容器判据：${DOCKER_OK ? `拉不到镜像 ${IMAGE}` : '本机没有可用的 docker daemon'}。`
    + ' 降权与认证这两条只有真跑才算数，本次未验证。',
  );
}

describe.skipIf(!READY)('redis 预设在真容器里的行为', () => {
  const name = `cds-redis-priv-${Date.now()}`;
  const PASSWORD = 'testpw0123456789';

  afterAll(() => {
    try { execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 15_000 }); } catch { /* 没起来过 */ }
  });

  it('口令生效 + 进程降权到 redis 用户 + /data 属主不是 root', () => {
    // 完全按 catalog 的产物起容器：命令与 env 都取自预设，不在测试里另写一份，
    // 否则测的是测试自己编的启动方式，不是产品真正会用的那一套。
    const built = ENTRY.build({ password: PASSWORD });
    const cmd = ENTRY.command as string[];
    const envFlags = Object.entries(built.env || {}).map(([k, v]) => `-e ${k}=${v}`).join(' ');
    const cmdParts = cmd.map((c) => `'${c.replace(/'/g, `'"'"'`)}'`).join(' ');
    execSync(`docker run -d --name ${name} ${envFlags} ${IMAGE} ${cmdParts}`, { stdio: 'ignore', timeout: 60_000 });

    // 等就绪：最多 20 秒，每 500ms 探一次
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      try {
        const pong = execSync(`docker exec ${name} redis-cli -a ${PASSWORD} --no-auth-warning PING`, {
          encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        ready = pong.trim() === 'PONG';
      } catch { /* 还没起来 */ }
      if (!ready) execSync('sleep 0.5');
    }
    expect(ready, 'redis 在 20 秒内没有用预设口令认证成功').toBe(true);

    // 1) 认证真的开着：不带口令必须被拒
    let unauthed = '';
    try {
      unauthed = execSync(`docker exec ${name} redis-cli PING`, {
        encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      unauthed = String((err as { stdout?: Buffer }).stdout || '');
    }
    expect(unauthed).toMatch(/NOAUTH|Authentication required/i);

    // 2) 降权：主进程的属主不能是 root。
    //    用 `/proc/1` 的属主判，不用 `ps -o user,comm`——alpine 里是 busybox ps，
    //    对 `-o` 的支持有限，拿它当判据可能在别的镜像上直接报错，那就变成
    //    「测试自己坏了」而不是「行为不对」。/proc 每个镜像都有。
    const pid1Cmd = execSync(`docker exec ${name} sh -c "tr '\\0' ' ' < /proc/1/cmdline"`, {
      encoding: 'utf8', timeout: 10_000,
    }).trim();
    expect(pid1Cmd, `主进程不是 redis-server 而是 ${pid1Cmd}`).toContain('redis-server');
    const owner = execSync(`docker exec ${name} stat -c %U /proc/1`, { encoding: 'utf8', timeout: 10_000 }).trim();
    expect(owner, `redis-server 以 ${owner} 运行；entrypoint 的降权分支被绕过了`).toBe('redis');

    // 3) 持久化目录属主同样不能是 root（降权前那次 chown 有没有发生）
    const dataOwner = execSync(`docker exec ${name} stat -c %U /data`, { encoding: 'utf8', timeout: 10_000 }).trim();
    expect(dataOwner).toBe('redis');
  }, 120_000);
});
