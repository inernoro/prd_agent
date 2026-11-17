import type { AnnotationRect } from './useHostedAnnotations';

const overlap = (a: AnnotationRect, b: AnnotationRect) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** Prefer whitespace. Explicitly expanded, movable cards may overlap a large anchor when no whitespace fits. */
export function placeAnnotationBubble(anchor: AnnotationRect, size: { width: number; height: number }, viewport: { width: number; height: number }, obstacles: AnnotationRect[], occupied: AnnotationRect[] = [], allowOverlap = false) {
  const gap = 14, edge = 10;
  if (size.width > viewport.width - edge * 2 || size.height > viewport.height - edge * 2) return null;
  const candidates = [
    { side: 'top', left: anchor.left + anchor.width - size.width, top: anchor.top - size.height - gap },
    { side: 'right', left: anchor.left + anchor.width + gap, top: anchor.top + (anchor.height - size.height) / 2 },
    { side: 'left', left: anchor.left - size.width - gap, top: anchor.top + (anchor.height - size.height) / 2 },
    { side: 'bottom', left: anchor.left + anchor.width - size.width, top: anchor.top + anchor.height + gap },
    ...occupied.flatMap(rect => [
      { side: 'bottom', left: rect.left, top: rect.top + rect.height + gap },
      { side: 'top', left: rect.left, top: rect.top - size.height - gap },
      { side: 'right', left: rect.left + rect.width + gap, top: rect.top },
      { side: 'left', left: rect.left - size.width - gap, top: rect.top },
    ]),
  ].map((candidate, index) => {
    const rect = { ...candidate, left: clamp(candidate.left, edge, viewport.width - size.width - edge),
      top: clamp(candidate.top, edge, viewport.height - size.height - edge), ...size };
    return { ...rect, score: overlap(rect, anchor) * 10000 + occupied.reduce((sum, obstacle) => sum + overlap(rect, obstacle) * 1000, 0)
      + obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) + index * 8 };
  }).filter(candidate => allowOverlap || overlap(candidate, anchor) === 0);
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best) return null;
  return { left: best.left, top: best.top, side: best.side,
    tailX: clamp(anchor.left + anchor.width / 2 - best.left, 18, size.width - 18),
    tailY: clamp(anchor.top + anchor.height / 2 - best.top, 18, size.height - 18) };
}
