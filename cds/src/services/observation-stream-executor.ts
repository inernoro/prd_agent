import { IsolatedShellExecutor, ObservationExecutionError } from './isolated-shell-executor.js';
import { ShellExecutor } from './shell-executor.js';
import type { ExecOptions, ExecResult } from '../types.js';

/** 独立于健康查询的流式执行槽。容量满时不排队，也不回退Master创建进程。 */
export class ObservationStreamExecutor {
  private readonly shell: IsolatedShellExecutor;
  private admitted = 0;
  private closed = false;
  constructor(private readonly concurrency = 8) {
    this.shell = new IsolatedShellExecutor(new ShellExecutor(), { concurrency, maxQueued: 1 });
  }
  start(): Promise<void> { return this.shell.start(); }
  async exec(command: string, options: Pick<ExecOptions, 'onData' | 'signal' | 'timeout' | 'cwd' | 'env'>): Promise<ExecResult> {
    if (this.closed) throw new ObservationExecutionError('closed');
    if (this.admitted >= this.concurrency) throw new ObservationExecutionError('capacity');
    if (!options.onData) throw new ObservationExecutionError('callback');
    this.admitted++;
    try { return await this.shell.exec(command, { ...options, captureOutput: false, executionLane: 'observation' }); }
    finally { this.admitted--; }
  }
  getStats(): ReturnType<IsolatedShellExecutor['getStats']> & { admitted: number } {
    return { ...this.shell.getStats(), admitted: this.admitted };
  }
  close(): Promise<void> { this.closed = true; return this.shell.close(); }
}
