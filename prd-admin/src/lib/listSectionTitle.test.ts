import { describe, expect, it } from 'vitest';
import { formatListSectionTitle } from './listSectionTitle';

describe('formatListSectionTitle', () => {
  it('appends count in full-width parentheses', () => {
    expect(formatListSectionTitle('产品', 12)).toBe('产品（12）');
    expect(formatListSectionTitle('需求', 0)).toBe('需求（0）');
  });
});
