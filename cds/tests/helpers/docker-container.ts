import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * 真容器测试的公共装置：排队、探活、失败时留证。
 *
 * ## 为什么需要排队
 *
 * vitest 默认**按文件并行**跑测试，每个文件一个 worker 进程。本仓库原来只有两个真容器
 * 用例（alpine、redis），都很轻，并行毫无问题。这一轮一次加了四个重型的
 * （postgres、rabbitmq、nacos、kafka——后两个还是 JVM），于是它们在 CI runner 上
 * **同时**启动：2026-08-25 首轮 CI 四个容器全部没起来，日志里只有
 * 「expected false to be true」，看不出是配置错还是机器扛不住。
 *
 * 所以这里给重型容器一条队：同一时刻只有一个测试文件在起容器。这不是给测试打补丁——
 * 「几个数据库同时冷启动」本来就不是这些用例要验的东西，让它们互相拖垮只会产生
 * 查不出原因的偶发红。
 *
 * 锁用 `mkdirSync`：POSIX 上创建目录是原子的，跨进程可靠，不需要额外依赖。
 * 带**过期回收**——某个 worker 被强杀留下的锁不能把后面所有用例永久挡在门外。
 *
 * ## 为什么探活要自己写
 *
 * 「容器起来了」和「服务能用了」是两件事，而且中间那段空窗每种服务都不一样。
 * postgres 尤其阴：官方镜像 initdb 阶段会先起一个**临时服务器**，此时 `pg_isready`
 * 就已经返回成功，而目标库还没建出来——首轮 CI 的 `database "appdb" does not exist`
 * 正是这么来的。所以探活判据必须是「拿目标库真跑一次查询」，不是「端口通了」。
 *
 * ## 为什么失败必须留证
 *
 * 首轮 CI 四个容器全挂，而我拿到的全部信息是一句布尔断言失败——没有容器日志、
 * 没有退出码，等于要再花一轮 CI 才能开始诊断。一个不说明原因的失败，
 * 和一个静默跳过的绿灯是同一类毛病。
 */

/** 锁目录。放在系统临时目录下，同机所有 worker 共用一把。 */
const SLOT_DIR = path.join(os.tmpdir(), 'cds-docker-slot.lock');

/** 锁多久算陈旧。比单个真容器用例的最长超时再宽一点，免得误抢。 */
const SLOT_STALE_MS = 20 * 60_000;

/** 等锁的上限。等不到就直接失败，而不是无限挂着让 CI 超时后一句话都没有。 */
const SLOT_WAIT_MS = 25 * 60_000;

function sleepSync(ms: number): void {
  // 同步等待：这些用例本来就是同步 execSync 风格，引入 async 会让调用方全变色。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 排队拿到「可以起重型容器」的许可。拿不到就抛，并说清等了多久。
 *
 * @param label 谁在等，进日志与报错，方便看出是谁卡住了。
 */
export function acquireDockerSlot(label: string): void {
  const startedAt = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(SLOT_DIR);
      fs.writeFileSync(path.join(SLOT_DIR, 'owner'), `${label} pid=${process.pid} at=${new Date().toISOString()}`);
      return;
    } catch {
      // 已经有人占着。先看它是不是死了留下的。
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(SLOT_DIR).mtimeMs;
      } catch {
        continue;   // 刚被别人释放，立刻重试
      }
      if (ageMs > SLOT_STALE_MS) {
        // 陈旧锁：被强杀的 worker 不该把后面所有用例永久挡住。
        let owner = '(读不到持有者)';
        try { owner = fs.readFileSync(path.join(SLOT_DIR, 'owner'), 'utf8'); } catch { /* 无所谓 */ }
        console.warn(`[docker-slot] 回收陈旧锁（已 ${Math.round(ageMs / 1000)}s），原持有者：${owner}`);
        try { fs.rmSync(SLOT_DIR, { recursive: true, force: true }); } catch { /* 下一轮再试 */ }
        continue;
      }
      if (Date.now() - startedAt > SLOT_WAIT_MS) {
        let owner = '(读不到持有者)';
        try { owner = fs.readFileSync(path.join(SLOT_DIR, 'owner'), 'utf8'); } catch { /* 无所谓 */ }
        throw new Error(
          `[docker-slot] ${label} 等容器槽位超过 ${Math.round(SLOT_WAIT_MS / 60_000)} 分钟仍没轮到，`
          + `当前持有者：${owner}`,
        );
      }
      sleepSync(1_000);
    }
  }
}

/** 释放槽位。必须放在 afterAll 里，且要能容忍「本来就没拿到」。 */
export function releaseDockerSlot(): void {
  try { fs.rmSync(SLOT_DIR, { recursive: true, force: true }); } catch { /* 已经没了 */ }
}

/** 取容器日志尾巴。拿不到就返回一句说明，绝不抛——它本身是用来解释别的失败的。 */
export function dockerLogsTail(name: string, lines = 40): string {
  try {
    // 缓冲要给够：execSync 默认 1MB，JVM 服务的日志轻松超过，超了会 ENOBUFS
    // 而不是截断——诊断信息会整个丢掉，只剩一句「取不到」。
    return execSync(`docker logs --tail ${lines} ${name} 2>&1`, {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return `(取不到容器日志：${(err as Error).message})`;
  }
}

/** 容器现在是什么状态（running / exited(1) / 不存在）。 */
export function dockerState(name: string): string {
  try {
    return execSync(
      `docker inspect -f '{{.State.Status}} exitCode={{.State.ExitCode}} oom={{.State.OOMKilled}}' ${name}`,
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
  } catch {
    return '(容器不存在或 inspect 失败)';
  }
}

/**
 * 等到服务真的能用为止。
 *
 * @param probe 一条在容器里跑的探活命令。**必须是真业务查询**，不是「端口通了」——
 *              见文件头 postgres 那个坑。返回 true 表示可用。
 *
 * 失败时抛出的错误里带着容器状态与日志尾巴：一个不说明原因的失败，
 * 和一个静默跳过的绿灯是同一类毛病。
 */
export function waitForService(opts: {
  name: string;
  label: string;
  probe: () => boolean;
  timeoutMs: number;
  intervalMs?: number;
}): void {
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + opts.timeoutMs;
  let lastProbeError = '';
  while (Date.now() < deadline) {
    // 容器已经退出就别再空等到超时——那只会把「起不来」拖成「超时」，
    // 两者的排查方向完全不同（活性早退，与并发闸纪律同源）。
    const state = dockerState(opts.name);
    if (state.startsWith('exited') || state.startsWith('dead')) {
      throw new Error(
        `${opts.label} 容器已退出（${state}），没等到就绪。容器日志尾部：\n${dockerLogsTail(opts.name)}`,
      );
    }
    try {
      if (opts.probe()) return;
    } catch (err) {
      lastProbeError = (err as Error).message;
    }
    sleepSync(interval);
  }
  throw new Error(
    `${opts.label} 在 ${Math.round(opts.timeoutMs / 1000)} 秒内没有就绪。`
    + `容器状态：${dockerState(opts.name)}\n`
    + `最后一次探活报错：${lastProbeError || '(探活返回 false，无异常)'}\n`
    + `容器日志尾部：\n${dockerLogsTail(opts.name)}`,
  );
}
