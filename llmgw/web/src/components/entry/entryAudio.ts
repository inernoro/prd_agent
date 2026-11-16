import { entryAsset } from './entryAsset';
type Cue = 'scan' | 'verified' | 'reveal';
/** Original local UI cues; no network service or recurring background music. */
export class EntryAudio {
  private context?: AudioContext;
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
      void this.context.resume().catch(() => {});
      for (const cue of ['scan', 'verified', 'reveal'] as const) {
        if (!this.buffers.has(cue)) {
          const context = this.context;
          this.buffers.set(cue, fetch(entryAsset(`${cue}.wav`))
            .then(response => { if (!response.ok) throw new Error('audio unavailable'); return response.arrayBuffer(); })
            .then(bytes => context.decodeAudioData(bytes)).catch(() => null));
        }
      }
    } catch { /* Sound cannot interrupt authentication. */ }
  }
  play(cue: Cue) {
    if (!this.enabled) return;
    const epoch = this.epoch;
    void this.buffers.get(cue)?.then(buffer => {
      if (!this.enabled || !buffer || !this.context || this.disposed || epoch !== this.epoch || document.visibilityState !== 'visible') return;
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.context.destination); this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); };
      source.start();
    }).catch(() => {});
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
