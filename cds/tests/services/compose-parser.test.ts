import { describe, it, expect, vi } from 'vitest';
import { parseResourceLimits, resolveEnvTemplates, parseCdsCompose } from '../../src/services/compose-parser.js';

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

/**
 * Bugbot regression(PR #521 第十轮 Bug 1)— 标准 docker-compose.yml 中
 * 服务仅写 `build: ./xxx` 而不写 `image:` 是非常常见的写法,parseStandardCompose
 * 之前 `if (!entry.image) continue;` 会把它们静默丢掉,导致用户带 docker-compose.yml
 * 来 import 时得到"无可识别 app service"。下列用例锁住修复后的契约。
 */
describe('parseStandardCompose — build-only services (Bugbot 第十轮 Bug 1)', () => {
  it('build: 字符串形式的服务被识别为 BuildProfile', () => {
    const yaml = `
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    const bp = cfg!.buildProfiles[0];
    expect(bp.id).toBe('backend');
    expect(bp.workDir).toBe('backend');
    // 没 image 字段,合成占位 tag(实际构建走 Dockerfile)
    expect(bp.dockerImage).toBe('cds-build-backend:latest');
    expect(bp.containerPort).toBe(3000);
  });

  it('build: 对象形式 + context 也被识别', () => {
    const yaml = `
services:
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.dev
    ports:
      - "8080:8080"
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].workDir).toBe('api');
  });

  it('build + image 都给:image 优先,workDir 取 build context', () => {
    const yaml = `
services:
  worker:
    build: ./worker
    image: my-worker:1.0
    ports:
      - "9000:9000"
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    const bp = cfg!.buildProfiles[0];
    expect(bp.dockerImage).toBe('my-worker:1.0');
    expect(bp.workDir).toBe('worker');
  });

  it('build 缺,image 也缺:整个 doc 不被识别为 CDS compose(parseCdsCompose 返回 null)', () => {
    const yaml = `
services:
  ghost:
    ports:
      - "1234:1234"
`;
    // 没任何 CDS 扩展、没 build 指令、没相对 mount → parseCdsCompose
    // 在最外层就 null,让上层 fallback 走栈扫描而不是把空配置喂给导入器。
    const cfg = parseCdsCompose(yaml);
    expect(cfg).toBeNull();
  });

  it('混合:有 build 的当 app,只有 image 的当 infra', () => {
    const yaml = `
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
  postgres:
    image: postgres:15
    ports:
      - "5432:5432"
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].id).toBe('backend');
    expect(cfg!.infraServices).toHaveLength(1);
    expect(cfg!.infraServices[0].id).toBe('postgres');
  });
});

/**
 * Bugbot regression(PR #521 第十一轮 Bug 3)— `build:` 指令带 docker
 * healthcheck 的服务是自建 infra(典型:custom-postgres 装扩展),
 * 之前 Round 10 把它误归为 app 服务。
 */
describe('parseStandardCompose — build + healthcheck = custom infra (Bugbot 第十一轮 Bug 3)', () => {
  it('build + healthcheck → infra(不进 buildProfiles)', () => {
    // 配一个 minimal app(让闸门通过),custom-postgres 走 infra 路径。
    const yaml = `
services:
  app:
    build: ./app
    ports:
      - "3000:3000"
  custom-postgres:
    build: ./custom-postgres
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 10s
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].id).toBe('app');
    expect(cfg!.infraServices).toHaveLength(1);
    expect(cfg!.infraServices[0].id).toBe('custom-postgres');
    // 自建 infra 没 image,合成占位 tag
    expect(cfg!.infraServices[0].dockerImage).toBe('cds-build-custom-postgres:latest');
  });

  it('build 没 healthcheck → 仍当 app(Round 10 行为不退化)', () => {
    const yaml = `
services:
  api:
    build: ./api
    ports:
      - "8080:8080"
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].id).toBe('api');
  });

  it('relative volume mount 永远当 app(即使有 healthcheck)', () => {
    // 应用偶尔会写 docker healthcheck(给 docker-compose 健康监测用),
    // 但只要有 source mount 就是 app —— 不被 healthcheck 反向干扰。
    const yaml = `
services:
  app:
    image: node:20
    volumes:
      - "./app:/workspace"
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].id).toBe('app');
  });

  it('混合:custom-postgres(build+healthcheck)是 infra,backend(build)是 app', () => {
    const yaml = `
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
  custom-postgres:
    build: ./custom-postgres
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD", "pg_isready"]
`;
    const cfg = parseCdsCompose(yaml);
    expect(cfg).not.toBeNull();
    expect(cfg!.buildProfiles).toHaveLength(1);
    expect(cfg!.buildProfiles[0].id).toBe('backend');
    expect(cfg!.infraServices).toHaveLength(1);
    expect(cfg!.infraServices[0].id).toBe('custom-postgres');
  });
});
