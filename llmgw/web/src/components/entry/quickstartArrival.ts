import { canAccessPage } from '@/lib/access';
import type { TenantSession } from '@/lib/types';
import type { EntryAudio } from './entryAudio';

let arrivalUntil = 0;
let arrivalAudio: EntryAudio | null = null;
let arrivalPlayback: Promise<boolean> | null = null;
let soundDeadline: ReturnType<typeof setTimeout> | undefined;
const AUDIO_DEADLINE_MS = 2200;

export function gatewayLoginDestination(candidate?: string | null, tenant?: TenantSession | null) {
  if (!candidate || candidate === '/' || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/login') || /[\u0000-\u001f\u007f]/.test(candidate)) return canAccessPage(tenant, 'quickstart') ? '/quickstart' : '/';
  return candidate;
}
export const hasQuickstartArrivalAudio = () => arrivalAudio !== null;
export const waitForQuickstartArrivalSound = () => arrivalPlayback ?? Promise.resolve(false);
export function stopQuickstartArrivalSound() {
  clearTimeout(soundDeadline); soundDeadline = undefined;
  arrivalAudio?.dispose(); arrivalAudio = null;
  arrivalPlayback = null;
}
/** A one-time backdrop reveal and audio cue. Workspace controls render immediately. */
export function markQuickstartArrival(audio?: EntryAudio | null) {
  stopQuickstartArrivalSound();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { arrivalUntil = 0; return false; }
  arrivalUntil = Date.now() + 10000;
  if (audio) {
    arrivalAudio = audio;
    soundDeadline = setTimeout(stopQuickstartArrivalSound, AUDIO_DEADLINE_MS);
    arrivalPlayback = audio.play('reveal').then(started => {
      if (!started || arrivalAudio !== audio || !audio.running) return false;
      // A slow device can spend most of the first deadline just becoming available.
      clearTimeout(soundDeadline);
      soundDeadline = setTimeout(stopQuickstartArrivalSound, AUDIO_DEADLINE_MS);
      return true;
    });
  }
  return audio !== null;
}
export const hasQuickstartArrival = () => Date.now() < arrivalUntil;
export function consumeQuickstartArrival() { arrivalUntil = 0; }
