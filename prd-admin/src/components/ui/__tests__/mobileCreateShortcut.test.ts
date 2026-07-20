import { describe, expect, it } from 'vitest';
import {
  isQuickRecordDoubleActivation,
  QUICK_RECORD_DOUBLE_ACTIVATION_MS,
} from '../mobileCreateShortcut';

describe('mobile create shortcut', () => {
  it('recognizes a second activation inside the shortcut window', () => {
    expect(isQuickRecordDoubleActivation(1000, 1000 + QUICK_RECORD_DOUBLE_ACTIVATION_MS)).toBe(true);
  });

  it('keeps a single or slow activation on the normal create menu path', () => {
    expect(isQuickRecordDoubleActivation(null, 1000)).toBe(false);
    expect(isQuickRecordDoubleActivation(1000, 1001 + QUICK_RECORD_DOUBLE_ACTIVATION_MS)).toBe(false);
  });

  it('rejects non-forward timestamps', () => {
    expect(isQuickRecordDoubleActivation(1000, 1000)).toBe(false);
    expect(isQuickRecordDoubleActivation(1000, 999)).toBe(false);
  });
});
