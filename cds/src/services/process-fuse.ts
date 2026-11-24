import type { ServerEventLogSink } from './server-event-log-store.js';

/**
 * 进程总保险丝。
 *
 * ## 为什么要有
 *
 * 2026-08-18 线上 18 分钟不可用，根因不是业务逻辑错了，而是**一个后台小事失败把
 * 整台 CDS 弄死了**：离机审计日志上传收到 R2 的 401，失败被重新抛进一条没人接住的
 * promise 链，Node 默认策略把「无人处理的拒绝」当作致命错误直接终止进程。systemd
 * 拉起来 → 启动时又发事件 → 又 401 → 又死，重试超限后彻底停摆。
 *
 * CDS 是所有分支预览的总闸，它一停没人能远程救回来（当时确实没人救得了，只能等
 * 它自己滚回旧版）。所以「一个灯泡烧了不能让整栋楼断电」这件事必须在最外层兜住。
 *
 * ## 两种信号，两种处理
 *
 * | 信号 | 含义 | 这里怎么办 | 为什么 |
 * |---|---|---|---|
 * | `unhandledRejection` | 某个发出去就不管的异步动作失败了 | **记一笔，继续跑** | 这类失败天然是局部的（一次上传、一次探测）。为它杀掉整个进程，代价远大于收益 |
 * | `uncaughtException` | 同步栈上抛出且无人捕获 | 记一笔（含调用栈），**照旧退出** | 此时进程状态可能已经不一致，硬撑下去会写出错数据。这里只保证**留下证据**，不改变生死 |
 *
 * 第二条是这次事故的另一半教训：进程死了，事件流里**一个字都没有**，排障只能靠
 * systemd 那句「Failed with result 'exit-code'」猜。现在至少死之前会留下调用栈。
 *
 * ## 不做什么
 *
 * 不吞掉、不重试、不降级为静默。每一次触发都落一条 error 事件——保险丝跳闸要看得见，
 * 否则就从「整栋楼断电」变成了「灯一直不亮却没人知道」，那是另一种更难查的毛病。
 */
export interface ProcessFuseOptions {
  store?: ServerEventLogSink | null;
  /** 进程名，用来区分是 master 还是 forwarder 触发的。 */
  processName: string;
  /** 注入点：默认用真的 process，测试传假的。 */
  target?: Pick<NodeJS.Process, 'on'>;
  /** 退出动作，默认 process.exit。测试里换成记录调用。 */
  exit?: (code: number) => void;
  logger?: Pick<Console, 'error'>;
}

export interface ProcessFuseHandle {
  /** 已经兜住过多少次拒绝——健康探针可以据此判断「一直在跳闸」。 */
  rejectionCount: () => number;
  lastRejection: () => { at: string; message: string } | null;
}

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack };
  try {
    return { message: typeof reason === 'string' ? reason : JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

export function installProcessFuse(opts: ProcessFuseOptions): ProcessFuseHandle {
  const target = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const logger = opts.logger ?? console;
  let rejections = 0;
  let last: { at: string; message: string } | null = null;

  target.on('unhandledRejection', (reason: unknown) => {
    rejections += 1;
    const d = describe(reason);
    last = { at: new Date().toISOString(), message: d.message };
    // 先 console：落事件本身也可能失败（今天失败的恰好就是事件外发），
    // 那时至少 journal 里还留得下一行。
    logger.error(`[process-fuse] 兜住一个无人处理的 promise 拒绝（第 ${rejections} 次）：${d.message}`);
    opts.store?.record({
      category: 'system',
      severity: 'error',
      source: 'process-fuse',
      action: 'process.unhandled-rejection',
      message: `${opts.processName} 兜住一个无人处理的 promise 拒绝，进程继续运行`,
      error: { message: d.message },
      details: { processName: opts.processName, count: rejections, stack: d.stack?.slice(0, 4000) },
    });
  });

  target.on('uncaughtException', (err: Error) => {
    const d = describe(err);
    logger.error(`[process-fuse] 未捕获异常，进程即将退出：${d.message}\n${d.stack || ''}`);
    opts.store?.record({
      category: 'system',
      severity: 'error',
      source: 'process-fuse',
      action: 'process.uncaught-exception',
      message: `${opts.processName} 未捕获异常，进程退出`,
      error: { message: d.message },
      details: { processName: opts.processName, stack: d.stack?.slice(0, 8000) },
    });
    // 尽量把这条冲出去再走——留证据是这个分支唯一的目的。
    const flushed = opts.store?.flush?.();
    if (flushed && typeof (flushed as Promise<void>).then === 'function') {
      (flushed as Promise<void>).catch(() => undefined).then(() => exit(1));
      return;
    }
    exit(1);
  });

  return { rejectionCount: () => rejections, lastRejection: () => last };
}
