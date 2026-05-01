import { describe, it, expect, vi } from 'vitest';
import { parseResourceLimits, resolveEnvTemplates } from '../../src/services/compose-parser.js';

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

/**
 * Tests for `resolveEnvTemplates` — Phase 1 fix(2026-05-01)。
 *
 * 关键 bug:cdsVars 自身含 ${VAR} 嵌套引用时,单次替换出来还是字面量。
 * 修复后通过 fixed-point iteration 把 cdsVars 先展开到稳定,再替换 env。
 */
describe('resolveEnvTemplates', () => {
  it('展开简单 ${VAR}', () => {
    const out = resolveEnvTemplates({ A: '${X}' }, { X: 'hello' });
    expect(out.A).toBe('hello');
  });

  it('支持 ${VAR:-default} 默认值', () => {
    const out = resolveEnvTemplates({ A: '${MISSING:-fallback}' }, {});
    expect(out.A).toBe('fallback');
  });

  it('未定义变量 fallback 到空字符串', () => {
    const out = resolveEnvTemplates({ A: 'x=${MISSING}!' }, {});
    expect(out.A).toBe('x=!');
  });

  it('嵌套引用 — cdsVars.MONGODB_URL 含 ${MONGO_USER},env 引用 MONGODB_URL', () => {
    const cdsVars = {
      MONGO_USER: 'root',
      MONGO_PASSWORD: 'secret!',
      MONGODB_URL: 'mongodb://${MONGO_USER}:${MONGO_PASSWORD}@host:27017',
    };
    const env = {
      DATABASE_URL: '${MONGODB_URL}',
      MongoDB__ConnectionString: '${MONGODB_URL}',
    };
    const out = resolveEnvTemplates(env, cdsVars);
    expect(out.DATABASE_URL).toBe('mongodb://root:secret!@host:27017');
    expect(out.MongoDB__ConnectionString).toBe('mongodb://root:secret!@host:27017');
  });

  it('多层嵌套 — ${A} 引用 ${B} 引用 ${C}', () => {
    const out = resolveEnvTemplates(
      { result: '${A}' },
      { A: '${B}-end', B: '${C}-mid', C: 'start' },
    );
    expect(out.result).toBe('start-mid-end');
  });

  it('cdsVars 自身被展开后 env 引用拿到的是终值', () => {
    const cdsVars = { HOST: 'db', PORT: '5432', URL: 'postgres://${HOST}:${PORT}/app' };
    const out = resolveEnvTemplates({ DB: '${URL}' }, cdsVars);
    expect(out.DB).toBe('postgres://db:5432/app');
  });

  it('循环引用不死循环(swap 类循环达到稳定点)', () => {
    // A=${B}, B=${A} → 第一次 swap 后变成 A=${A}, B=${B}(self-ref),
    // 后续替换结果不变,fixed-point 达成。值仍是 ${A} 字面量(无解),
    // 但只要不死循环 + 返回 string 就 OK。
    const out = resolveEnvTemplates(
      { result: '${A}' },
      { A: '${B}', B: '${A}' },
    );
    expect(typeof out.result).toBe('string');
  });

  it('深度循环触发上限保护 + console.warn', () => {
    // A 链路太深(8 层都没解开)→ 走 max iterations 分支并 warn。
    // 用 ${A}-${B}-${C}-${D}-${E}-${F}-${G}-${H} 各引用下一个,最后 H 引用 A,
    // 且每层引用都"扩展"原文(不立即收敛),保证迭代真的进行 8 次。
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = resolveEnvTemplates(
      { result: '${A}' },
      {
        A: 'a-${B}', B: 'b-${C}', C: 'c-${D}', D: 'd-${E}',
        E: 'e-${F}', F: 'f-${G}', G: 'g-${H}', H: 'h-${A}', // 8 层 + 回到 A
      },
    );
    expect(typeof out.result).toBe('string');
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('混合 — 已展开的值不再变,新引用照旧展开', () => {
    const out = resolveEnvTemplates(
      { plain: 'literal-value', dynamic: '${X}' },
      { X: 'expanded' },
    );
    expect(out.plain).toBe('literal-value');
    expect(out.dynamic).toBe('expanded');
  });
});
