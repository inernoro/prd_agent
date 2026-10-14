import { ObservationStreamExecutor } from './observation-stream-executor.js';
import { shellQuoteArg } from './secure-database-cli.js';

const MAX_EVENT_LINE_BYTES = 64 * 1024;
/** Docker事件共用有界逐行读取；一条诊断完成后才消费下一条，重连不叠加进程。 */
export class DockerObservationEventStream {
  private enabled = false;
  private connection?: AbortController;
  private running?: Promise<void>;
  private consuming?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private bufferedBytes = 0;
  private overflowLines = 0;
  constructor(private readonly streams: ObservationStreamExecutor, private readonly argv: string[],
    private readonly onLine: (line: string, signal: AbortSignal) => void | Promise<void>,
    private readonly onWarning: (reason: string) => void, private readonly reconnectMs = 5000) {}
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }
  stop(): Promise<void> {
    this.enabled = false;
    clearTimeout(this.timer); this.timer = undefined;
    this.connection?.abort();
    return this.running ?? Promise.resolve();
  }
  getStats(): { active: boolean; bufferedBytes: number; overflowLines: number } {
    return { active: !!this.running, bufferedBytes: this.bufferedBytes, overflowLines: this.overflowLines };
  }
  private warn(reason: string): void { try { this.onWarning(reason); } catch { /* 诊断失败不产生第二条连接 */ } }
  private connect(): void {
    if (!this.enabled || this.running || this.timer) return;
    const ac = new AbortController(); this.connection = ac;
    const running = this.read(ac); this.running = running;
    void running.finally(() => {
      if (this.running !== running) return;
      this.running = undefined; this.connection = undefined;
      if (!this.enabled) return;
      // start紧随stop也必须等旧进程组及消费回执完成，不能双开事件连接。
      this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, ac.signal.aborted ? 0 : this.reconnectMs);
      this.timer.unref?.();
    }).catch(() => {});
  }
  private async read(ac: AbortController): Promise<void> {
    let buffer = ''; let dropping = false;
    const consume = async (chunk: string, channel?: 'stdout' | 'stderr'): Promise<void> => {
      if (ac.signal.aborted) return;
      if (channel === 'stderr') { this.warn(chunk.trim().slice(0, 8192)); return; }
      let offset = 0;
      while (offset < chunk.length && !ac.signal.aborted) {
        const newline = chunk.indexOf('\n', offset);
        const end = newline < 0 ? chunk.length : newline;
        if (!dropping) {
          buffer += chunk.slice(offset, end);
          this.bufferedBytes = Buffer.byteLength(buffer);
          if (this.bufferedBytes > MAX_EVENT_LINE_BYTES) {
            buffer = ''; this.bufferedBytes = 0; dropping = true; this.overflowLines++;
            this.warn('Docker事件超过64KiB，已跳过整行；后续事件继续读取。');
          }
        }
        if (newline < 0) break;
        if (!dropping && buffer.trim()) {
          try { await this.onLine(buffer.trim(), ac.signal); }
          catch { if (!ac.signal.aborted) this.warn('Docker事件处理未确认，请查看诊断并核对容器状态。'); }
        }
        buffer = ''; this.bufferedBytes = 0; dropping = false; offset = newline + 1;
      }
    };
    try {
      const result = await this.streams.exec(['docker', ...this.argv].map(shellQuoteArg).join(' '), {
        signal: ac.signal, timeout: 0, onData: async (chunk, channel) => {
          const consuming = consume(chunk, channel); this.consuming = consuming;
          try { await consuming; } finally { if (this.consuming === consuming) this.consuming = undefined; }
        },
      });
      if (!ac.signal.aborted) this.warn(`Docker事件流已结束（${result.exitCode}），将重新连接。`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!ac.signal.aborted || code === 'cleanup') this.warn('Docker事件流暂不可用，将重新连接；占用状态尚未确认。');
      if (code === 'cleanup') throw error;
    } finally {
      // stop后不能留下迟到诊断在状态保存之后继续写入。
      await this.consuming?.catch(() => {});
      this.bufferedBytes = 0;
    }
  }
}
