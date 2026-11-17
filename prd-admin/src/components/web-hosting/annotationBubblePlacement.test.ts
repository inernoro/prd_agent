import { describe, expect, it } from 'vitest';
import { placeAnnotationBubble } from './annotationBubblePlacement';

describe('chat annotation placement', () => {
  it('floats above the anchor when there is room', () => {
    const result = placeAnnotationBubble({ left: 350, top: 320, width: 100, height: 40 }, { width: 280, height: 120 }, { width: 800, height: 600 }, []);
    expect(result?.side).toBe('top');
    expect(result!.top + 120).toBeLessThan(320);
  });
  it('chooses adjacent whitespace rather than covering nearby text', () => {
    const result = placeAnnotationBubble({ left: 350, top: 330, width: 100, height: 40 }, { width: 280, height: 120 }, { width: 800, height: 600 },
      [{ left: 170, top: 196, width: 280, height: 120 }]);
    expect(result?.side).toBe('right');
  });
  it('keeps the card within a mobile viewport at the top edge', () => {
    const result = placeAnnotationBubble({ left: 8, top: 8, width: 60, height: 30 }, { width: 276, height: 110 }, { width: 390, height: 700 }, []);
    expect(result).not.toBeNull();
    expect(result!.left).toBeGreaterThanOrEqual(10);
    expect(result!.left + 276).toBeLessThanOrEqual(380);
    expect(result!.top).toBeGreaterThanOrEqual(10);
  });
  it('collapses the preview when it cannot fit without covering its target', () => {
    expect(placeAnnotationBubble({ left: 20, top: 0, width: 260, height: 150 }, { width: 280, height: 110 }, { width: 300, height: 150 }, [])).toBeNull();
  });
  it('explicitly expanded movable bubbles stay visible for an anchor covering the entire viewport', () => {
    const result = placeAnnotationBubble({ left: 0, top: 0, width: 300, height: 150 }, { width: 280, height: 110 }, { width: 300, height: 150 }, [], [], true);
    expect(result).not.toBeNull();
    expect(result!.left).toBe(10); expect(result!.top).toBeGreaterThanOrEqual(10);
  });
  it('多条同位置批注同时展开时利用横向空白，避免全部叠在同一点', () => {
    const occupied: { left: number; top: number; width: number; height: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const result = placeAnnotationBubble({ left: 100, top: 300, width: 700, height: 40 }, { width: 280, height: 120 }, { width: 900, height: 700 }, [], occupied, true)!;
      expect(result).not.toBeNull();
      expect(occupied.every(previous => result.left + 280 <= previous.left || result.left >= previous.left + previous.width || result.top + 120 <= previous.top || result.top >= previous.top + previous.height)).toBe(true);
      occupied.push({ ...result, width: 280, height: 120 });
    }
  });
});
