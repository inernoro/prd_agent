import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { getInfraCatalogEntry, type InfraCatalogEntry } from '../../src/services/infra-catalog.js';

/**
 * memcached / kafka / nats 三个预设的**运行时**判据：真起容器，看认证是不是真的开着。
 *
 * 为什么必须用真容器（redis 那次的教训，见 redis-preset-privilege.docker.test.ts）：
 * 命令字符串里有 `--pass` 只能证明我们写了这个参数，证明不了服务真的在校验它。
 * 而这三处每一处都有一个「写法看着对、跑起来不生效」的坑：
 *
 * - memcached：`-Y` 要求这个构建**带 ASCII 认证支持**，且认证文件要被降权后的
 *   memcache 用户读得到。文件权限差一位，容器就是起不来或者认证没生效。
 * - kafka：SASL 机制开了，但只要**自我广播地址**还写着 `PLAINTEXT://`，
 *   客户端拿到的重定向仍指向明文协议——「配了但不生效」的典型（形状 8）。
 * - nats：官方镜像的 ENTRYPOINT 是二进制本身。我们把它覆盖成 sh 好让口令在容器内
 *   展开，但这也意味着**二进制路径写死错了就完全起不来**，而这在源码里看不出来。
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

const DOCKER_OK = dockerAvailable();
if (!DOCKER_OK) {
  console.warn(
    '[infra-auth-presets] 跳过真容器判据：本机没有可用的 docker daemon。'
    + ' memcached / kafka / nats 三个预设的认证**本次未验证**——'
    + '「命令里写了 --pass」不等于「服务真的在校验口令」。',
  );
}

const PASSWORD = 'a1b2c3d4e5f60718';

/** 完全按 catalog 的产物起容器：命令、entrypoint、env 都取自预设，不在测试里另写一份。 */
function runFromPreset(entry: InfraCatalogEntry, name: string): void {
  const built = entry.build({ password: PASSWORD });
  const q = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
  const envFlags = Object.entries(built.env || {}).map(([k, v]) => `-e ${q(`${k}=${v}`)}`).join(' ');
  const ep = entry.entrypoint
    ? `--entrypoint ${q(Array.isArray(entry.entrypoint) ? entry.entrypoint[0] : entry.entrypoint)}`
    : '';
  const cmdArr = Array.isArray(entry.command) ? entry.command : entry.command ? [entry.command] : [];
  const cmdParts = cmdArr.map(q).join(' ');
  execSync(`docker run -d --name ${name} ${envFlags} ${ep} ${entry.dockerImage} ${cmdParts}`,
    { stdio: 'ignore', timeout: 120_000 });
}

/** 容器还活着吗——起不来的容器和「认证没生效」是两种失败，要分得开。 */
function isRunning(name: string): boolean {
  try {
    return execSync(`docker inspect -f '{{.State.Running}}' ${name}`, { encoding: 'utf8', timeout: 10_000 })
      .trim() === 'true';
  } catch {
    return false;
  }
}

function logsTail(name: string, lines = 30): string {
  try {
    return execSync(`docker logs --tail ${lines} ${name} 2>&1`, { encoding: 'utf8', timeout: 15_000 });
  } catch {
    return '(读不到日志)';
  }
}

function waitFor(check: () => boolean, seconds: number): boolean {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (check()) return true;
    execSync('sleep 0.5');
  }
  return false;
}

const MEMCACHED = getInfraCatalogEntry('memcached')!;
const NATS = getInfraCatalogEntry('nats')!;
const KAFKA = getInfraCatalogEntry('kafka')!;

