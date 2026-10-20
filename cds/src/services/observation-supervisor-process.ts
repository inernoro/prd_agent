import type { ChildProcess } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
import { launchObservationProcess } from './observation-process-launcher.js';
import { cleanObservationGroup, findObservationOwners } from './observation-process-group.js';

/** 大状态加载前预热的私有监督进程；失效工厂只在旧归属清理确认后替换。 */
function startSupervisor(): void {
  const owner = process.argv[1];
  if (!process.send || !process.connected || !/^cds-observation-[a-f0-9]{32}$/.test(owner || '')) return;
  let child: ChildProcess | undefined;
  let concurrency: number | undefined;
  let generation = 0;
  let recovering = false;
  let closing = false;
  let retry: NodeJS.Timeout | undefined;
  let bootTimer: NodeJS.Timeout | undefined;
  const actors = new Set<number>();
  const attempts: number[] = [];
  const send = (message: object): void => { if (process.connected) process.send!(message); };
  const metrics = (): object => ({ rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit });
  const kill = (pid: number): void => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 后续确认归属 */ } };
  const fail = (): void => { closing = true; clearTimeout(retry); clearTimeout(bootTimer); send({ type: 'fatal', generation }); };
  const launch = (): void => {
    if (closing || concurrency === undefined) return;
    const now = Date.now(); while (attempts.length && attempts[0] <= now - 30_000) attempts.shift();
    if (attempts.length >= 3) { retry = setTimeout(launch, Math.max(1, attempts[0] + 30_000 - now)); return; }
    attempts.push(now); generation++;
    const current = launchObservationProcess('observation-executor-process', owner); child = current; actors.clear();
    const currentGeneration = generation;
    // 每一代均沿用原5秒就绪预算；进程仍活着不能使替换永久悬挂。
    bootTimer = setTimeout(() => { void recover(current); }, 5000);
    send({ type: 'factory-started', generation, pid: current.pid, supervisorMetrics: metrics() });
    current.on('message', (message: any) => {
      if (closing || recovering || child !== current) return;
      if (message.type === 'ready') clearTimeout(bootTimer);
      if (message.type === 'fatal') { void recover(current); return; }
      if (message.type === 'actor' && Number.isSafeInteger(message.pid) && message.pid > 1 && message.pid !== process.pid) actors.add(message.pid);
      if (message.type === 'actor-exited') actors.delete(message.pid);
      send({ ...message, generation: currentGeneration });
    });
    current.on('error', () => { void recover(current); });
    current.on('exit', () => { void recover(current); });
    current.send({ type: 'initialize', concurrency }, error => { if (error) void recover(current); });
  };
  const recover = async (current: ChildProcess): Promise<void> => {
    if (closing || recovering || child !== current) return;
    recovering = true; clearTimeout(bootTimer); const failedGeneration = generation;
    send({ type: 'factory-resetting', generation: failedGeneration });
    try {
      const groups = new Set(actors); if (current.pid) groups.add(current.pid);
      const closed = current.exitCode !== null || current.signalCode !== null
        ? Promise.resolve() : new Promise<void>(resolve => current.once('close', () => resolve()));
      for (const pid of groups) kill(pid);
      await closed;
      for (let pass = 0; pass < 2; pass++) {
        for (const owned of await findObservationOwners(owner)) {
          if (owned.pid === process.pid) continue;
          if (owned.pid <= 1 || owned.group === process.pid) throw new Error('Invalid supervised process group');
          if (owned.pid === owned.group) groups.add(owned.group);
          try { process.kill(owned.pid, 'SIGKILL'); } catch { /* 进程组确认处理退出竞态 */ }
        }
        await Promise.all([...groups].map(group => cleanObservationGroup(group)));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (closing) return;
      child = undefined; actors.clear();
      send({ type: 'factory-cleaned', generation: failedGeneration, supervisorMetrics: metrics() });
      // 旧归属已确认清理，立即重建；故障频率仍受原30秒三次上限约束。
      recovering = false; retry = setTimeout(launch, 0);
    } catch { fail(); }
  };
  process.on('message', (message: any) => {
    if (message.type === 'initialize' && concurrency === undefined) {
      if (!Number.isSafeInteger(message.concurrency) || message.concurrency < 1 || message.concurrency > 16) { fail(); return; }
      concurrency = message.concurrency; launch(); return;
    }
    if (message.type === 'restart-after-startup-deadline') {
      if (child) void recover(child);
      else if (!closing && !recovering) send({ type: 'factory-cleaned', generation, supervisorMetrics: metrics() });
      return;
    }
    if (closing || recovering || !child?.connected) return;
    child.send(message, error => { if (error && child) void recover(child); });
  });
  process.on('disconnect', () => {
    closing = true; clearTimeout(retry); clearTimeout(bootTimer);
    if (child?.pid) kill(child.pid);
    for (const pid of actors) kill(pid);
    process.exit(0);
  });
}
startSupervisor();
