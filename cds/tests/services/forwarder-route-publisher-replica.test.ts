/**
 * ForwarderRoutePublisher 复制集路由契约测试 — design.cds.replica-set
 *
 * 验证:
 *   1. 复制集 profile 的主入口路由展开成组（primary + running 成员,replicaGroup 标记）
 *   2. 成员获得直达子域 `<previewSlug>-<memberId>.<root>`,整套路由仅该 profile 钉到成员端口
 *   3. 非 running / 无端口成员不进路由表
 *   4. 未启用复制集的分支输出与存量逐字节兼容（无 replicaGroup 字段）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ForwarderRoutePublisher } from '../../src/services/forwarder-route-publisher.js';
import { computePreviewSlug } from '../../src/services/preview-slug.js';
import type { RouteRecord } from '../../src/forwarder/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

let tmpDir: string;
let stateFile: string;
let outFile: string;
let state: StateService;
let publisher: ForwarderRoutePublisher | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fwd-pub-rs-'));
  stateFile = path.join(tmpDir, 'state.json');
  outFile = path.join(tmpDir, 'forwarder-routes.json');
  state = new StateService(stateFile);
});

afterEach(async () => {
  await flushAllJsonStateStores();
  publisher?.stop();
  publisher = null;
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup(replicaSets?: unknown): { host: string; slug: string } {
  state.addProject({
    id: 'proj',
    slug: 'demo',
    name: 'demo',
    createdAt: new Date().toISOString(),
  } as Parameters<typeof state.addProject>[0]);
  state.addBranch({
    id: 'proj-main',
    projectId: 'proj',
    branch: 'main',
    worktreePath: path.join(tmpDir, 'main'),
    services: {
      web: { profileId: 'web', containerName: 'c-web', hostPort: 9100, status: 'running' },
      api: { profileId: 'api', containerName: 'c-api', hostPort: 9200, status: 'running' },
    },
    status: 'running',
    createdAt: new Date().toISOString(),
    ...(replicaSets ? { replicaSets } : {}),
  } as Parameters<typeof state.addBranch>[0]);
  publisher = new ForwarderRoutePublisher({
    state,
    outputPath: outFile,
    rootDomains: ['miduo.org'],
  });
  publisher.publishNow();
  const slug = computePreviewSlug('main', 'demo');
  return { host: `${slug}.miduo.org`, slug };
}

function readRoutes(): RouteRecord[] {
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as RouteRecord[];
}

describe('ForwarderRoutePublisher — 复制集路由', () => {
  it('未启用复制集时输出无 replicaGroup 字段（存量兼容）', () => {
    setup();
    const routes = readRoutes();
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.replicaGroup === undefined)).toBe(true);
  });

  it('running 成员展开为组路由 + 直达子域', () => {
    const { host, slug } = setup({
      api: {
        profileId: 'api',
        enabled: true,
        primaryWeight: 80,
        members: [
          { id: 'rsaaaaaa', versionId: 'dv_1', weight: 20, image: 'img@sha256:x', status: 'running', hostPort: 9300, dbMode: 'shared', createdAt: new Date().toISOString() },
          { id: 'rsbbbbbb', versionId: 'dv_2', weight: 0, image: 'img@sha256:y', status: 'provisioning', dbMode: 'shared', createdAt: new Date().toISOString() },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const routes = readRoutes();

    // 主入口 /api/ 前缀:primary + running 成员成组
    const apiGroup = routes.filter((r) => r.host === host && r.pathPrefix === '/api/');
    expect(apiGroup).toHaveLength(2);
    const primary = apiGroup.find((r) => r.replicaMemberId === 'primary');
    const member = apiGroup.find((r) => r.replicaMemberId === 'rsaaaaaa');
    expect(primary?.upstreamPort).toBe(9200);
    expect(primary?.weight).toBe(80);
    expect(member?.upstreamPort).toBe(9300);
    expect(member?.weight).toBe(20);
    expect(primary?.replicaGroup).toBe('proj-main:api');
    expect(primary?.replicaGroup).toBe(member?.replicaGroup);

    // provisioning 成员（无 running/端口）不进路由表
    expect(routes.some((r) => r.replicaMemberId === 'rsbbbbbb')).toBe(false);

    // web 默认路由不受影响、不带组
    const webDefault = routes.find((r) => r.host === host && !r.pathPrefix);
    expect(webDefault?.upstreamPort).toBe(9100);
    expect(webDefault?.replicaGroup).toBeUndefined();

    // 成员直达子域:整套路由,api 钉到成员端口,web 仍走主容器
    const memberHost = `${slug}-api-rsaaaaaa.miduo.org`;
    const direct = routes.filter((r) => r.host === memberHost);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.find((r) => r.pathPrefix === '/api/')?.upstreamPort).toBe(9300);
    expect(direct.find((r) => !r.pathPrefix)?.upstreamPort).toBe(9100);
    expect(direct.every((r) => r.replicaGroup === undefined)).toBe(true);
  });

  it('两个 profile 各有同名成员 id:直达子域带 profile 段互不撞 host（Codex P1）', () => {
    const member = (): object => ({
      id: 'res-1', versionId: 'dv_1', weight: 0, image: 'img@sha256:x',
      status: 'running', hostPort: 0, dbMode: 'shared', createdAt: new Date().toISOString(),
    });
    const { slug } = setup({
      api: { profileId: 'api', enabled: true, primaryWeight: 100, members: [{ ...member(), hostPort: 9300 }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      web: { profileId: 'web', enabled: true, primaryWeight: 100, members: [{ ...member(), hostPort: 9400 }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    });
    const routes = readRoutes();
    const apiDirect = routes.filter((r) => r.host === `${slug}-api-res-1.miduo.org`);
    const webDirect = routes.filter((r) => r.host === `${slug}-web-res-1.miduo.org`);
    expect(apiDirect.length).toBeGreaterThan(0);
    expect(webDirect.length).toBeGreaterThan(0);
    // 各自把**自己的** profile 钉到自己成员的端口
    expect(apiDirect.find((r) => r.pathPrefix === '/api/')?.upstreamPort).toBe(9300);
    expect(webDirect.find((r) => !r.pathPrefix)?.upstreamPort).toBe(9400);
    // 旧格式（不带 profile 段）的撞车 host 不再出现
    expect(routes.some((r) => r.host === `${slug}-res-1.miduo.org`)).toBe(false);
  });

  it('主容器不可路由（error）但成员 running:仍发成员路由与直达子域,不发 primary 记录（Codex P1）', () => {
    // 单服务分支 + 主容器 error:修复前 routableServices 为空,整个分支 host 蒸发
    state.addProject({
      id: 'proj',
      slug: 'demo',
      name: 'demo',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof state.addProject>[0]);
    state.addBranch({
      id: 'proj-main',
      projectId: 'proj',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'main'),
      services: {
        api: { profileId: 'api', containerName: 'c-api', hostPort: 9200, status: 'error' },
      },
      status: 'error',
      createdAt: new Date().toISOString(),
      replicaSets: {
        api: {
          profileId: 'api',
          enabled: true,
          primaryWeight: 80,
          members: [
            { id: 'rsaaaaaa', versionId: 'dv_1', weight: 20, image: 'img@sha256:x', status: 'running', hostPort: 9300, dbMode: 'shared', createdAt: new Date().toISOString() },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    } as Parameters<typeof state.addBranch>[0]);
    publisher = new ForwarderRoutePublisher({
      state,
      outputPath: outFile,
      rootDomains: ['miduo.org'],
    });
    publisher.publishNow();
    const slug = computePreviewSlug('main', 'demo');
    const host = `${slug}.miduo.org`;
    const routes = readRoutes();

    // 分支 host 未蒸发:默认路由/前缀路由都以成员身份发出
    const hostRoutes = routes.filter((r) => r.host === host);
    expect(hostRoutes.length).toBeGreaterThan(0);
    // 不发 primary 记录（主容器 error 不可作上游）
    expect(hostRoutes.some((r) => r.replicaMemberId === 'primary')).toBe(false);
    // 成员路由在组内、上游钉到成员端口
    const memberRoute = hostRoutes.find((r) => r.replicaMemberId === 'rsaaaaaa');
    expect(memberRoute?.upstreamPort).toBe(9300);
    expect(memberRoute?.replicaGroup).toBe('proj-main:api');
    // 没有任何路由把上游指到已挂的主容器端口
    expect(hostRoutes.some((r) => r.upstreamPort === 9200)).toBe(false);
    // 成员直达子域仍在
    const direct = routes.filter((r) => r.host === `${slug}-api-rsaaaaaa.miduo.org`);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.every((r) => r.upstreamPort === 9300)).toBe(true);
  });
});
