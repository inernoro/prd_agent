import { parentPort } from 'node:worker_threads';
import type { ChildProcess } from 'node:child_process';
import { executeShellCommand } from './shell-executor.js';

function startObservationWorker(): void {
  const port = parentPort;
  // 模块加载巡检会导入所有服务文件；主线程导入不能注册执行器或启动进程。
  if (!port) return;
  const active = new Map<number, { child?: ChildProcess; outstanding: number }>();
  port.on('message', (message) => {
    if (message.type === 'ack') {
      const job = active.get(message.id);
      if (!job) return;
      job.outstanding = Math.max(0, job.outstanding - message.bytes);
      if (job.outstanding < 256 * 1024) { job.child?.stdout?.resume(); job.child?.stderr?.resume(); }
      return;
    }
    if (message.type !== 'exec') return;
    const { id, command, options, control } = message;
    const flag = new Int32Array(control);
    const job: { child?: ChildProcess; outstanding: number } = { outstanding: 0 };
    active.set(id, job);
    // 已取消的待办不创建进程；原生 fork 期间的取消在 PID 返回后清理，不能承诺硬截止。
    if (Atomics.load(flag, 0)) {
      active.delete(id);
      port.postMessage({ type: 'cancelled', id });
      return;
    }
    void executeShellCommand(command, {
      cwd: options.cwd, stdin: options.stdin,
      ...(options.stream ? { onData: (chunk: string) => {
        const bytes = Buffer.byteLength(chunk);
        job.outstanding += bytes;
        port.postMessage({ type: 'data', id, chunk, bytes });
        if (job.outstanding >= 512 * 1024) { job.child?.stdout?.pause(); job.child?.stderr?.pause(); }
      } } : {}),
    }, {
      env: options.env,
      cancelled: () => Atomics.load(flag, 0) !== 0,
      onSpawn: (child) => { job.child = child; Atomics.store(flag, 1, child.pid ?? 0); },
    }).then((result) => {
      Atomics.store(flag, 1, 0);
      active.delete(id);
      port.postMessage({ type: 'result', id, result });
    }, () => {
      Atomics.store(flag, 1, 0);
      active.delete(id);
      port.postMessage({ type: 'cancelled', id });
    });
  });
  port.postMessage({ type: 'ready' });
}
startObservationWorker();
