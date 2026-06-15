import { describe, expect, it } from 'vitest';
import { formatCompactAbsolute } from '../RelativeTime';

describe('formatCompactAbsolute', () => {
  it('uses a stable MM-DD HH:mm shape for document list rows', () => {
    const value = new Date('2026-06-13T08:07:30');

    expect(formatCompactAbsolute(value)).toBe('06-13 08:07');
  });
});
