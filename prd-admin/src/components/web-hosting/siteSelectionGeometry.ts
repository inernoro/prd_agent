export type SelectionPoint = { x: number; y: number };
export type SelectionBounds = { left: number; top: number; right: number; bottom: number };

export function selectionBounds(a: SelectionPoint, b: SelectionPoint): SelectionBounds {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}
export function overlapsSelection(a: SelectionBounds, b: SelectionBounds) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
// 使用真实线段与卡片相交，快速斜向滑过时不会把外接矩形里的其他卡片也选中。
export function crossesSelection(a: SelectionPoint, b: SelectionPoint, rect: SelectionBounds) {
  let lo = 0; let hi = 1;
  for (const [start, delta, min, max] of [[a.x, b.x - a.x, rect.left, rect.right], [a.y, b.y - a.y, rect.top, rect.bottom]]) {
    if (delta === 0) { if (start < min || start > max) return false; continue; }
    const t1 = (min - start) / delta; const t2 = (max - start) / delta;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}
export function paintSelection(base: ReadonlySet<string>, ids: Iterable<string>, select: boolean) {
  const next = new Set(base);
  for (const id of ids) { if (select) next.add(id); else next.delete(id); }
  return next;
}
