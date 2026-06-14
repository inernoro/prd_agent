import { describe, expect, it } from 'vitest';
import { truncateDisplayText, DEFAULT_CELL_TEXT_MAX } from './overviewDataTable';

describe('truncateDisplayText', () => {
  it('keeps short text unchanged', () => {
    expect(truncateDisplayText('短标题')).toEqual({ display: '短标题' });
  });

  it('truncates beyond default max chars with ellipsis and full title', () => {
    const long = 'A'.repeat(DEFAULT_CELL_TEXT_MAX + 10);
    const result = truncateDisplayText(long, DEFAULT_CELL_TEXT_MAX);
    expect(result.display).toHaveLength(DEFAULT_CELL_TEXT_MAX + 1);
    expect(result.display.endsWith('…')).toBe(true);
    expect(result.title).toBe(long);
  });

  it('collapses whitespace before counting', () => {
    const result = truncateDisplayText('  hello   world  title  ', 11);
    expect(result.display).toBe('hello world…');
    expect(result.title).toBe('hello world title');
  });
});
