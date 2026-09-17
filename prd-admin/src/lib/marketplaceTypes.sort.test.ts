import { describe, expect, it } from 'vitest';
import { sortMarketplaceItems, type MixedMarketplaceItem } from './marketplaceTypes';

const item = (
  id: string,
  createdAt: string,
  updatedAt?: string,
  forkCount = 0,
): MixedMarketplaceItem => ({
  type: 'skill',
  data: {
    id,
    createdAt,
    updatedAt,
    forkCount,
    ownerUserId: 'owner',
    ownerUserName: '作者',
  },
});

describe('sortMarketplaceItems', () => {
  it('sorts newest by the latest real update and falls back to creation time', () => {
    const recentlyUpdated = item(
      'recently-updated',
      '2026-04-01T00:00:00Z',
      '2026-09-17T00:00:00Z',
    );
    const newlyCreated = item('newly-created', '2026-09-16T00:00:00Z');

    expect(sortMarketplaceItems([newlyCreated, recentlyUpdated], 'new').map((x) => x.data.id))
      .toEqual(['recently-updated', 'newly-created']);
  });

  it('keeps hot sorting based on download count', () => {
    const olderPopular = item('popular', '2026-01-01T00:00:00Z', undefined, 10);
    const newerQuiet = item('quiet', '2026-09-17T00:00:00Z', undefined, 1);

    expect(sortMarketplaceItems([newerQuiet, olderPopular], 'hot').map((x) => x.data.id))
      .toEqual(['popular', 'quiet']);
  });
});
