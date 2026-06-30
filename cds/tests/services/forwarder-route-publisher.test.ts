/**
 * ForwarderRoutePublisher 契约测试 (B'.2-forwarder MVP, 2026-05-08)
 *
 * 对应 doc/report.cds.forwarder-success.md
 * 验证:
 *   1. running 分支 → 路由记录(host = preview slug + 别名)
 *   2. building / starting 分支有端口时仍保留 preview host 路由
 *   3. 同样输入再发布一次不重复写盘(节省 IO + 减少 fs.watch 风暴)
 *   4. 原子写:tmp + rename(读到永远是完整 JSON)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ForwarderRoutePublisher } from '../../src/services/forwarder-route-publisher.js';
import { computePreviewSlug } from '../../src/services/preview-slug.js';

let tmpDir: string;
let stateFile: string;
let outFile: string;
let state: StateService;
let publisher: ForwarderRoutePublisher | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fwd-pub-'));
  stateFile = path.join(tmpDir, 'state.json');
  outFile = path.join(tmpDir, 'forwarder-routes.json');
  state = new StateService(stateFile);
});

afterEach(() => {
  publisher?.stop();
  publisher = null;
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ensureProject(id: string, slug: string) {
  state.addProject({
    id,
    slug,
    name: slug,
    createdAt: new Date().toISOString(),
  } as Parameters<typeof state.addProject>[0]);
}

function addRunningBranch(opts: {
  projectId: string;
  branch: string;
  hostPort: number;
  aliases?: string[];
  /** profile id,默认 'web'(命中 default profile 启发式) */
  profileId?: string;
}) {
  const profileId = opts.profileId ?? 'web';
  state.addBranch({
    id: `${opts.projectId}-${opts.branch}`,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: path.join(tmpDir, opts.branch),
    services: {
      [profileId]: {
        profileId,
        containerName: `c-${opts.branch}`,
        hostPort: opts.hostPort,
        status: 'running',
      },
    },
    status: 'running',
    createdAt: new Date().toISOString(),
    subdomainAliases: opts.aliases,
  } as Parameters<typeof state.addBranch>[0]);
}

function addMultiProfileBranch(opts: {
  projectId: string;
  branch: string;
  services: Record<string, number>;
}) {
  const services: Record<string, { profileId: string; containerName: string; hostPort: number; status: string }> = {};
  for (const [profileId, hostPort] of Object.entries(opts.services)) {
    services[profileId] = {
      profileId,
      containerName: `c-${opts.branch}-${profileId}`,
      hostPort,
      status: 'running',
    };
  }
  state.addBranch({
    id: `${opts.projectId}-${opts.branch}`,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: path.join(tmpDir, opts.branch),
    services,
    status: 'running',
    createdAt: new Date().toISOString(),
  } as Parameters<typeof state.addBranch>[0]);
}

