import { describe, expect, it } from 'vitest';
import {
  CREATE_PALETTE_DOUBLE_ACTIVATION_MS,
  isCreatePaletteDoubleActivation,
} from '../createPaletteGesture';

describe('create palette gesture', () => {
  it('recognizes the second activation inside the shortcut window', () => {
    expect(isCreatePaletteDoubleActivation(1000, 1000 + CREATE_PALETTE_DOUBLE_ACTIVATION_MS)).toBe(true);
  });

  it('keeps a single or slow activation on the normal menu path', () => {
    expect(isCreatePaletteDoubleActivation(null, 1000)).toBe(false);
    expect(isCreatePaletteDoubleActivation(1000, 1001 + CREATE_PALETTE_DOUBLE_ACTIVATION_MS)).toBe(false);
  });

  it('rejects non-forward timestamps', () => {
    expect(isCreatePaletteDoubleActivation(1000, 1000)).toBe(false);
    expect(isCreatePaletteDoubleActivation(1000, 999)).toBe(false);
  });
});
