import { describe, expect, it } from 'vitest';
import {
  parseLibraryShareViewMode,
  resolveControlledSharedEntryId,
  resolveSharedWikilinkEntryId,
  withLibraryShareEntry,
  withLibraryShareViewMode,
} from './libraryShareViewMode';

describe('libraryShareViewMode', () => {
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
});
