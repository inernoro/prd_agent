/** 日志归档只保存有界UTF-8尾部；截断明确可见，不保留原全文。 */
export class BoundedLogTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private total = 0;
  constructor(private readonly limit = 256 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 4) throw new Error('Invalid log tail capacity');
  }
  append(text: string): void {
    const chunk = Buffer.from(text);
    this.total += chunk.length;
    if (!chunk.length) return;
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.length + chunk.length <= 4096) this.chunks[this.chunks.length - 1] = Buffer.concat([last, chunk]);
    else this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length) {
      const first = this.chunks[0];
      const excess = this.bytes - this.limit;
      if (first.length <= excess) { this.chunks.shift(); this.bytes -= first.length; }
      else {
        let offset = excess;
        while (offset < first.length && (first[offset] & 0xc0) === 0x80) offset++;
        // copy避免小尾部slice仍引用已经裁掉的大Buffer。
        this.chunks[0] = Buffer.from(first.subarray(offset)); this.bytes -= offset;
      }
    }
  }
  text(lines?: number): string {
    let text = Buffer.concat(this.chunks, this.bytes).toString('utf8');
    if (lines) {
      const parts = text.split('\n');
      const count = parts[parts.length - 1] === '' ? lines + 1 : lines;
      text = parts.slice(-count).join('\n');
    }
    return `${this.total > this.bytes ? '[日志前部已截断，仅保留末尾记录]\n' : ''}${text}`;
  }
  getStats(): { retainedBytes: number; totalBytes: number; chunks: number } {
    return { retainedBytes: this.bytes, totalBytes: this.total, chunks: this.chunks.length };
  }
  clear(): void { this.chunks = []; this.bytes = 0; this.total = 0; }
}
