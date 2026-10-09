import { describe, expect, it } from 'vitest';
import { isPublicPreviewDiscoveryEnabled } from '../../src/services/public-exposure-policy.js';

describe('测试实例公网预览发现策略', () => {
  it.each(['0', 'false', 'off', ' FALSE ', ' Off '])('显式关闭 %s 时不公开分支清单', (value) => {
    expect(isPublicPreviewDiscoveryEnabled(value)).toBe(false);
  });

  it.each(['', '1', 'true', 'on'])('未关闭 %s 时保留原有发现能力', (value) => {
    expect(isPublicPreviewDiscoveryEnabled(value)).toBe(true);
  });
});
