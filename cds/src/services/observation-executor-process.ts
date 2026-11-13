import type { ChildProcess } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
import { launchObservationProcess } from './observation-process-launcher.js';
import { cleanObservationGroup } from './observation-process-group.js';

interface Slot { index: number; child: ChildProcess; ready: boolean; registered: boolean; retiring: boolean; job?: any; started?: boolean; timer: NodeJS.Timeout; retireTimer?: NodeJS.Timeout; }
function startObservationExecutorProcess(): void {
  if (!process.send || !process.connected) return;
  const slots = new Map<number, Slot>();
  const pending: any[] = [];
  let initialized = false;
  let bootReady = false;
  let closing = false;
  const owner = process.argv[1];
  if (!/^cds-observation-[a-f0-9]{32}$/.test(owner || '')) return;
  const send = (message: object): void => {
    if (process.connected) process.send!({ ...message, ...('type' in message && ['ready', 'actor-ready', 'result', 'actor-exited'].includes(String(message.type))
      ? { factoryMetrics: { rss: process.memoryUsage().rss, heapLimit: getHeapStatistics().heap_size_limit } } : {}) });
  };
  const fatal = (): void => {
    if (closing) return;
    closing = true;
    for (const slot of slots.values()) kill(slot);
    send({ type: 'fatal' });
  };
  const kill = (slot: Slot): void => {
    if (slot.retiring) return;
    slot.retiring = true;
    const force = (): void => {
      if (slot.child.pid) { try { process.kill(-slot.child.pid, 'SIGKILL'); } catch { /* close 负责确认 */ } }
    };
    // 先让子进程回收 shell；IPC 或事件循环不响应时仍有有界进程组清理。
    slot.retireTimer = setTimeout(force, 2000);
    if (slot.child.connected) slot.child.send({ type: 'shutdown' }, error => { if (error) force(); });
    else force();
  };
  const pump = (): void => {
    if (closing) return;
    for (const slot of slots.values()) {
      if (!slot.ready || !slot.registered || slot.retiring || slot.job || !pending.length) continue;
      const job = pending.shift()!;
      slot.job = job;
      slot.started = !job.requireAuthorization;
      send({ type: 'assigned', id: job.id, pid: slot.child.pid });
      if (slot.started) slot.child.send({ type: 'exec', id: job.id, command: job.command, options: job.options });
    }
  };
  const createSlot = (index: number): void => {
    if (closing) return;
    const child = launchObservationProcess('observation-process', owner);
    const slot: Slot = { index, child, ready: false, registered: false, retiring: false, timer: setTimeout(fatal, 5000) };
    slots.set(index, slot);
    send({ type: 'actor', index, pid: child.pid });
    child.on('message', (message: any) => {
      if (slot.retiring || closing) return;
      if (message.type === 'ready' && message.pid === child.pid) {
        clearTimeout(slot.timer);
        slot.ready = true;
        send({ type: 'actor-ready', index, pid: child.pid, metrics: message.metrics });
        if (!bootReady && slots.size && [...slots.values()].every(s => s.ready && s.registered)) { bootReady = true; send({ type: 'ready' }); }
        pump();
        return;
      }
      if (!slot.job || message.id !== slot.job.id) return;
      if (message.type === 'data') send(message);
      if (message.type === 'result') {
        send({ ...message, pid: child.pid });
        slot.job = undefined;
        pump();
      }
    });
    child.on('error', fatal);
    child.on('close', () => {
      clearTimeout(slot.timer); clearTimeout(slot.retireTimer);
      const expected = slot.retiring;
      // 先确认整组没有可运行后代，再释放原任务和重建该槽位。
      void cleanObservationGroup(child.pid!).then(() => {
        send({ type: 'actor-exited', index, pid: child.pid });
        if (!expected) { fatal(); return; }
        if (slot.job) send({ type: 'cancelled', id: slot.job.id });
        slots.delete(index);
        if (!closing) createSlot(index);
        else if (!slots.size) process.exit(0);
      }, fatal);
    });
  };
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    for (const slot of slots.values()) kill(slot);
    if (!slots.size) process.exit(0);
  };
  process.on('message', (message: any) => {
    if (message.type === 'shutdown') { shutdown(); return; }
    if (message.type === 'initialize' && !initialized) {
      if (!Number.isInteger(message.concurrency) || message.concurrency < 1 || message.concurrency > 16) { fatal(); return; }
      initialized = true;
      for (let i = 0; i < message.concurrency; i++) createSlot(i);
      return;
    }
    if (closing) return;
    if (message.type === 'actor-registered') {
      const slot = slots.get(message.index);
      if (slot && !slot.retiring && slot.child.pid === message.pid) {
        slot.registered = true;
        if (!bootReady && [...slots.values()].every(s => s.ready && s.registered)) { bootReady = true; send({ type: 'ready' }); }
        pump();
      }
    }
    if (message.type === 'exec') { pending.push(message); pump(); }
    if (message.type === 'authorize') {
      const slot = [...slots.values()].find(s => s.job?.id === message.id && !s.retiring && !s.started);
      if (slot) {
        slot.started = true;
        slot.child.send({ type: 'exec', id: slot.job.id, command: slot.job.command, options: slot.job.options });
      }
    }
    if (message.type === 'ack') {
      const slot = [...slots.values()].find(s => s.job?.id === message.id && !s.retiring);
      slot?.child.send(message);
    }
    if (message.type === 'cancel') {
      const queued = pending.findIndex(j => j.id === message.id);
      if (queued >= 0) { pending.splice(queued, 1); send({ type: 'cancelled', id: message.id }); return; }
      const slot = [...slots.values()].find(s => s.job?.id === message.id);
      if (slot && !slot.started) {
        slot.job = undefined; send({ type: 'cancelled', id: message.id }); pump();
      } else if (slot) kill(slot);
    }
  });
  process.on('disconnect', shutdown);
}
startObservationExecutorProcess();
