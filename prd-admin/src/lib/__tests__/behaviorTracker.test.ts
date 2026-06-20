import { describe, expect, it } from 'vitest';
import { normalizeRoute } from '../behaviorTracker';

describe('normalizeRoute 路由归一化（与后端 NormalizePath 口径一致）', () => {
  it('数字段替换为 :id', () => {
    expect(normalizeRoute('/defect-agent/12345')).toBe('/defect-agent/:id');
  });
  it('长 hex / GUID 段替换为 :id', () => {
    expect(normalizeRoute('/visual-agent/0af1b2c3d4e5f60708090a0b0c0d0e0f')).toBe('/visual-agent/:id');
    expect(normalizeRoute('/doc/123e4567-e89b-12d3-a456-426614174000')).toBe('/doc/:id');
  });
  it('普通语义段保持原样', () => {
    expect(normalizeRoute('/team-activity')).toBe('/team-activity');
    expect(normalizeRoute('/open-platform')).toBe('/open-platform');
  });
  it('空路径归一为 /', () => {
    expect(normalizeRoute('')).toBe('/');
  });
});
