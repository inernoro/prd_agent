import { entryAsset } from './entryAsset';
export type EntryCue = 'scan' | 'verified' | 'reveal';
type Cue = EntryCue;
/** Original local UI cues; no network service or recurring background music. */
export class EntryAudio {
  private context?: AudioContext;
  private resuming?: Promise<void>;
  private buffers = new Map<Cue, Promise<AudioBuffer | null>>();
  private sources = new Set<AudioBufferSourceNode>();
  private epoch = 0;
  private disposed = false;
  private enabled = true;
  setEnabled(enabled: boolean) { this.enabled = enabled; if (!enabled) this.stop(); }
  unlock() {
    if (this.disposed || !window.AudioContext) return;
    try {
      this.context ??= new AudioContext();
      this.resuming = this.context.resume().catch(() => {});
      for (const cue of ['scan', 'verified', 'reveal'] as const) {
        if (!this.buffers.has(cue)) {
          const context = this.context;
          this.buffers.set(cue, fetch(`${entryAsset(`${cue}.wav`)}?v=2`)
            .then(response => { if (!response.ok) throw new Error('audio unavailable'); return response.arrayBuffer(); })
            .then(bytes => context.decodeAudioData(bytes)).catch(() => null));
        }
      }
    } catch { /* Sound cannot interrupt authentication. */ }
  }
  get running() { return !this.disposed && this.context?.state === 'running'; }
  async play(cue: Cue): Promise<boolean> {
    if (!this.enabled || this.disposed) return false;
    const epoch = this.epoch;
    try {
      const buffer = await this.buffers.get(cue);
      if (buffer && this.context && !this.running && this.resuming) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.resuming, new Promise<void>(resolve => { timer = setTimeout(resolve, 1200); })]);
        } finally { clearTimeout(timer); }
      }
      // Never queue a silent suspended source and call it enabled.
      if (!this.enabled || !buffer || !this.context || !this.running || this.disposed || epoch !== this.epoch || document.visibilityState !== 'visible') return false;
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.context.destination); this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); };
      source.start();
      return true;
    } catch { return false; }
  }
  stop() {
    this.epoch += 1;
    this.sources.forEach(source => { try { source.stop(); } catch { /* already ended */ } });
    this.sources.clear();
  }
  dispose() {
    this.disposed = true; this.stop();
    void this.context?.close().catch(() => {});
  }
}
