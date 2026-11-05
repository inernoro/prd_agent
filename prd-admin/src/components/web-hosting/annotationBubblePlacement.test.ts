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
});
