/**
 * 启动期关键依赖的重试与诊断（2026-07-27 宕机复盘 P1，事故本体）。
 *
 * 事故链条：根盘写满 → CDS 自用 mongo 因 FileStreamFailed 退出 → master 启动时
 * `splitStore.init()` 抛错 → 整个 boot 直接 `throw` → 进程退出 → systemd 重启 →
 * 再抛 → 如此往复，systemd 的 restart counter 一路走到 58，35 分钟全站 502。
 *
 * 两个独立的问题，这里各治一半：
 *
 * 1. **不该一次失败就死**。mongo 起不来往往是暂时的（宿主正忙、容器正在重启、
 *    磁盘刚被清出空间）。一次失败就退出，把「等几十秒就能好」变成「systemd
 *    疯狂重启」——每次重启都要重跑一遍 boot，在一台已经着火的机器上继续浇油。
 *    改为有上限的退避重试：耐心等一会儿，等不到再退出（仍然退出，不静默降级到
 *    JSON —— 那是另一个更糟的坑：CDS 跑在过期 JSON 上而真相在 mongo 里）。
 *
 * 2. **报错要指向真凶**。运维看到的是一句 mongo 连接失败，真正的原因是磁盘满。
 *    最终放弃前先看一眼磁盘，满盘就明写出来，别让人从 mongo 开始查。
 */

/** 每次重试前等待的毫秒数（指数退避 + 上限）。attempt 从 1 开始。 */
export function bootRetryDelayMs(attempt: number, baseMs = 2_000, maxMs = 30_000): number {
  if (attempt < 1) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

/**
 * 默认重试次数：2/4/8/16/30/30 = 90s 的忍耐窗口，足够覆盖容器重启。
 *
 * 注意是 **7 次尝试 = 6 段等待**（Codex PR #1275 十轮 P2）：循环只在两次尝试
 * *之间* 睡，N 次尝试只有 N-1 段等待。原先写 6 实际只等 2+4+8+16+30 = 60s，
 * 比注释承诺的 90s 少整整一段 30s —— 而 mongo 恰在最后那 30s 内恢复时，CDS
 * 已经退出进了 systemd 重启循环，正是本改动要消灭的东西。
 */
export const DEFAULT_BOOT_RETRY_ATTEMPTS = 7;

/** 给定尝试次数下实际的总忍耐窗口（毫秒）——注释里的数字由它算出，不靠手写。 */
export function bootRetryWindowMs(attempts = DEFAULT_BOOT_RETRY_ATTEMPTS): number {
  let total = 0;
  for (let attempt = 1; attempt < Math.max(1, attempts); attempt += 1) {
    total += bootRetryDelayMs(attempt);
  }
  return total;
}

export interface BootRetryOptions {
  attempts?: number;
  sleep: (ms: number) => Promise<void>;
  /** 每次失败后回调（打日志用）。 */
  onAttemptFailed?: (attempt: number, attemptsTotal: number, delayMs: number, err: unknown) => void;
}

/**
 * 跑一个可能失败的启动步骤，失败按退避重试；全部用尽后抛出**最后一次**的错误。
 *
 * 刻意不吞异常：耗尽重试仍失败就是真的起不来，该退出还是要退出——只是现在
 * 退出前已经耐心等过，而不是撞一下就死。
 */
export async function withBootRetry<T>(fn: () => Promise<T>, opts: BootRetryOptions): Promise<T> {
  const attemptsTotal = Math.max(1, opts.attempts ?? DEFAULT_BOOT_RETRY_ATTEMPTS);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attemptsTotal) break;
      const delayMs = bootRetryDelayMs(attempt);
      opts.onAttemptFailed?.(attempt, attemptsTotal, delayMs, err);
      await opts.sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * 依赖起不来时的磁盘诊断：满盘（或接近满盘）时给出直指真凶的一句话。
 * 返回 null = 磁盘不是问题，别误导排障方向。
 */
export function diagnoseDiskForBootFailure(
  usage: { totalBytes: number; freeBytes: number } | null,
  fullPercentThreshold = 95,
): string | null {
  if (!usage || !Number.isFinite(usage.totalBytes) || usage.totalBytes <= 0) return null;
  const usedPercent = Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100);
  if (usedPercent < fullPercentThreshold) return null;
  const freeMb = Math.max(0, Math.round(usage.freeBytes / 1024 / 1024));
  return `磁盘已用 ${usedPercent}%（剩余 ${freeMb}MB）——依赖起不来极可能是**磁盘写满**导致的，`
    + `请先清盘再重启，不要从数据库连接开始排查（2026-07-27 宕机即此因）。`;
}

/**
 * 多挂载点版磁盘诊断（Codex PR #1275 十轮 P2）。
 *
 * 只量仓库目录是不够的：**mongo 的数据落在 docker 数据根**，两者常不在同一个
 * 文件系统上。2026-07-27 撑爆的正是 containerd 那一侧（159GB），而仓库盘看着
 * 还很宽裕 —— 于是这句本该直指真凶的提示恰好在真凶的场景下不出现。
 * 运行期的 diskGuard 早就两个挂载点都量（index.ts 的 setProbe），但启动失败时
 * 进程根本走不到那里，所以这条失败路径必须自己量全。
 *
 * 任一挂载点满即出提示，并标明是哪个路径满了（多处同时满就都列出来）。
 */
export function diagnoseDisksForBootFailure(
  readings: Array<{ label: string; usage: { totalBytes: number; freeBytes: number } | null }>,
  fullPercentThreshold = 95,
): string | null {
  const hints: string[] = [];
  for (const { label, usage } of readings) {
    const hint = diagnoseDiskForBootFailure(usage, fullPercentThreshold);
    if (hint) hints.push(`[${label}] ${hint}`);
  }
  return hints.length > 0 ? hints.join(' ') : null;
}
