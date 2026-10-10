import type { ChildProcess } from 'node:child_process';
import { executeShellCommand } from './shell-executor.js';
import { getHeapStatistics } from 'node:v8';

function startObservationProcess(): void {
  // 模块巡检可以直接导入；没有私有 IPC 的进程不承接命令。
  if (!process.send || !process.connected || !/^cds-observation-[a-f0-9]{32}$/.test(process.argv[1] || '')) return;
  let active: { id: number; child?: ChildProcess; outstanding: number } | undefined;
  const send = (message: unknown): void => { if (process.connected) process.send!(message as object); };
  const terminate = (): void => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  };
  process.on('disconnect', terminate);
  process.on('message', (message: any) => {
    if (message.type === 'ack' && active && active.id === message.id) {
      active.outstanding = Math.max(0, active.outstanding - message.bytes);
      if (active.outstanding < 256 * 1024) { active.child?.stdout?.resume(); active.child?.stderr?.resume(); }
      return;
    }
    if (message.type !== 'exec' || active) return;
    const { id, command, options } = message;
    const job: { id: number; child?: ChildProcess; outstanding: number } = { id, outstanding: 0 };
    active = job;
    void executeShellCommand(command, {
      cwd: options.cwd, stdin: options.stdin,
      ...(options.stream ? { onData: (chunk: string) => {
        const bytes = Math.max(1024, Buffer.byteLength(chunk));
        job.outstanding += bytes;
        send({ type: 'data', id, chunk, bytes });
        if (job.outstanding >= 512 * 1024) { job.child?.stdout?.pause(); job.child?.stderr?.pause(); }
      } } : {}),
    }, {
      env: options.env, cancelled: () => false, processGroup: process.pid,
      onSpawn: child => { job.child = child; },
    }).then(result => { active = undefined; send({ type: 'result', id, result, metrics: metrics() }); }, () => terminate());
  });
  const metrics = (): object => ({ pid: process.pid, rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit });
  send({ type: 'ready', pid: process.pid, metrics: metrics() });
}
startObservationProcess();
