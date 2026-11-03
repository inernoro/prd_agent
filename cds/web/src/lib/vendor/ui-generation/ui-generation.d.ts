export interface GenerationRun {
  finished: Promise<HTMLElement>;
  cancel(): void;
  /** Retain the overlay; real content is remeasured at its final position before scanning. */
  handoff(element: HTMLElement, options?: { reveal?: boolean; revealDelay?: number }): boolean;
  element: HTMLElement;
}
export function generate(element: HTMLElement, options?: {
  mode?: 'skeleton'; duration?: number; holdAt?: number; startAt?: number; revealDuration?: number;
  delay?: number; revealOnly?: boolean; revealDelay?: number;
  onFallback?: () => void; maxParts?: number; keys?: number;
}): GenerationRun;
