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
    const memberHost = `${slug}-rsaaaaaa.miduo.org`;
    const direct = routes.filter((r) => r.host === memberHost);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.find((r) => r.pathPrefix === '/api/')?.upstreamPort).toBe(9300);
    expect(direct.find((r) => !r.pathPrefix)?.upstreamPort).toBe(9100);
    expect(direct.every((r) => r.replicaGroup === undefined)).toBe(true);
  });
});
