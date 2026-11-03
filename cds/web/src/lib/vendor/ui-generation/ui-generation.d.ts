export interface GenerationRun {
  finished: Promise<HTMLElement>;
  cancel(): void;
  /** Transfer this same overlay to a layout-compatible DOM node; optionally resume the native scan. */
  handoff(element: HTMLElement, options?: { reveal?: boolean }): boolean;
  element: HTMLElement;
}
export function generate(element: HTMLElement, options?: {
  mode?: 'skeleton'; duration?: number; holdAt?: number; startAt?: number; revealDuration?: number;
  onFallback?: () => void; maxParts?: number; keys?: number;
}): GenerationRun;
