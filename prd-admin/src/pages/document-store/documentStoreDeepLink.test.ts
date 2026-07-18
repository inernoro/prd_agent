import { describe, expect, it } from 'vitest';
import {
  parseDocumentStoreDeepLink,
  withDocumentStoreEntry,
  withoutOrphanedDocumentStoreEntry,
} from './documentStoreDeepLink';

describe('documentStoreDeepLink', () => {
  it('parses an entry only when it belongs to a store deep link', () => {
    expect(parseDocumentStoreDeepLink('?store=store-1&entry=entry-2')).toEqual({
      storeId: 'store-1',
      entryId: 'entry-2',
    });
    expect(parseDocumentStoreDeepLink('?entry=orphan')).toEqual({
      storeId: null,
      entryId: null,
    });
  });

  it('writes and clears the selected entry while preserving unrelated parameters', () => {
    expect(withDocumentStoreEntry('?tab=mine&store=old', 'store-1', 'entry-2'))
      .toBe('?tab=mine&store=store-1&entry=entry-2');
    expect(withDocumentStoreEntry('?store=store-1&entry=entry-2', 'store-1', null))
      .toBe('?store=store-1');
  });

  it('removes an entry that has no store but leaves a complete deep link intact', () => {
    expect(withoutOrphanedDocumentStoreEntry('?entry=entry-2&tab=mine')).toBe('?tab=mine');
    expect(withoutOrphanedDocumentStoreEntry('?store=store-1&entry=entry-2'))
      .toBe('?store=store-1&entry=entry-2');
  });
});
