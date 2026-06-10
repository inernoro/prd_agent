import { EventEmitter } from 'node:events';
import type { ReleaseLogEntry, ReleaseRun } from '../types.js';

export type ReleaseEventEnvelope =
  | { type: 'release.log'; payload: { releaseId: string; log: ReleaseLogEntry } }
  | { type: 'release.status'; payload: { releaseId: string; run: ReleaseRun } };

class ReleaseEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  emitEvent(envelope: ReleaseEventEnvelope): ReleaseEventEnvelope {
    try {
      this.emit(envelope.type, envelope.payload);
      this.emit('any', envelope);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[release-events] listener threw:', (err as Error).message);
    }
    return envelope;
  }
}

export const releaseEvents = new ReleaseEventBus();
