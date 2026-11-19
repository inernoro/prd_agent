// The B prototype packs neighbouring cards around the selected anchor in document flow.
export const railMotion = { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' };

type RailAnchor = { id: string; n: number; top: number; left: number };
type RailCard = { x: number; top: number; bottom: number; width: number };
type Viewport = { top: number; bottom: number };
type Overflow = { above: number; below: number };
type ScrollRange = { top: number; max: number };

const gap = 12, pad = 12, linkInset = 14;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function layoutCards({ anchors, heights, selectedId, viewport, railLeft }: {
  anchors: RailAnchor[];
  heights: Readonly<Record<string, number>>;
  selectedId: string | null;
  viewport: Viewport;
  railLeft: number;
}) {
  const flow = anchors.filter(anchor => Number.isFinite(anchor.top) && heights[anchor.id] != null)
    .map(a => ({ a, id: a.id, h: Math.max(0, heights[a.id]), want: a.top }))
    .sort((p, q) => p.a.top - q.a.top || p.a.left - q.a.left || p.a.n - q.a.n);
  const pos = new Map<string, number>();
  const selected = flow.findIndex(item => item.id === selectedId);
  let prev = -Infinity;
  if (selected >= 0) {
    const item = flow[selected];
    const top = item.want;
    pos.set(item.id, top);
    prev = top + item.h;
    let next = top;
    for (let i = selected - 1; i >= 0; i--) {
      const before = flow[i];
      next = Math.min(before.want, next - gap - before.h);
      pos.set(before.id, next);
    }
  }
  for (let i = selected + 1; i < flow.length; i++) {
    const item = flow[i];
    const top = Math.max(item.want, prev + gap);
    pos.set(item.id, top);
    prev = top + item.h;
  }
  const cards = flow.map(item => {
    const top = pos.get(item.id)!;
    return { id: item.id, x: railLeft, top, bottom: top + item.h };
  });
  const first = cards[0], last = cards.at(-1);
  const overflow = {
    above: first ? Math.max(0, viewport.top + pad - first.top) : 0,
    below: last ? Math.max(0, last.bottom + pad - viewport.bottom) : 0,
  };
  return { cards, overflow };
}

export function connectCard(anchor: { pinX: number; pinY: number }, card: RailCard, detached: boolean) {
  const { pinX, pinY } = anchor;
  const inset = Math.min(linkInset, (card.bottom - card.top) / 2);
  const y = clamp(pinY, card.top + inset, card.bottom - inset);
  // A card in the rail always connects at its left side. Reserve the overlap
  // decisions for detached cards so a narrow gutter cannot switch the side.
  if (!detached || card.x >= pinX + 8) return { x: card.x, y, side: 'left' } as const;
  if (card.x + card.width <= pinX - 8) return { x: card.x + card.width, y, side: 'right' } as const;
  const x = clamp(pinX, card.x + 16, card.x + card.width - 16);
  return pinY <= card.top ? { x, y: card.top, side: 'top' } as const : { x, y: card.bottom, side: 'bottom' } as const;
}

// The host keeps the browser's native scrolling inside a reply or textarea.
// Once that region is exhausted, V4 hands the wheel from rail to body to rail.
export function routeWheel(dy: number, body: ScrollRange, shift: number, overflow: Overflow) {
  let rest = dy;
  let railDelta = 0;
  if (shift > 0 && rest < 0) railDelta = Math.max(rest, -shift);
  if (shift < 0 && rest > 0) railDelta = Math.min(rest, -shift);
  rest -= railDelta;
  const bodyDelta = clamp(body.top + rest, 0, Math.max(0, body.max)) - body.top;
  rest -= bodyDelta;
  const reset = shift + railDelta;
  return { bodyDelta, railTop: clamp(reset + rest, -overflow.above, overflow.below) };
}
