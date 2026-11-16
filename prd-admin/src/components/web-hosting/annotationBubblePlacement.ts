import type { AnnotationRect } from './useHostedAnnotations';

const overlap = (a: AnnotationRect, b: AnnotationRect) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Prefer whitespace around the target; never let a preview cover its own anchor or leave the canvas. */
export function placeAnnotationBubble(anchor: AnnotationRect, size: { width: number; height: number }, viewport: { width: number; height: number }, obstacles: AnnotationRect[]) {
  const gap = 14, edge = 10;
  if (size.width > viewport.width - edge * 2 || size.height > viewport.height - edge * 2) return null;
  const candidates = [
    { side: 'top', left: anchor.left + anchor.width - size.width, top: anchor.top - size.height - gap },
    { side: 'right', left: anchor.left + anchor.width + gap, top: anchor.top + (anchor.height - size.height) / 2 },
    { side: 'left', left: anchor.left - size.width - gap, top: anchor.top + (anchor.height - size.height) / 2 },
    { side: 'bottom', left: anchor.left + anchor.width - size.width, top: anchor.top + anchor.height + gap },
  ].map((candidate, index) => {
    const rect = { ...candidate, left: clamp(candidate.left, edge, viewport.width - size.width - edge),
      top: clamp(candidate.top, edge, viewport.height - size.height - edge), ...size };
    return { ...rect, score: obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) + index * 8 };
  }).filter(candidate => overlap(candidate, anchor) === 0);
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best) return null;
  return { left: best.left, top: best.top, side: best.side,
    tailX: clamp(anchor.left + anchor.width / 2 - best.left, 18, size.width - 18),
    tailY: clamp(anchor.top + anchor.height / 2 - best.top, 18, size.height - 18) };
}
