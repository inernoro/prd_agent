import type { ChildProcess } from 'node:child_process';
import { launchObservationProcess } from './observation-process-launcher.js';
import { cleanObservationGroup } from './observation-process-group.js';

interface Slot { index: number; child: ChildProcess; ready: boolean; registered: boolean; retiring: boolean; job?: any; timer: NodeJS.Timeout; }
function startObservationExecutorProcess(): void {
  if (!process.send || !process.connected) return;
  const slots = new Map<number, Slot>();
  const pending: any[] = [];
  let initialized = false;
  let bootReady = false;
  let closing = false;
  const owner = process.argv[1];
  if (!/^cds-observation-[a-f0-9]{32}$/.test(owner || '')) return;
  const send = (message: object): void => { if (process.connected) process.send!(message); };
  const fatal = (): void => {
    if (closing) return;
    closing = true;
    for (const slot of slots.values()) kill(slot);
    send({ type: 'fatal' });
  };
  const kill = (slot: Slot): void => {
    slot.retiring = true;
    if (slot.child.pid) { try { process.kill(-slot.child.pid, 'SIGKILL'); } catch { /* exit 负责确认 */ } }
  };
  const pump = (): void => {
    if (closing) return;
    for (const slot of slots.values()) {
      if (!slot.ready || !slot.registered || slot.retiring || slot.job || !pending.length) continue;
      const job = pending.shift()!;
      slot.job = job;
      send({ type: 'assigned', id: job.id, pid: slot.child.pid });
      slot.child.send({ type: 'exec', id: job.id, command: job.command, options: job.options });
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
    child.on('exit', () => {
      clearTimeout(slot.timer);
      const expected = slot.retiring;
      // 先确认整组没有可运行后代，再释放原任务和重建该槽位。
      void cleanObservationGroup(child.pid!).then(() => {
        send({ type: 'actor-exited', index, pid: child.pid });
        if (!expected) { fatal(); return; }
        if (slot.job) send({ type: 'cancelled', id: slot.job.id });
        slots.delete(index);
        if (!closing) createSlot(index);
      }, fatal);
    });
  };
  process.on('message', (message: any) => {
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
    if (message.type === 'ack') {
      const slot = [...slots.values()].find(s => s.job?.id === message.id && !s.retiring);
      slot?.child.send(message);
    }
    if (message.type === 'cancel') {
      const queued = pending.findIndex(j => j.id === message.id);
      if (queued >= 0) { pending.splice(queued, 1); send({ type: 'cancelled', id: message.id }); return; }
      const slot = [...slots.values()].find(s => s.job?.id === message.id);
      if (slot) kill(slot);
    }
  });
  process.on('disconnect', () => {
    closing = true;
    for (const slot of slots.values()) kill(slot);
    // Actor IPC 断开也会清理自身组；factory 不再承接任何查询。
    process.exit(0);
  });
}
startObservationExecutorProcess();
