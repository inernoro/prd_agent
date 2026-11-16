/** A single clock drives geometry and exposure; values are seconds after scene mount. */
export const PORTRAIT_DURATION = 7.2;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export const smoothProgress = (time: number, from: number, to: number) => {
  const t = clamp((time - from) / (to - from));
  return t * t * (3 - 2 * t);
};
export function samplePortrait(time: number) {
  return {
    line: smoothProgress(time, .18, 2.05),
    lineOpacity: 1 - smoothProgress(time, 3.1, 4.15),
    grid: smoothProgress(time, 1.55, 2.55) * (1 - smoothProgress(time, 4.0, 5.0)),
    material: smoothProgress(time, 2.25, 3.9),
    eye: smoothProgress(time, 4.45, 6.05),
    controls: smoothProgress(time, .8, 1.65),
    brand: smoothProgress(time, 4.5, 5.5),
    brandFill: smoothProgress(time, 5.7, 6.6),
    chrome: smoothProgress(time, 6.5, PORTRAIT_DURATION),
    camera: 1.018 - .018 * smoothProgress(time, .1, 6.5),
  };
}

// The renderer and geometric acceptance tests share these control points.
export const EYE_X = [1260, 1330, 1485, 1567] as const;
export const CLOSED_LID = [441, 469, 488, 443] as const;
export const OPEN_UPPER = [441, 350, 347, 443] as const;
const OPEN_LOWER = [441, 550, 510, 443] as const;
export function eyeControlPoints(open: number) {
  const p = clamp(open);
  return {
    upper: CLOSED_LID.map((value, index) => value + (OPEN_UPPER[index] - value) * p) as [number, number, number, number],
    lower: CLOSED_LID.map((value, index) => value + (OPEN_LOWER[index] - value) * p) as [number, number, number, number],
  };
}
