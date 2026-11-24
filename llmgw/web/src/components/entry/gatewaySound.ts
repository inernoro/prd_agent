import type { EntryCue } from './entryAudio';
export const GATEWAY_SOUND_EVENT = 'gateway:entry-cue';
/** A UI cue carries no business state or authentication. */
export function playGatewayCue(cue: EntryCue) {
  window.dispatchEvent(new CustomEvent(GATEWAY_SOUND_EVENT, { detail: cue }));
}
