import { useSyncExternalStore } from 'react';

let active = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
function publish(value: boolean) {
  active = value;
  document.documentElement.toggleAttribute('data-entry-arriving', value);
  listeners.forEach(listener => listener());
}
export function finishEntryArrival() {
  clearTimeout(deadline); deadline = undefined;
  if (active) publish(false);
  document.documentElement.style.removeProperty('--entry-chrome');
  document.documentElement.removeAttribute('data-entry-chrome-visible');
}
export function beginEntryArrival() {
  document.documentElement.style.setProperty('--entry-chrome', '0');
  document.documentElement.removeAttribute('data-entry-chrome-visible');
  publish(true);
  refreshEntryArrivalWatchdog();
}
export function refreshEntryArrivalWatchdog() {
  if (!active) return;
  clearTimeout(deadline);
  // If the scene disappears or stops reporting progress, release the shell.
  deadline = setTimeout(finishEntryArrival, 10000);
}
export function setEntryChrome(value: number) {
  if (!active) return;
  document.documentElement.style.setProperty('--entry-chrome', String(value));
  document.documentElement.toggleAttribute('data-entry-chrome-visible', value > .01);
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useEntryArrival() { return useSyncExternalStore(subscribe, () => active, () => false); }