describe('ForwarderRoutePublisher', () => {
  it('单 profile 分支生成 1 条默认路由(无 pathPrefix → 接所有路径)', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000, profileId: 'web' });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    const wrote = publisher.publishNow();
    expect(wrote).toBe(true);
    expect(fs.existsSync(outFile)).toBe(true);

    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    const expectedHost = `${computePreviewSlug('main', 'demo')}.miduo.org`;
    expect(data[0].host).toBe(expectedHost);
    expect(data[0].upstreamPort).toBe(41000);
    expect(data[0].upstreamHost).toBe('127.0.0.1');
    expect(data[0].weight).toBe(100);
    expect(data[0].pathPrefix).toBeUndefined();
  });

  it('多 profile (admin + api) → /api/* 走 api,默认走 admin(对齐 master detectProfileFromRequest)', () => {
    ensureProject('demo', 'demo');
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { admin: 41100, api: 41101 },
    });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const expectedHost = `${computePreviewSlug('main', 'demo')}.miduo.org`;

    // 应该有 2 条:/api/* → api,默认 → admin
    expect(data).toHaveLength(2);
    const apiRoute = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/api/');
    expect(apiRoute).toBeDefined();
    expect(apiRoute.host).toBe(expectedHost);
    expect(apiRoute.upstreamPort).toBe(41101);

    const defaultRoute = data.find((r: { pathPrefix?: string }) => !r.pathPrefix);
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute.host).toBe(expectedHost);
    expect(defaultRoute.upstreamPort).toBe(41100);
  });

  it('BuildProfile.pathPrefixes 配置驱动 → 显式 prefix 优先于 convention', () => {
    ensureProject('demo', 'demo');
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { admin: 41100, api: 41101 },
    });
    state.addBuildProfile({
      id: 'api',
      name: 'api',
      pathPrefixes: ['/v2/'],
    } as Parameters<typeof state.addBuildProfile>[0]);

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    const v2Route = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/v2/');
    expect(v2Route).toBeDefined();
    expect(v2Route.upstreamPort).toBe(41101);

    // /api/* convention 仍生效(BuildProfile 没显式配 /api/,只配了 /v2/)
    const apiRoute = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/api/');
    expect(apiRoute).toBeDefined();
    expect(apiRoute.upstreamPort).toBe(41101);

    const defaultRoute = data.find((r: { pathPrefix?: string }) => !r.pathPrefix);
    expect(defaultRoute.upstreamPort).toBe(41100);
  });

  it('分支级额外服务的 pathPrefixes 也发布到 forwarder（Codex P2「Publish extra-service path prefixes to the forwarder」）', () => {
    ensureProject('demo', 'demo');
    // 分支有一个项目 web 服务 + 一个分支级额外服务 extra-api（仅存在于 branch.extraProfiles，不是项目 profile）。
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { web: 41200, 'extra-api': 41201 },
    });
    state.addBuildProfile({ id: 'web', name: 'web', projectId: 'demo' } as Parameters<typeof state.addBuildProfile>[0]);
    // extra-api 只在分支额外服务里声明 pathPrefixes ['/api/']，不进项目 profiles。
    state.setBranchExtraProfiles('demo-main', [
      { id: 'extra-api', name: 'extra-api', dockerImage: 'nginx:alpine', workDir: '', command: '', containerPort: 8080, projectId: 'demo', pathPrefixes: ['/api/'] } as any,
    ]);

    publisher = new ForwarderRoutePublisher({ state, outputPath: outFile, rootDomains: ['miduo.org'] });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    // /api/* 必须路由到额外服务端口（此前因只取项目 profiles，分支级 prefix 发不出来）。
    const apiRoute = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/api/');
    expect(apiRoute).toBeDefined();
    expect(apiRoute.upstreamPort).toBe(41201);
  });

  it('声明 subdomain 的服务获得命名 host 路由 `<slug>-<sub>.<root>`（根路径直达容器，无 pathPrefix）', () => {
    ensureProject('demo', 'demo');
    // web 主应用 + 分支级额外服务 llmgw（声明 subdomain=llmgw）。
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { web: 41400, llmgw: 41401 },
    });
    state.addBuildProfile({ id: 'web', name: 'web', projectId: 'demo' } as Parameters<typeof state.addBuildProfile>[0]);
    state.setBranchExtraProfiles('demo-main', [
      { id: 'llmgw', name: 'llmgw', dockerImage: 'nginx:alpine', workDir: '', command: '', containerPort: 8091, projectId: 'demo', subdomain: 'llmgw' } as any,
    ]);

    publisher = new ForwarderRoutePublisher({ state, outputPath: outFile, rootDomains: ['miduo.org'] });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    const slug = computePreviewSlug('main', 'demo');
    // 命名 host：单标签 `<slug>-llmgw.miduo.org` → llmgw 容器端口，根路径（无 pathPrefix）。
    const namedRoute = data.find((r: { host?: string }) => r.host === `${slug}-llmgw.miduo.org`);
    expect(namedRoute).toBeDefined();
    expect(namedRoute.upstreamPort).toBe(41401);
    expect(namedRoute.pathPrefix).toBeUndefined();
    // 主应用域名路由仍在（命名 host 是「额外」的，不取代默认入口）。
    const mainDefault = data.find(
      (r: { host?: string; pathPrefix?: string }) => r.host === `${slug}.miduo.org` && !r.pathPrefix,
    );
    expect(mainDefault).toBeDefined();
    expect(mainDefault.upstreamPort).toBe(41400);
  });

  it('命名 host 第一 DNS 标签超 63 octet 时跳过该路由（Codex P2「Guard named hosts against overlong DNS labels」），主域名路径访问不受影响', () => {
    ensureProject('demo', 'demo');
    // 构造长分支名：无 `/` → previewSlug = `<branch>-demo`。branch 取 55 字 → slug = 60 字，
    // 命名标签 `<slug>-llmgw` = 60 + 6 = 66 > 63 octet → 必须被守卫跳过。
    const longBranch = 'b'.repeat(55);
    const slug = computePreviewSlug(longBranch, 'demo');
    expect(slug.length).toBe(60);
    expect(`${slug}-llmgw`.length).toBe(66);

    addMultiProfileBranch({
      projectId: 'demo',
      branch: longBranch,
      services: { web: 41500, llmgw: 41501 },
    });
    state.addBuildProfile({ id: 'web', name: 'web', projectId: 'demo' } as Parameters<typeof state.addBuildProfile>[0]);
    state.setBranchExtraProfiles(`demo-${longBranch}`, [
      { id: 'llmgw', name: 'llmgw', dockerImage: 'nginx:alpine', workDir: '', command: '', containerPort: 8091, projectId: 'demo', subdomain: 'llmgw' } as any,
    ]);

    publisher = new ForwarderRoutePublisher({ state, outputPath: outFile, rootDomains: ['miduo.org'] });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    // 命名 host 超长 → 不发布（避免无法解析 / 通配证书不覆盖的静默失效路由）。
    const namedRoute = data.find((r: { host?: string }) => r.host === `${slug}-llmgw.miduo.org`);
    expect(namedRoute).toBeUndefined();
    // 主应用域名默认路由仍在（第一标签 = 60 字 slug ≤ 63，合法）→ 该服务退回路径访问可达。
    const mainDefault = data.find(
      (r: { host?: string; pathPrefix?: string }) => r.host === `${slug}.miduo.org` && !r.pathPrefix,
    );
    expect(mainDefault).toBeDefined();
    expect(mainDefault.upstreamPort).toBe(41500);
  });

  it('命名 host 第一 DNS 标签恰好 ≤63 octet 时正常发布（守卫边界：63 通过、64 跳过）', () => {
    ensureProject('demo', 'demo');
    // slug 取 57 字 → `<slug>-llmgw` = 57 + 6 = 63（恰好上限）→ 应发布。
    const branch57 = 'c'.repeat(52); // 52 + '-demo'(5) = 57
    const slug = computePreviewSlug(branch57, 'demo');
    expect(slug.length).toBe(57);
    expect(`${slug}-llmgw`.length).toBe(63);

    addMultiProfileBranch({
      projectId: 'demo',
      branch: branch57,
      services: { web: 41600, llmgw: 41601 },
    });
    state.addBuildProfile({ id: 'web', name: 'web', projectId: 'demo' } as Parameters<typeof state.addBuildProfile>[0]);
    state.setBranchExtraProfiles(`demo-${branch57}`, [
      { id: 'llmgw', name: 'llmgw', dockerImage: 'nginx:alpine', workDir: '', command: '', containerPort: 8091, projectId: 'demo', subdomain: 'llmgw' } as any,
    ]);

    publisher = new ForwarderRoutePublisher({ state, outputPath: outFile, rootDomains: ['miduo.org'] });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    const namedRoute = data.find((r: { host?: string }) => r.host === `${slug}-llmgw.miduo.org`);
    expect(namedRoute).toBeDefined();
    expect(namedRoute.upstreamPort).toBe(41601);
  });

  it('profileOverrides 配的 pathPrefixes 也发布到 forwarder（Codex P2「Resolve overrides before routing」mirror）', () => {
    ensureProject('demo', 'demo');
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { web: 41300, 'extra-api': 41301 },
    });
    state.addBuildProfile({ id: 'web', name: 'web', projectId: 'demo' } as Parameters<typeof state.addBuildProfile>[0]);
    // extra-api declares NO pathPrefixes itself; the prefix is supplied via a profile override (only
    // resolveEffectiveProfile merges it, not getEffectiveProfilesForBranch).
    state.setBranchExtraProfiles('demo-main', [
      { id: 'extra-api', name: 'extra-api', dockerImage: 'nginx:alpine', workDir: '', command: '', containerPort: 8080, projectId: 'demo' } as any,
    ]);
    state.setBranchProfileOverride('demo-main', 'extra-api', { pathPrefixes: ['/api/'] } as any);

    publisher = new ForwarderRoutePublisher({ state, outputPath: outFile, rootDomains: ['miduo.org'] });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    const apiRoute = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/api/');
    expect(apiRoute).toBeDefined();
    expect(apiRoute.upstreamPort).toBe(41301);
  });

  it('subdomainAliases 每个生成额外路由记录', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({
      projectId: 'demo',
      branch: 'main',
      hostPort: 41000,
      aliases: ['api', 'admin'],
    });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const hosts = data.map((r: { host: string }) => r.host).sort();
    expect(hosts).toContain('admin.miduo.org');
    expect(hosts).toContain('api.miduo.org');
    expect(hosts).toContain(`${computePreviewSlug('main', 'demo')}.miduo.org`);
    expect(data).toHaveLength(3);
  });

  it('building / starting 分支有端口时仍发布路由，避免 preview host 消失', () => {
    ensureProject('demo', 'demo');
    state.addBranch({
      id: 'demo-feat',
      projectId: 'demo',
      branch: 'feat',
      worktreePath: path.join(tmpDir, 'feat'),
      services: {
        web: { profileId: 'web', containerName: 'c-feat', hostPort: 41001, status: 'starting' },
      },
      status: 'building',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof state.addBranch>[0]);

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data).toHaveLength(1);
    expect(data[0].host).toBe(`${computePreviewSlug('feat', 'demo')}.miduo.org`);
    expect(data[0].upstreamPort).toBe(41001);
    expect(data[0].healthState).toBe('unknown');
  });

  it('error / stopped 分支没有可路由服务时仍跳过', () => {
    ensureProject('demo', 'demo');
    state.addBranch({
      id: 'demo-error',
      projectId: 'demo',
      branch: 'error',
      worktreePath: path.join(tmpDir, 'error'),
      services: {
        web: { profileId: 'web', containerName: 'c-error', hostPort: 41001, status: 'error' },
      },
      status: 'error',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof state.addBranch>[0]);
    state.addBranch({
      id: 'demo-stopped',
      projectId: 'demo',
      branch: 'stopped',
      worktreePath: path.join(tmpDir, 'stopped'),
      services: {
        web: { profileId: 'web', containerName: 'c-stopped', hostPort: 41002, status: 'stopped' },
      },
      status: 'idle',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof state.addBranch>[0]);

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data).toEqual([]);
  });

  it('默认路由优先选择 running 服务，避免被 building 服务抢走', () => {
    ensureProject('demo', 'demo');
    state.addBranch({
      id: 'demo-mixed',
      projectId: 'demo',
      branch: 'mixed',
      worktreePath: path.join(tmpDir, 'mixed'),
      services: {
        admin: { profileId: 'admin', containerName: 'c-mixed-admin', hostPort: 41001, status: 'building' },
        web: { profileId: 'web', containerName: 'c-mixed-web', hostPort: 41002, status: 'running' },
      },
      status: 'building',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof state.addBranch>[0]);

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const defaultRoute = data.find((r: { pathPrefix?: string }) => !r.pathPrefix);
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute.upstreamPort).toBe(41002);
    expect(defaultRoute.healthState).toBe('running');
  });

  it('同样输入再发布不重复写盘(unchanged hash 短路)', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000 });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    expect(publisher.publishNow()).toBe(true);
    const stat1 = fs.statSync(outFile);

    // 同样状态再发一次,不应改 mtime
    expect(publisher.publishNow()).toBe(false);
    const stat2 = fs.statSync(outFile);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it('stableSamplesRequired=2 时变更需连续出现两次才写盘,减少中间态 route reload', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000 });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
      stableSamplesRequired: 2,
    });
    expect(publisher.publishNow()).toBe(true);
    const data1 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data1[0].upstreamPort).toBe(41000);

    state.removeBranch('demo-main');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41001 });

    expect(publisher.publishNow()).toBe(false);
    const pendingData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(pendingData[0].upstreamPort).toBe(41000);

    expect(publisher.publishNow()).toBe(true);
    const data2 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data2[0].upstreamPort).toBe(41001);
  });

  it('多个根域名 → 每个分支为每个根都生成一条路由', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000 });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org', 'mycds.net'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data).toHaveLength(2);
    const hosts = data.map((r: { host: string }) => r.host).sort();
    expect(hosts).toEqual([
      `${computePreviewSlug('main', 'demo')}.miduo.org`,
      `${computePreviewSlug('main', 'demo')}.mycds.net`,
    ]);
  });

  it('Codex P1 (PR #541): port 41000 → 41001 同 length,必须重新写盘(不能误判 unchanged)', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000, profileId: 'web' });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    expect(publisher.publishNow()).toBe(true);
    const data1 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data1[0].upstreamPort).toBe(41000);

    // 模拟容器重启后端口换成 41001(同位数)
    state.removeBranch('demo-main');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41001, profileId: 'web' });

    expect(publisher.publishNow()).toBe(true); // 必须 true,不能因 length 一样跳过
    const data2 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data2[0].upstreamPort).toBe(41001);
  });

  it('Codex P2 (PR #541): 默认 fallback route 必须带 branchName(否则 / 路径 widget 不注入)', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000, profileId: 'admin' });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    // 单 profile 分支生成 1 条默认 route(无 pathPrefix)
    const defaultRoute = data.find((r: { pathPrefix?: string }) => !r.pathPrefix);
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute.branchId).toBe('demo-main');
    expect(defaultRoute.branchName).toBe('main'); // 关键:必须有 branchName 否则 widget 不注入
  });

  it('Bugbot 第 3 bug (PR #541): 跨时间点 publishNow 仍 dedup,不能因 updatedAt 时间戳让 hash 永远变(否则 fs.watch 风暴)', async () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000, profileId: 'web' });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    expect(publisher.publishNow()).toBe(true);
    // 模拟生产 2s interval:等一会儿再 publish,实际状态没变
    await new Promise((r) => setTimeout(r, 50));
    expect(publisher.publishNow()).toBe(false); // 必须 false:状态没变 → 不重写盘
    await new Promise((r) => setTimeout(r, 50));
    expect(publisher.publishNow()).toBe(false); // 再过一会儿仍 false
  });

  it("Bugbot (PR #541): pickDefaultProfile 必须严格对齐 master detectProfileFromRequest — ['api', 'reporting'] 默认选 api(profileIds[0]),不是 reporting", () => {
    ensureProject('demo', 'demo');
    addMultiProfileBranch({
      projectId: 'demo',
      branch: 'main',
      services: { api: 41100, reporting: 41101 }, // 没有 web/frontend/admin → master 走 profileIds[0] = api
    });

    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));

    // 默认 route(无 pathPrefix)应指向 api(profileIds[0]),与 master 一致
    const defaultRoute = data.find((r: { pathPrefix?: string }) => !r.pathPrefix);
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute.upstreamPort).toBe(41100); // api 的端口,不是 reporting

    // /api/ prefix route 也存在(即使 api == default profile,/api/ 显式 prefix 仍写)
    // Cursor Bugbot Medium (PR #541):删了 apiSvc !== defaultProfile guard 后必须断言这条
    const apiRoute = data.find((r: { pathPrefix?: string }) => r.pathPrefix === '/api/');
    expect(apiRoute).toBeDefined();
    expect(apiRoute.upstreamPort).toBe(41100);
  });

  it('rootDomains 为空抛错(配置错误显式失败,不静默)', () => {
    expect(
      () =>
        new ForwarderRoutePublisher({
          state,
          outputPath: outFile,
          rootDomains: [],
        }),
    ).toThrow(/rootDomains required/);
  });
});
