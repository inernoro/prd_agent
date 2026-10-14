export interface GenerationRun {
  finished: Promise<HTMLElement>;
  cancel(): void;
  element: HTMLElement;
}
export function generate(element: HTMLElement, options?: {
  mode?: 'skeleton'; duration?: number; holdAt?: number; startAt?: number;
  onFallback?: () => void; maxParts?: number; keys?: number;
}): GenerationRun;
