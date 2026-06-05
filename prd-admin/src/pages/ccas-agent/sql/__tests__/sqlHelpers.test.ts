import { describe, expect, it } from 'vitest';
import { dedupLines, escapeSqlSingleQuote, toInClause } from '../sqlHelpers';

describe('escapeSqlSingleQuote', () => {
  it('escapes single quotes the SQL way', () => {
    expect(escapeSqlSingleQuote("O'Brien")).toBe("O''Brien");
    expect(escapeSqlSingleQuote("a'b'c")).toBe("a''b''c");
  });
  it('leaves plain strings untouched', () => {
    expect(escapeSqlSingleQuote('abc')).toBe('abc');
    expect(escapeSqlSingleQuote('')).toBe('');
  });
});

describe('toInClause', () => {
  it('wraps each line as a quoted value joined by ", "', () => {
    const r = toInClause('1\n2\n3');
    expect(r.output).toBe("('1', '2', '3')");
    expect(r.validRows).toBe(3);
    expect(r.itemCount).toBe(3);
  });

  it('ignores empty lines and trims whitespace', () => {
    const r = toInClause('  a  \n\n  b\n   \nc');
    expect(r.output).toBe("('a', 'b', 'c')");
    expect(r.validRows).toBe(3);
  });

  it('escapes embedded single quotes', () => {
    const r = toInClause("O'Brien\nplain\na'b");
    expect(r.output).toBe("('O''Brien', 'plain', 'a''b')");
  });

  it('returns empty result for blank input', () => {
    expect(toInClause('')).toEqual({ output: '', validRows: 0, itemCount: 0 });
    expect(toInClause('\n\n   \n')).toEqual({ output: '', validRows: 0, itemCount: 0 });
  });
});

describe('dedupLines', () => {
  const opts = { keepOrder: true, ignoreCase: false, trimSpaces: true };

  it('removes exact duplicates while preserving order', () => {
    const r = dedupLines('a\nb\na\nc\nb', opts);
    expect(r.output).toBe('a\nb\nc');
    expect(r.rawRows).toBe(5);
    expect(r.uniqueRows).toBe(3);
    expect(r.duplicateCount).toBe(2);
    expect(r.removedCount).toBe(2);
  });

  it('respects ignoreCase but keeps the first-seen casing', () => {
    const r = dedupLines('Aaa\naaa\nAAA\nbbb', { ...opts, ignoreCase: true });
    expect(r.output).toBe('Aaa\nbbb');
    expect(r.duplicateCount).toBe(2);
  });

  it('respects trimSpaces=false (whitespace matters)', () => {
    const r = dedupLines('a\n a\na ', { ...opts, trimSpaces: false });
    expect(r.uniqueRows).toBe(3);
  });

  it('sorts when keepOrder=false', () => {
    const r = dedupLines('c\nb\na\nb', { ...opts, keepOrder: false });
    expect(r.output).toBe('a\nb\nc');
  });

  it('filters blank lines under trimSpaces=true', () => {
    const r = dedupLines('a\n   \n\nb', opts);
    expect(r.uniqueRows).toBe(2);
    expect(r.rawRows).toBe(2);
  });

  it('handles all-duplicate input', () => {
    const r = dedupLines('x\nx\nx\nx', opts);
    expect(r.output).toBe('x');
    expect(r.duplicateCount).toBe(3);
    expect(r.removedCount).toBe(3);
  });

  it('handles empty input', () => {
    const r = dedupLines('', opts);
    expect(r.output).toBe('');
    expect(r.uniqueRows).toBe(0);
    expect(r.rawRows).toBe(0);
    expect(r.duplicateCount).toBe(0);
  });
});
