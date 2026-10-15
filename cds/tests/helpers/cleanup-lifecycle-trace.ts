import { appendFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

interface TracedExecutor {
  start(): Promise<void>;
  close(): Promise<void>;
  getStats(): unknown;
}

/** 显式诊断时只记生命周期/PID与计数，不记录命令、环境或业务输出。 */
export function traceExecutor<T extends TracedExecutor>(executor: T, scope: string): T {
  const file = process.env.CDS_CLEANUP_TRACE;
  if (!file) return executor;
  const record = (event: string, message?: Record<string, unknown>): void => {
    const stats = executor.getStats() as Record<string, unknown>;
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(),
      testPid: process.pid, scope, event, generation: message?.generation, messagePid: message?.pid,
      jobId: message?.id, active: stats.active, queued: stats.queued, admitted: stats.admitted,
      unavailable: stats.unavailable, supervisorPid: stats.supervisorPid, factoryPid: stats.factoryPid,
      actors: stats.actors }) + '\n');
  };
  let hooked = false;
  const start = executor.start.bind(executor);
  executor.start = () => {
    record('start-requested');
    const starting = start();
    const outer = executor as unknown as { factory?: ChildProcess; shell?: { factory?: ChildProcess } };
    const channel = (outer.shell ?? outer).factory;
    if (channel && !hooked) {
      hooked = true;
      channel.on('message', (message: Record<string, unknown>) => {
        if (['factory-started', 'factory-resetting', 'factory-cleaned', 'ready', 'fatal', 'actor',
          'actor-ready', 'actor-exited', 'assigned', 'cancelled', 'result'].includes(String(message.type))) {
          record(String(message.type), message);
        }
      });
    }
    void starting.then(() => record('start-resolved'), () => record('start-rejected'));
    return starting;
  };
  const close = executor.close.bind(executor);
  executor.close = () => {
    record('close-requested');
    const closing = close();
    void closing.then(() => record('close-resolved'), () => record('close-rejected'));
    return closing;
  };
  return executor;
}
