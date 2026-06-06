import { describe, expect, it } from 'vitest';
import {
  DIALECT_LABEL,
  SQL_SNIPPET_GROUPS,
  SQL_SNIPPET_TOTAL,
} from '../sqlSnippetsData';

describe('sqlSnippetsData', () => {
  it('has at least one group with at least one snippet', () => {
    expect(SQL_SNIPPET_GROUPS.length).toBeGreaterThan(0);
    expect(SQL_SNIPPET_TOTAL).toBeGreaterThan(0);
  });

  it('group ids are unique', () => {
    const ids = SQL_SNIPPET_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('snippet ids are unique across all groups', () => {
    const ids = SQL_SNIPPET_GROUPS.flatMap((g) => g.snippets.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every snippet has non-empty title and sql, and a known dialect', () => {
    for (const g of SQL_SNIPPET_GROUPS) {
      for (const s of g.snippets) {
        expect(s.title.trim()).not.toBe('');
        expect(s.sql.trim()).not.toBe('');
        expect(DIALECT_LABEL[s.dialect]).toBeDefined();
      }
    }
  });

  it('SQL_SNIPPET_TOTAL equals sum of all snippets', () => {
    const sum = SQL_SNIPPET_GROUPS.reduce((acc, g) => acc + g.snippets.length, 0);
    expect(SQL_SNIPPET_TOTAL).toBe(sum);
  });
});
