/** A single clock drives geometry and exposure; values are seconds after scene mount. */
export const PORTRAIT_DURATION = 5.15;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export const smoothProgress = (time: number, from: number, to: number) => {
  const t = clamp((time - from) / (to - from));
  return t * t * (3 - 2 * t);
};
export function samplePortrait(time: number) {
  return {
    line: smoothProgress(time, 0, 1.45),
    lineOpacity: 1 - smoothProgress(time, 2.0, 2.85),
    grid: smoothProgress(time, .8, 1.45) * (1 - smoothProgress(time, 2.25, 3.0)),
    material: smoothProgress(time, 1.55, 2.45),
    eye: smoothProgress(time, 2.85, 4.25),
    controls: smoothProgress(time, .12, .85),
    brand: smoothProgress(time, 2.3, 3.05),
    brandFill: smoothProgress(time, 3.25, 4.3),
    chrome: smoothProgress(time, 3.85, 4.5),
    welcome: smoothProgress(time, 4.35, 5.05),
    camera: 1.018 - .018 * smoothProgress(time, 0, 4.5),
  };
}

// The renderer and geometric acceptance tests share these control points.
export const EYE_X = [1260, 1330, 1485, 1567] as const;
export const CLOSED_LID = [441, 469, 488, 443] as const;
export const OPEN_UPPER = [441, 350, 347, 443] as const;
export const OPEN_LOWER = [441, 550, 510, 443] as const;
export function eyeControlPoints(open: number) {
  const p = clamp(open);
  // The upper lid leads; the lower lid follows with a smaller, delayed excursion.
  const upperOpen = 1 - Math.pow(1 - p, 1.12);
  const lowerOpen = Math.pow(p, 1.65);
  return {
    upper: CLOSED_LID.map((value, index) => value + (OPEN_UPPER[index] - value) * upperOpen) as [number, number, number, number],
    lower: CLOSED_LID.map((value, index) => value + (OPEN_LOWER[index] - value) * lowerOpen) as [number, number, number, number],
  };
}
