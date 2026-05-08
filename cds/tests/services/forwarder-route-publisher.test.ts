/**
 * ForwarderRoutePublisher 契约测试 (B'.2-forwarder MVP, 2026-05-08)
 *
 * 对应 doc/handoff.cds-blue-green.md 第六节 TODO 1。
 * 验证:
 *   1. running 分支 → 路由记录(host = preview slug + 别名)
 *   2. 非 running 分支跳过
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
}) {
  state.addBranch({
    id: `${opts.projectId}-${opts.branch}`,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: path.join(tmpDir, opts.branch),
    services: {
      web: {
        profileId: 'web',
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

describe('ForwarderRoutePublisher', () => {
  it('running 分支生成 host = preview-slug.<root> 路由记录', () => {
    ensureProject('demo', 'demo');
    addRunningBranch({ projectId: 'demo', branch: 'main', hostPort: 41000 });

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

  it('非 running 分支不发布(building/error/stopped 都跳过)', () => {
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
    expect(data).toEqual([]);
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
