import { describe, expect, it } from 'vitest';
import {
  buildOwnedDocumentStorePath,
  parseLibraryShareViewMode,
  resolveInitialSharedEntryId,
  resolveLibraryShareSortMode,
  resolveControlledSharedEntryId,
  resolveShareKnowledgeBaseReturnPath,
  resolveSharedWikilinkEntryId,
  withLibraryShareEntry,
  withLibraryShareSortMode,
  withLibraryShareViewMode,
} from './libraryShareViewMode';

describe('libraryShareViewMode', () => {
  it('returns from a share page to the same knowledge base in the authenticated workspace', () => {
    expect(buildOwnedDocumentStorePath('store-123')).toBe('/document-store?store=store-123');
    expect(buildOwnedDocumentStorePath(' store/with space ')).toBe('/document-store?store=store%2Fwith+space');
    expect(buildOwnedDocumentStorePath('  ')).toBe('/document-store');
  });

  it('fails closed for token-only share readers without owned-store access', () => {
    expect(resolveShareKnowledgeBaseReturnPath('owner-private-store', false)).toBe('/document-store');
    expect(resolveShareKnowledgeBaseReturnPath('owner-private-store', true))
      .toBe('/document-store?store=owner-private-store');
  });

  it('controls the first reader render with a valid entry deep link', () => {
    expect(resolveControlledSharedEntryId(undefined, 'chapter-22', true)).toBe('chapter-22');
  });

  it('lets browser history replace stale local selection before effects run', () => {
    expect(resolveControlledSharedEntryId('chapter-23', 'chapter-22', true)).toBe('chapter-22');
  });

  it('preserves manual selection when the URL has no entry parameter', () => {
    expect(resolveControlledSharedEntryId('chapter-23', 'readme', false)).toBe('chapter-23');
    expect(resolveControlledSharedEntryId(undefined, 'readme', false)).toBe('readme');
  });

  it('keeps graph modes as query-only views on the same share token', () => {
    const params = new URLSearchParams('entry=doc-1');
    const next = withLibraryShareViewMode(params, 'galaxy');

    expect(next.toString()).toBe('entry=doc-1&view=galaxy');
    expect(parseLibraryShareViewMode(next.get('view'), false)).toBe('galaxy');
  });

  it('does not expose whole-store graph modes for single-document shares', () => {
    expect(parseLibraryShareViewMode('galaxy', true)).toBe('read');
    expect(parseLibraryShareViewMode('universe', true)).toBe('read');
  });

  it('removes the view query for the default reader mode', () => {
    const params = new URLSearchParams('entry=doc-1&view=universe');
    const next = withLibraryShareViewMode(params, 'read');

    expect(next.toString()).toBe('entry=doc-1');
  });

  it('creates a stable chapter deep link and returns to reader mode', () => {
    const params = new URLSearchParams('view=galaxy&source=shared');
    const next = withLibraryShareEntry(params, 'chapter-23');

    expect(next.toString()).toBe('source=shared&entry=chapter-23');
  });

  it('resolves a shared wikilink by direct id or exact title', () => {
    const entries = [
      { id: 'folder-1', title: '第 23 章：导入供应商账单并对账', isFolder: true },
      { id: 'chapter-22', title: '第 22 章：看懂费用可信度' },
      { id: 'chapter-23', title: '第 23 章：导入供应商账单并对账' },
    ];

    expect(resolveSharedWikilinkEntryId(entries, { entryId: 'chapter-22' })).toBe('chapter-22');
    expect(resolveSharedWikilinkEntryId(entries, { title: ' 第 23 章：导入供应商账单并对账 ' })).toBe('chapter-23');
  });

  it('fails closed when a wikilink points outside the shared document set', () => {
    const entries = [{ id: 'chapter-22', title: '第 22 章：看懂费用可信度' }];

    expect(resolveSharedWikilinkEntryId(entries, { entryId: 'private-doc' })).toBeUndefined();
    expect(resolveSharedWikilinkEntryId(entries, { title: '不存在的章节' })).toBeUndefined();
  });

  it('defaults structured books to book order and preserves explicit reader choice', () => {
    expect(resolveLibraryShareSortMode(null, true)).toBe('default');
    expect(resolveLibraryShareSortMode(null, false)).toBe('created-desc');
    expect(resolveLibraryShareSortMode('created', true)).toBe('created-desc');

    const params = withLibraryShareSortMode(new URLSearchParams('entry=chapter-20'), 'default');
    expect(params.toString()).toBe('entry=chapter-20&sort=book');
  });

  it('opens the primary document in book mode and the newest document in temporal mode', () => {
    const entries = [
      { id: 'chapter-2', title: '第 2 章', isFolder: false, sortOrder: 102, createdAt: '2026-07-16T00:00:00Z' },
      { id: 'readme', title: '模型网关权威教程', isFolder: false, sortOrder: 0, createdAt: '2026-07-01T00:00:00Z' },
      { id: 'chapter-1', title: '第 1 章', isFolder: false, sortOrder: 101, createdAt: '2026-07-15T00:00:00Z' },
    ];

    expect(resolveInitialSharedEntryId(entries, {
      entryFromUrl: null,
      sharedEntryId: undefined,
      primaryEntryId: 'readme',
      sortMode: 'default',
    })).toBe('readme');
    expect(resolveInitialSharedEntryId(entries, {
      entryFromUrl: null,
      sharedEntryId: undefined,
      primaryEntryId: 'readme',
      sortMode: 'created-desc',
    })).toBe('chapter-2');
  });
});
