import type { ChildProcess } from 'node:child_process';
import { executeShellCommand } from './shell-executor.js';
import { getHeapStatistics } from 'node:v8';

function startObservationProcess(): void {
  // 模块巡检可以直接导入；没有私有 IPC 的进程不承接命令。
  if (!process.send || !process.connected || !/^cds-observation-[a-f0-9]{32}$/.test(process.argv[1] || '')) return;
  interface Job { id: number; child?: ChildProcess; outstanding: number; lowWater: number; cancelled: boolean }
  let active: Job | undefined;
  const send = (message: unknown): void => { if (process.connected) process.send!(message as object); };
  const terminate = (): void => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  };
  process.on('disconnect', terminate);
  process.on('message', (message: any) => {
    if (message.type === 'cancel' && active && active.id === message.id) {
      active.cancelled = true;
      // Shell退出后由同一清理回执确认全部后代；不能并发清理而误杀彼此的检查进程。
      active.child?.kill('SIGKILL');
      return;
    }
    if (message.type === 'ack' && active && active.id === message.id) {
      active.outstanding = Math.max(0, active.outstanding - message.bytes);
      if (active.outstanding < active.lowWater) { active.child?.stdout?.resume(); active.child?.stderr?.resume(); }
      return;
    }
    if (message.type !== 'exec' || active) return;
    const { id, command, options } = message;
    const job: Job = { id, outstanding: 0, lowWater: options.captureOutput === false ? 64 * 1024 : 256 * 1024, cancelled: false };
    active = job;
    void executeShellCommand(command, {
      cwd: options.cwd, stdin: options.stdin, captureOutput: options.captureOutput,
      ...(options.stream ? { onData: (chunk: string, channel?: 'stdout' | 'stderr') => {
        // 每帧最多8192字符；未确认帧只在有界IPC窗口内等待，不积累完整日志。
        for (let offset = 0; offset < chunk.length;) {
          let end = Math.min(offset + 8192, chunk.length);
          const last = chunk.charCodeAt(end - 1);
          if (end < chunk.length && last >= 0xd800 && last <= 0xdbff) end--;
          const frame = chunk.slice(offset, end);
          offset = end;
          const bytes = Math.max(1024, Buffer.byteLength(frame));
          job.outstanding += bytes;
          send({ type: 'data', id, chunk: frame, channel, bytes });
        }
        const highWater = options.captureOutput === false ? 128 * 1024 : 512 * 1024;
        if (job.outstanding >= highWater) { job.child?.stdout?.pause(); job.child?.stderr?.pause(); }

      } } : {}),
    }, {
      env: options.env, cancelled: () => job.cancelled, processGroup: process.pid,
      onSpawn: child => { job.child = child; },
    }).then(result => {
      active = undefined;
      send(job.cancelled ? { type: 'cancelled', id } : { type: 'result', id, result, metrics: metrics() });
    }, (error: { code?: string }) => {
      if (!job.cancelled || error.code !== 'cancelled') { terminate(); return; }
      active = undefined; send({ type: 'cancelled', id });
    }).catch(terminate);
  });
  const metrics = (): object => ({ pid: process.pid, rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit });
  send({ type: 'ready', pid: process.pid, metrics: metrics() });
}
startObservationProcess();