describe.skipIf(!DOCKER_OK || !imageAvailable(MEMCACHED.dockerImage))('memcached 预设：真容器', () => {
  const name = `cds-memcached-auth-${Date.now()}`;
  afterAll(() => {
    try { execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 15_000 }); } catch { /* 没起来过 */ }
  });

  it('容器起得来，且未认证的连接读不到数据', () => {
    runFromPreset(MEMCACHED, name);
    const up = waitFor(() => isRunning(name), 20);
    expect(up, `memcached 没起来：\n${logsTail(name)}`).toBe(true);

    // 认证文件真的落到了容器里，且降权后的进程读得到。
    const perm = execSync(`docker exec ${name} stat -c %a /tmp/cds-memcached.auth`,
      { encoding: 'utf8', timeout: 10_000 }).trim();
    expect(Number.parseInt(perm, 8) & 0o044, `认证文件权限 ${perm}，降权后的 memcache 读不到`)
      .toBeGreaterThan(0);

    // 不认证直接发命令：开了 `-Y` 的 memcached 会拒绝（CLIENT_ERROR / 断开），
    // 而没开认证的会老老实实返回 END。
    let out = '';
    try {
      out = execSync(
        `docker exec -i ${name} sh -c 'printf "get cds_probe\\r\\nquit\\r\\n" | nc -w 3 127.0.0.1 11211'`,
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      out = String((err as { stdout?: Buffer }).stdout || '');
    }
    expect(out, `未认证的 get 拿到了 "${out.trim()}"——认证没有生效`).not.toMatch(/^END/m);
  }, 180_000);
});

describe.skipIf(!DOCKER_OK || !imageAvailable(NATS.dockerImage))('nats 预设：真容器', () => {
  const name = `cds-nats-auth-${Date.now()}`;
  afterAll(() => {
    try { execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 15_000 }); } catch { /* 没起来过 */ }
  });

  it('容器起得来（entrypoint 覆盖没把二进制路径写死错），且认证真的开着', () => {
    runFromPreset(NATS, name);
    const up = waitFor(() => isRunning(name), 20);
    expect(up, `nats 没起来（多半是 /nats-server 路径不对）：\n${logsTail(name)}`).toBe(true);

    // 口令**不在容器 argv 里**：这正是覆盖 entrypoint 的理由，宿主 ps 看不到明文。
    const pid1 = execSync(`docker exec ${name} sh -c "tr '\\0' ' ' < /proc/1/cmdline"`,
      { encoding: 'utf8', timeout: 10_000 });
    // 主进程是 sh 包起来的那层还是已经 exec 成 nats-server 都行，
    // 但无论哪种形态，明文口令都不许出现。
    expect(pid1, '口令出现在容器 argv 里，宿主 ps 就能看到').not.toContain(PASSWORD);

    // 服务端在 INFO 里自报 auth_required——这是 NATS 协议里「认证开着」的官方判据，
    // 比「日志里有没有某句话」稳。
    const info = execSync(
      `docker exec -i ${name} sh -c 'printf "PING\\r\\n" | timeout 5 nc 127.0.0.1 4222 | head -c 800' || true`,
      { encoding: 'utf8', timeout: 20_000 },
    );
    expect(info, `服务端 INFO 里没有 auth_required：${info.slice(0, 300)}`).toContain('auth_required');
  }, 180_000);
});

describe.skipIf(!DOCKER_OK || !imageAvailable(KAFKA.dockerImage))('kafka 预设：真容器', () => {
  const name = `cds-kafka-auth-${Date.now()}`;
  afterAll(() => {
    try { execSync(`docker rm -f ${name}`, { stdio: 'ignore', timeout: 15_000 }); } catch { /* 没起来过 */ }
  });

  it('broker 起得来，且客户端监听器不是明文', () => {
    runFromPreset(KAFKA, name);
    // KRaft 自举比另外两个慢得多，给足时间；起不来要能看到日志。
    const up = waitFor(
      () => isRunning(name) && /started \(kafka\.server\.KafkaRaftServer\)|Kafka Server started/i.test(logsTail(name, 200)),
      120,
    );
    expect(up, `kafka 没起来：\n${logsTail(name, 60)}`).toBe(true);

    // 不带 SASL 凭据的客户端必须连不上。用镜像自带的 kafka-topics.sh，
    // 默认走 PLAINTEXT，SASL_PLAINTEXT 监听器会把它拒掉。
    let out = '';
    let failed = false;
    try {
      out = execSync(
        `docker exec ${name} /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092`
        + ' --list --command-config /dev/null',
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      failed = true;
      out = String((err as { stdout?: Buffer; stderr?: Buffer }).stderr
        || (err as { stdout?: Buffer }).stdout || '');
    }
    expect(failed, `无凭据的客户端成功列出了 topic：${out.slice(0, 300)}`).toBe(true);
  }, 300_000);
});
