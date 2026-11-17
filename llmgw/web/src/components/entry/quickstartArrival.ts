import { beginEntryArrival } from './entryArrival';
import type { EntryAudio } from './entryAudio';

let arrivalUntil = 0;
let arrivalAudio: EntryAudio | null = null;
let soundDeadline: ReturnType<typeof setTimeout> | undefined;

export function gatewayLoginDestination(candidate?: string | null) {
  if (!candidate || candidate === '/' || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/login') || /[\u0000-\u001f\u007f]/.test(candidate)) return '/quickstart';
  return candidate;
}
export const hasQuickstartArrivalAudio = () => arrivalAudio !== null;
export const isQuickstartArrivalSoundRunning = () => arrivalAudio?.running === true;
export function stopQuickstartArrivalSound() {
  clearTimeout(soundDeadline); soundDeadline = undefined;
  arrivalAudio?.dispose(); arrivalAudio = null;
}
/** One visual handoff; it never delays navigation or stores an auth result. */
export function markQuickstartArrival(audio?: EntryAudio | null) {
  stopQuickstartArrivalSound();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { arrivalUntil = 0; return false; }
  arrivalUntil = Date.now() + 10000;
  beginEntryArrival();
  if (audio) {
    arrivalAudio = audio; audio.play('reveal');
    soundDeadline = setTimeout(stopQuickstartArrivalSound, 2200);
  }
  return true;
}
export const hasQuickstartArrival = () => Date.now() < arrivalUntil;
export function consumeQuickstartArrival() { arrivalUntil = 0; }

