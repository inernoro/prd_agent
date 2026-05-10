import { describe, expect, it } from 'vitest';
import { shouldShowPostUpdateSummary } from '../postUpdateSummary';

describe('shouldShowPostUpdateSummary', () => {
  it('does not show on a fresh install', () => {
    expect(shouldShowPostUpdateSummary({
      currentVersion: '1.9.0',
      lastVersion: null,
      pendingVersion: null,
      alreadySeen: false,
      hasExistingDesktopState: false,
    })).toBe(false);
  });

  it('shows after the updater installs the pending version', () => {
    expect(shouldShowPostUpdateSummary({
      currentVersion: '1.9.0',
      lastVersion: '1.8.9',
      pendingVersion: 'v1.9.0',
      alreadySeen: false,
      hasExistingDesktopState: true,
    })).toBe(true);
  });

  it('shows when a stored launch version changed', () => {
    expect(shouldShowPostUpdateSummary({
      currentVersion: '1.9.0',
      lastVersion: '1.8.9',
      pendingVersion: null,
      alreadySeen: false,
      hasExistingDesktopState: false,
    })).toBe(true);
  });

  it('shows once for existing installs that first receive this feature', () => {
    expect(shouldShowPostUpdateSummary({
      currentVersion: '1.9.0',
      lastVersion: null,
      pendingVersion: null,
      alreadySeen: false,
      hasExistingDesktopState: true,
    })).toBe(true);
  });

  it('does not show again after this version was seen', () => {
    expect(shouldShowPostUpdateSummary({
      currentVersion: '1.9.0',
      lastVersion: '1.8.9',
      pendingVersion: '1.9.0',
      alreadySeen: true,
      hasExistingDesktopState: true,
    })).toBe(false);
  });
});
