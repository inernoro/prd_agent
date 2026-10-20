import type { ObservationStreamExecutor } from './observation-stream-executor.js';
import { shellQuoteArg } from './secure-database-cli.js';
import { BoundedLogTail } from './bounded-log-tail.js';

export interface ContainerLogStreamEnd { reason: 'closed' | 'unavailable' | 'capacity' | 'failed' | 'cleanup'; }
export type ContainerLogStreamHandle = AbortController & { readonly completion: Promise<void> };
type Consumer = { ac: AbortController; data: (chunk: string) => boolean | void; close: (result?: ContainerLogStreamEnd) => void };
type Group = { ac: AbortController; consumers: Set<Consumer>; tail: BoundedLogTail; running: Promise<void> };

/** 相同服务共享有界独立读取；连接退出不终止其他查看者，最后一个退出才回收进程组。 */
export class ContainerLogStreamHub {
  private groups = new Map<string, Group>();
  private closed = false;
  private subscribers = 0;
  constructor(private readonly streams: ObservationStreamExecutor, private readonly maxReaders = 2,
    private readonly maxSubscribers = 1024) {}
  subscribe(container: string, onData: Consumer['data'], onClose: Consumer['close'], tail = 200, scope = ''): ContainerLogStreamHandle {
    const ac = new AbortController();
    const safeTail = Math.max(1, Math.min(Number.isFinite(tail) ? Math.floor(tail) : 200, 1000));
    const key = JSON.stringify([scope, container, safeTail]);
    let group = this.groups.get(key);
    if (group?.ac.signal.aborted || this.closed || this.subscribers >= this.maxSubscribers || (!group && this.groups.size >= this.maxReaders)) {
      const reason = this.closed ? 'unavailable' : 'capacity';
      const completion = Promise.resolve().then(() => { if (!ac.signal.aborted) onClose({ reason }); });
      return Object.assign(ac, { completion });
    }
    const fresh = !group;
    if (!group) {
      group = { ac: new AbortController(), consumers: new Set(), tail: new BoundedLogTail(), running: Promise.resolve() };
      this.groups.set(key, group);
    }
    const consumer: Consumer = { ac, data: onData, close: onClose }; group.consumers.add(consumer); this.subscribers++;
    const current = group;
    ac.signal.addEventListener('abort', () => {
      if (current.consumers.delete(consumer)) this.subscribers--;
      if (!current.consumers.size) current.ac.abort();
    }, { once: true });
    if (fresh) { current.running = this.read(key, current, container, safeTail); void current.running.catch(() => {}); }
    else {
      const replay = current.tail.text(safeTail);
      if (replay) this.deliver(consumer, replay);
    }
    return Object.assign(ac, { completion: current.running });
  }
  getStats(): { readers: number; subscribers: number; retainedBytes: number } {
    return { readers: this.groups.size, subscribers: this.subscribers,
      retainedBytes: [...this.groups.values()].reduce((n, x) => n + x.tail.getStats().retainedBytes, 0) };
  }
  async close(): Promise<void> {
    this.closed = true;
    const groups = [...this.groups.values()]; groups.forEach(group => group.ac.abort());
    await Promise.all(groups.map(group => group.running));
  }
  private deliver(consumer: Consumer, chunk: string): void {
    if (consumer.ac.signal.aborted) return;
    try { if (consumer.data(chunk) === false) consumer.ac.abort(); }
    catch { consumer.ac.abort(); }
  }
  private async read(key: string, group: Group, container: string, tail: number): Promise<void> {
    let end: ContainerLogStreamEnd = { reason: 'closed' }; let cleanupError: unknown;
    try {
      const result = await this.streams.exec(['docker', 'logs', '--timestamps', '-f', '--tail', String(tail), container].map(shellQuoteArg).join(' '), {
        timeout: 0, signal: group.ac.signal, onData: chunk => {
          if (group.ac.signal.aborted) return;
          group.tail.append(chunk);
          for (const consumer of group.consumers) this.deliver(consumer, chunk);
        },
      });
      if (result.exitCode !== 0) end = { reason: 'failed' };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'cleanup') { end = { reason: 'cleanup' }; cleanupError = error; }
      else if (!group.ac.signal.aborted) end = { reason: code === 'capacity' ? 'capacity' : 'unavailable' };
    } finally {
      if (this.groups.get(key) === group) this.groups.delete(key);
      for (const consumer of group.consumers) {
        group.consumers.delete(consumer); this.subscribers--;
        try { consumer.close(end); } catch { /* 一个响应收尾失败不阻止其他连接收尾 */ }
      }
      group.consumers.clear(); group.tail.clear();
    }
    if (cleanupError) throw cleanupError;
  }
}
