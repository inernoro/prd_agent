import { describe, expect, it } from 'vitest';
import { isRecoverableAssetLoadError } from './MobileSafeBoundary';

describe('isRecoverableAssetLoadError', () => {
  it('treats stale Vite CSS preload failures as recoverable asset errors', () => {
    const error = new Error('Unable to preload CSS for /assets/katex-CotObXpr-b74cea9d420ac55c97d992b421df6615f124ac6c.css');

    expect(isRecoverableAssetLoadError(error)).toBe(true);
  });

  it('keeps ordinary render errors on the error screen', () => {
    expect(isRecoverableAssetLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
