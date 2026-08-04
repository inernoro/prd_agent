import { describe, expect, it } from 'vitest';
import { collectSemanticLayerFrames, planSemanticLayerFrame } from '@/lib/semanticLayerFrame';

describe('semantic layer frame', () => {
  it('places layer cards near the source while preserving its aspect ratio', () => {
    const result = planSemanticLayerFrame({ x: 100, y: 200, w: 1000, h: 500 }, 4);

    expect(result.frame.x).toBeGreaterThan(1100);
    expect(result.placements).toHaveLength(4);
    expect(result.placements[0].w / result.placements[0].h).toBe(2);
    expect(new Set(result.placements.map((item) => `${item.x}:${item.y}`)).size).toBe(4);
  });

  it('rebuilds a frame from independently movable persisted layers', () => {
    const frames = collectSemanticLayerFrames([
      { key: 'source', prompt: '海报', layerGroupId: 'group-1', layerRole: 'source' },
      { key: 'layer-2', x: 500, y: 250, w: 200, h: 100, layerGroupId: 'group-1', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 2 },
      { key: 'layer-1', x: 250, y: 250, w: 200, h: 100, layerGroupId: 'group-1', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 1 },
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].sourceKey).toBe('source');
    expect(frames[0].name).toBe('海报');
    expect(frames[0].layerKeys).toEqual(['layer-1', 'layer-2']);
    expect(frames[0].w).toBeGreaterThan(450);
  });
});
