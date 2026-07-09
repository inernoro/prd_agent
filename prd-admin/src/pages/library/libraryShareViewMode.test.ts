import { describe, expect, it } from 'vitest';
import { parseLibraryShareViewMode, withLibraryShareViewMode } from './libraryShareViewMode';

describe('libraryShareViewMode', () => {
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
});
