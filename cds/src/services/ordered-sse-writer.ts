interface SsePeer {
  readonly writableLength?: number;
  write(frame: string): boolean;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  destroy(): unknown;
}
const MAX_FRAMES = 64, MAX_FRAME_BYTES = 256 * 1024, MAX_BYTES = 512 * 1024;

/** Mixed observations retain FIFO order; overflow disconnects instead of dropping terminal events. */
export class OrderedSseWriter {
  private closed = false;
  private blocked = false;
  private queue: string[] = [];
  private queuedBytes = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  private readonly onClose = (): void => this.close();
  private readonly onDrain = (): void => {
    if (this.closed) return;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined; this.blocked = false;
    while (!this.closed && !this.blocked && this.queue.length) {
      const frame = this.queue.shift()!; this.queuedBytes -= Buffer.byteLength(frame);
      this.write(frame);
    }
  };

  constructor(private readonly peer: SsePeer, private readonly cleanup: () => void) {
    peer.on('drain', this.onDrain); peer.on('close', this.onClose); peer.on('error', this.onClose);
  }

  send(factory: () => string, heartbeat = false): boolean {
    if (this.closed) return false;
    if ((this.peer.writableLength || 0) + this.queuedBytes > MAX_BYTES) { this.close(true); return false; }
    if (this.blocked && heartbeat) return true;
    if (this.blocked && this.queue.length >= MAX_FRAMES) { this.close(true); return false; }
    try {
      const frame = factory(), bytes = Buffer.byteLength(frame);
      if (bytes > MAX_FRAME_BYTES || (this.peer.writableLength || 0) + this.queuedBytes + bytes > MAX_BYTES) {
        this.close(true); return false;
      }
      if (this.blocked) { this.queue.push(frame); this.queuedBytes += bytes; return true; }
      return this.write(frame);
    } catch { this.close(true); return false; }
  }

  private write(frame: string): boolean {
    if ((this.peer.writableLength || 0) + this.queuedBytes + Buffer.byteLength(frame) > MAX_BYTES) { this.close(true); return false; }
    try {
      if (!this.peer.write(frame)) {
        this.blocked = true;
        this.deadline = setTimeout(() => this.close(true), 5000); this.deadline.unref?.();
      }
      return true;
    } catch { this.close(true); return false; }
  }

  close(destroy = false): void {
    if (this.closed) return;
    this.closed = true; if (this.deadline) clearTimeout(this.deadline);
    this.queue = []; this.queuedBytes = 0;
    this.peer.off('drain', this.onDrain); this.peer.off('close', this.onClose); this.peer.off('error', this.onClose);
    try { this.cleanup(); } catch { /* Observation cleanup never fails the publisher. */ }
    finally { if (destroy) { try { this.peer.destroy(); } catch { /* Already disconnected. */ } } }
  }
}
