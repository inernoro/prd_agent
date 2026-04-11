import { describe, it, expect } from 'vitest';
import { parseResourceLimits } from '../../src/services/compose-parser.js';

/**
 * Tests for `parseResourceLimits` — Phase 2 cgroup limit parsing.
 *
 * The function accepts a compose service entry and returns ResourceLimits
 * (or undefined if nothing is configured). Two sources are supported:
 *   1. `x-cds-resources` (our extension, numeric)
 *   2. `deploy.resources.limits` (standard compose, string with units)
 *
 * See doc/design.cds-resilience.md Phase 2.
 */
describe('parseResourceLimits', () => {
  describe('x-cds-resources (our extension)', () => {
    it('parses numeric memoryMB + cpus', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { 'x-cds-resources': { memoryMB: 512, cpus: 1.5 } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 512, cpus: 1.5 });
    });

    it('accepts memoryMB alone', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { 'x-cds-resources': { memoryMB: 256 } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 256 });
    });

    it('accepts cpus alone', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { 'x-cds-resources': { cpus: 0.5 } };
      expect(parseResourceLimits(entry)).toEqual({ cpus: 0.5 });
    });

    it('rejects zero and negative values', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { 'x-cds-resources': { memoryMB: 0, cpus: -1 } };
      expect(parseResourceLimits(entry)).toBeUndefined();
    });

    it('floors fractional memoryMB', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { 'x-cds-resources': { memoryMB: 511.9 } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 511 });
    });
  });

  describe('deploy.resources.limits (standard compose)', () => {
    it('parses "512M" memory string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { memory: '512M' } } } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 512 });
    });

    it('parses "2G" memory string → 2048 MB', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { memory: '2G' } } } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 2048 });
    });

    it('parses "1024k" memory string → 1 MB', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { memory: '1024k' } } } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 1 });
    });

    it('parses cpus as number string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { cpus: '1.5' } } } };
      expect(parseResourceLimits(entry)).toEqual({ cpus: 1.5 });
    });

    it('combines memory + cpus', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { memory: '1G', cpus: '2' } } } };
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 1024, cpus: 2 });
    });

    it('rejects unparseable memory string', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: { resources: { limits: { memory: 'bogus' } } } };
      expect(parseResourceLimits(entry)).toBeUndefined();
    });
  });

  describe('priority + defaults', () => {
    it('x-cds-resources wins over deploy.resources.limits when both present', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = {
        'x-cds-resources': { memoryMB: 999 },
        deploy: { resources: { limits: { memory: '1G', cpus: '4' } } },
      };
      // Should return just x-cds-resources.memoryMB, not merged
      expect(parseResourceLimits(entry)).toEqual({ memoryMB: 999 });
    });

    it('returns undefined when neither source is present', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { image: 'node:20' };
      expect(parseResourceLimits(entry)).toBeUndefined();
    });

    it('returns undefined when deploy block exists but no resources', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry: any = { deploy: {} };
      expect(parseResourceLimits(entry)).toBeUndefined();
    });
  });
});
