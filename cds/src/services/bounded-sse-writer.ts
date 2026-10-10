interface SsePeer {
  readonly writableLength?: number;
  write(frame: string): boolean;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  destroy(): unknown;
}

/** State stream: a slow peer keeps one resync bit, never an event backlog. */
export class BoundedSseWriter {
  private closed = false;
  private blocked = false;
  private needsSnapshot = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private readonly onDrain = (): void => {
    if (this.closed) return;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
    this.blocked = false;
    if (this.needsSnapshot) {
      this.needsSnapshot = false;
      this.send(this.recoverySnapshot);
    }
  };
  private readonly onClose = (): void => this.close();

  constructor(
    private readonly peer: SsePeer,
    private readonly recoverySnapshot: () => string,
    private readonly cleanup: () => void,
  ) {
    peer.on('drain', this.onDrain);
    peer.on('close', this.onClose);
    peer.on('error', this.onClose);
  }

  send(frame: () => string, heartbeat = false): boolean {
    if (this.closed) return false;
    if (this.blocked) {
      if (!heartbeat) this.needsSnapshot = true;
      return true;
    }
    try {
      if ((this.peer.writableLength || 0) > 512 * 1024) { this.close(true); return false; }
      const serialized = frame();
      if (Buffer.byteLength(serialized) > 256 * 1024) { this.close(true); return false; }
      if (!this.peer.write(serialized)) {
        this.blocked = true;
        this.deadline = setTimeout(() => this.close(true), 5000);
        this.deadline.unref?.();
      }
      return true;
    } catch {
      this.close(true);
      return false;
    }
  }

  close(destroy = false): void {
    if (this.closed) return;
    this.closed = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.peer.off('drain', this.onDrain);
    this.peer.off('close', this.onClose);
    this.peer.off('error', this.onClose);
    try { this.cleanup(); } catch { /* cleanup must not throw into the publisher */ } finally {
      if (destroy) { try { this.peer.destroy(); } catch { /* already disconnected */ } }
    }
  }
}
