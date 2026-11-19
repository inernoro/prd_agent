import { describe, expect, it } from 'vitest';
import { connectCard, layoutCards, routeWheel } from './annotationRailLayout';

describe('B V4 annotation rail', () => {
  it('keeps the selected card at the anchor while neighbours yield above and below it', () => {
    const anchors = Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1), n: index + 1, top: 176, bottom: 204, left: 40,
    }));
    const heights = Object.fromEntries(anchors.map(({ id }) => [id, id === '5' ? 210 : 62]));
    const { cards, overflow } = layoutCards({ anchors, heights, selectedId: '5', viewport: { top: 0, bottom: 468 }, railLeft: 980 });
    expect(cards[4]).toMatchObject({ id: '5', top: 176 });
    expect(cards[0].top).toBeLessThan(0);
    expect(overflow.above).toBeGreaterThan(0);
    expect(overflow.below).toBeGreaterThan(0);
    expect(cards.every((card, index) => index === 0 || card.top - cards[index - 1].bottom >= 8)).toBe(true);
  });

  it('attaches at the left edge in the seven-pixel gutter measured in the 1280px demo', () => {
    const anchor = { pinX: 641, pinY: 291.06 };
    const card = { x: 648, top: 279.06, bottom: 706.06, width: 260 };
    expect(connectCard(anchor, card, false)).toEqual({ x: 648, y: 293.06, side: 'left' });
    expect(connectCard(anchor, { ...card, x: 570 }, true)).toMatchObject({ y: 706.06, side: 'bottom' });
  });

  it('returns the offset rail to the original position before scrolling the document', () => {
    const overflow = { above: 60, below: 90 };
    expect(routeWheel(-40, { top: 0, max: 200 }, 0, overflow)).toEqual({ bodyDelta: 0, railTop: -40 });
    expect(routeWheel(65, { top: 0, max: 200 }, -40, overflow)).toEqual({ bodyDelta: 25, railTop: 0 });
    expect(routeWheel(80, { top: 170, max: 200 }, 0, overflow)).toEqual({ bodyDelta: 30, railTop: 50 });
    expect(routeWheel(-60, { top: 200, max: 200 }, 50, overflow)).toEqual({ bodyDelta: -10, railTop: 0 });
  });
});
