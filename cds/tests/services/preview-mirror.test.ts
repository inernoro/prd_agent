/**
 * 预览实例数据镜像（CDS 托管 CDS，2026-09-16）的守卫。
 *
 * 三条底线各一组：不带凭据（脱敏 / 凭据集合不进文件）、只读（mirror 标记 + 幂等替换）、
 * 不冒充（指标锚到当下而不是伪造采集时刻）。外加接线守卫：部署点真的写了、序列端点真的回放了、
 * 启动真的读了——这些接线「删掉不会红」，正是 predicate-and-wiring-discipline 形状 2 要防的。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import {
  buildPreviewMirror, deepRedactForMirror, findMirrorLeaks, isHostingProject, readPreviewMirror, redactEnvForMirror, registerLoadedPreviewMirror,
  replayPreviewMirrorSeries, writePreviewMirror, __resetLoadedPreviewMirror, loadedPreviewMirrorSummary,
  type PreviewMirrorFile,
} from '../../src/services/preview-mirror.js';
import { seedPreviewInstanceDemoData, seedPreviewInstanceMirror, PREVIEW_DEMO_PROJECT_ID } from '../../src/services/preview-instance-seed.js';
import { recordContainerSample, __resetContainerMetricsHistory } from '../../src/services/container-metrics-history.js';
import type { BranchEntry, BuildProfile, Project } from '../../src/types.js';

const SRC = path.resolve(__dirname, '../../src');
let tmp: string;
function freshState(name: string): StateService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cds-mirror-${name}-`));
  process.env.CDS_CACHE_BASE = path.join(dir, 'cache');
  const s = new StateService(path.join(dir, 'state.json'));
  s.load();
  return s;
}

function parentState(): StateService {
  const s = freshState('parent');
  const now = new Date().toISOString();
  s.addProject({ id: 'map', slug: 'map', name: 'MAP', kind: 'git', createdAt: now, updatedAt: now, statusPageToken: 'tok-secret-xyz' } as Project);
  s.addProject({ id: 'cds-self', slug: 'cds-self', name: 'CDS Self', kind: 'git', createdAt: now, updatedAt: now } as Project);
  s.addBuildProfile({ id: 'api', projectId: 'map', name: 'api', dockerImage: 'node:20', workDir: '.', containerPort: 5000, pathPrefixes: ['/api/'], env: { MONGO_URL: 'mongodb://root:hunter2@mongo:27017/db', JWT_SECRET: 'abcdef', ASPNETCORE_URLS: 'http://+:5000' } } as BuildProfile);
  s.addBuildProfile({ id: 'cds', projectId: 'cds-self', name: 'cds', dockerImage: 'node:20-slim', workDir: '.', containerPort: 9900, env: { CDS_PREVIEW_INSTANCE: '1' } } as BuildProfile);
  s.addBranch({ id: 'map-main', projectId: 'map', branch: 'main', worktreePath: '/srv/wt/map-main', status: 'running', createdAt: now, lastReadyAt: now, githubCommitSha: 'a'.repeat(40), services: { api: { profileId: 'api', containerName: 'c-map-main-api', hostPort: 43000, status: 'running', buildLog: 'export JWT_SECRET=abcdef\nok' } } } as unknown as BranchEntry);
  s.addBranch({ id: 'self-x', projectId: 'cds-self', branch: 'claude/x', worktreePath: '/srv/wt/self-x', status: 'running', createdAt: now, services: {} } as unknown as BranchEntry);
  s.appendLog('map-main', { type: 'build', startedAt: now, status: 'completed', events: [{ step: 'env', status: 'info', timestamp: now, log: 'JWT_SECRET=abcdef' }] });
  return s;
}

beforeEach(() => { __resetContainerMetricsHistory(); __resetLoadedPreviewMirror(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mirror-wt-')); });
afterEach(async () => { await flushAllJsonStateStores(); });

describe('脱敏（不带凭据）', () => {
  it('敏感 key 与带凭据的值只留形状；URL 保留 scheme 与主机名，服务关系图还画得出基础设施连线', () => {
    const out = redactEnvForMirror({ MONGO_URL: 'mongodb://root:hunter2@mongo:27017/db', JWT_SECRET: 'abcdef', PORT: '5000', CDS_PATH_PREFIX: '/api/' })!;
    expect(out.MONGO_URL).toBe('mongodb://***:***@mongo:27017/db');
    expect(out.JWT_SECRET).toBe('***');
    expect(out.PORT).toBe('5000');
    expect(out.CDS_PATH_PREFIX).toBe('/api/');
  });
  it('导出的镜像：不含托管 CDS 的项目、项目白名单拷贝、分支不带 buildLog、日志过打码、自检零泄露', () => {
    const s = parentState();
    const now = Date.now();
    recordContainerSample('c-map-main-api', { cpuPercent: 12, memUsedBytes: 100, memLimitBytes: 1000, netRxBytes: 0, netTxBytes: 0 }, now - 60_000);
    recordContainerSample('c-map-main-api', { cpuPercent: 20, memUsedBytes: 120, memLimitBytes: 1000, netRxBytes: 10, netTxBytes: 5 }, now - 10_000);
    const m = buildPreviewMirror(s, { previewFor: () => ({ url: 'https://main.example.test/', urls: ['https://main.example.test/'] }), sourceLabel: 'CDS（example.test）', nowMs: now });
    expect(m.projects.map((p) => p.id)).toEqual(['map']);
    expect((m.projects[0] as Record<string, unknown>).statusPageToken).toBeUndefined();
    expect(m.projects[0].mirror?.source).toBe('parent-cds');
    expect(m.branches.map((b) => b.id)).toEqual(['map-main']);
    expect(m.branches[0].mirror?.previewUrl).toBe('https://main.example.test/');
    expect(m.branches[0].worktreePath).toBe('/preview-mirror/map-main');
    expect((m.branches[0].services.api as Record<string, unknown>).buildLog).toBeUndefined();
    expect(m.buildProfiles.find((p) => p.id === 'api')?.env?.JWT_SECRET).toBe('***');
    expect(m.buildProfiles.some((p) => p.id === 'cds')).toBe(false);
    expect(JSON.stringify(m.logs)).not.toContain('abcdef');
    expect(Object.keys(m.metrics)).toEqual(['c-map-main-api']);
    expect(m.metrics['c-map-main-api'].every((p) => p.o >= 0)).toBe(true);
    expect(findMirrorLeaks(m)).toEqual([]);
    expect(JSON.stringify(m)).not.toContain('hunter2');
    expect(JSON.stringify(m)).not.toContain('tok-secret');
  });
  it('构建配置的嵌套字段也脱敏：deployModes[*].env、managedBuild、command 里的凭据一个都不进镜像（Codex P1）', () => {
    const parent = parentState();
    parent.addBuildProfile({
      id: 'worker', projectId: 'map', name: 'worker', dockerImage: 'node:20', workDir: '.', containerPort: 5001,
      command: 'node worker.js --mongo mongodb://root:nested-pass-1@mongo:27017/db --api-token=nested-tok-2',
      deployModes: { image: { env: { DB_PASSWORD: 'nested-pass-3', PORT: '5001' } } },
      managedBuild: { registryPassword: 'nested-pass-4', env: { NPM_TOKEN: 'nested-tok-5' } },
    } as unknown as BuildProfile);
    const m = buildPreviewMirror(parent, { nowMs: Date.now() });
    const text = JSON.stringify(m);
    for (const secret of ['nested-pass-1', 'nested-tok-2', 'nested-pass-3', 'nested-pass-4', 'nested-tok-5']) expect(text, secret).not.toContain(secret);
    expect(text, '不敏感的值要留着，前缀与端口是图和面板要读的').toContain('"PORT":"5001"');
    expect(findMirrorLeaks(m)).toEqual([]);
    // 纯函数：任意深度的 env 与敏感 key 都被处理
    const out = deepRedactForMirror({ a: { b: [{ env: { SECRET: 'x', KEEP: 'y' }, password: 'p', note: 'https://u:pw@h/x' }] } });
    expect(out).toEqual({ a: { b: [{ env: { SECRET: '***', KEEP: 'y' }, password: '***', note: 'https://***:***@h/x' }] } });
  });

  it('托管判定与部署侧同一个谓词：CDS_PREVIEW_INSTANCE 写在项目级 env 里也算托管项目（Codex P2）', () => {
    const parent = parentState();
    const now = new Date().toISOString();
    parent.addProject({ id: 'host2', slug: 'host2', name: 'Host 2', kind: 'git', createdAt: now, updatedAt: now } as Project);
    parent.addBuildProfile({ id: 'h2', projectId: 'host2', name: 'cds', dockerImage: 'node:20-slim', workDir: '.', containerPort: 9900, env: {} } as BuildProfile);
    parent.setCustomEnv({ CDS_PREVIEW_INSTANCE: '1' }, 'host2');
    expect(isHostingProject(parent, 'host2')).toBe(true);
    expect(buildPreviewMirror(parent, { nowMs: Date.now() }).projects.map((p) => p.id)).not.toContain('host2');
  });

  it('自检能抓到内联凭据的 URL', () => {
    const m = { version: 1, capturedAt: 'x', source: { kind: 'parent-cds', label: 'p' }, projects: [], buildProfiles: [{ env: { X: 'redis://a:b@h' } }], branches: [], deploymentRuns: [], reports: [], logs: {}, metrics: {} } as unknown as PreviewMirrorFile;
    expect(findMirrorLeaks(m)).toContain('url-with-inline-credentials');
  });
});

describe('只读 + 幂等（子实例播种）', () => {
  it('首播：项目 / 构建配置 / 分支 / 日志带 mirror 标记落库，静态快照不再播', () => {
    const parent = parentState();
    const m = buildPreviewMirror(parent, { nowMs: Date.now() });
    const child = freshState('child');
    expect(seedPreviewInstanceDemoData(child, m)).toBe(true);
    const branch = child.getBranch('map-main')!;
    expect(branch.mirror?.capturedAt).toBe(m.capturedAt);
    expect(branch.status).toBe('running');
    expect(child.getProject('map')?.mirror?.source).toBe('parent-cds');
    expect(child.getBuildProfiles().some((p) => p.id === 'api')).toBe(true);
    expect(child.getLogs('map-main')).toHaveLength(1);
    // 演示项目仍在，快照项目一个都没有
    expect(child.getProject(PREVIEW_DEMO_PROJECT_ID)).toBeTruthy();
    expect(child.getProjects().some((p) => p.id.startsWith('snap-'))).toBe(false);
  });
  it('同一份镜像重复启动不动库；新镜像整体替换，镜像里消失的分支也消失', () => {
    const parent = parentState();
    const m1 = buildPreviewMirror(parent, { nowMs: Date.parse('2026-09-16T10:00:00Z') });
    const child = freshState('child2');
    seedPreviewInstanceDemoData(child, m1);
    expect(seedPreviewInstanceMirror(child, m1)).toBe(false);
    parent.removeBranch('map-main');
    parent.addBranch({ id: 'map-dev', projectId: 'map', branch: 'dev', worktreePath: '/srv/wt/map-dev', status: 'idle', createdAt: new Date().toISOString(), services: {} } as unknown as BranchEntry);
    const m2 = buildPreviewMirror(parent, { nowMs: Date.parse('2026-09-16T11:00:00Z') });
    expect(seedPreviewInstanceMirror(child, m2)).toBe(true);
    expect(child.getBranch('map-main')).toBeUndefined();
    expect(child.getBranch('map-dev')?.mirror?.capturedAt).toBe(m2.capturedAt);
    expect(child.getProject('map')?.mirror?.capturedAt).toBe(m2.capturedAt);
  });

  it('换镜像时旧分支的部署 run 一起退场，不再挂在重建出来的项目下（Codex P2）', () => {
    const parent = parentState();
    const now = new Date().toISOString();
    parent.addDeploymentRun({ id: 'run-old', projectId: 'map', branchId: 'map-main', status: 'succeeded', startedAt: now, events: [] } as unknown as Parameters<StateService['addDeploymentRun']>[0]);
    const m1 = buildPreviewMirror(parent, { nowMs: Date.parse('2026-09-16T10:00:00Z') });
    const child = freshState('child-runs');
    seedPreviewInstanceDemoData(child, m1);
    expect(child.getDeploymentRuns({ branchId: 'map-main' }).map((r) => r.id)).toEqual(['run-old']);
    // 父实例：那条分支没了，新分支带一条 run
    parent.removeBranch('map-main');
    parent.addBranch({ id: 'map-dev', projectId: 'map', branch: 'dev', worktreePath: '/srv/wt/map-dev', status: 'idle', createdAt: now, services: {} } as unknown as BranchEntry);
    parent.addDeploymentRun({ id: 'run-new', projectId: 'map', branchId: 'map-dev', status: 'succeeded', startedAt: now, events: [] } as unknown as Parameters<StateService['addDeploymentRun']>[0]);
    const m2 = buildPreviewMirror(parent, { nowMs: Date.parse('2026-09-16T11:00:00Z') });
    expect(seedPreviewInstanceMirror(child, m2)).toBe(true);
    expect(child.getDeploymentRuns({ projectId: 'map' }).map((r) => r.id), '旧 run 该跟着旧分支退场').toEqual(['run-new']);
  });
  it('库里有真实项目（既非演示、非快照、也不带 mirror）时一条不播', () => {
    const child = freshState('child3');
    const now = new Date().toISOString();
    child.addProject({ id: 'real', slug: 'real', name: '真实项目', kind: 'git', createdAt: now, updatedAt: now } as Project);
    const m = buildPreviewMirror(parentState(), { nowMs: Date.now() });
    expect(seedPreviewInstanceMirror(child, m)).toBe(false);
    expect(child.getProject('map')).toBeUndefined();
  });
  it('写盘与读盘：落在 <worktree>/.cds/preview-mirror.json，版本不认识就抛', () => {
    const m = buildPreviewMirror(parentState(), { nowMs: Date.now() });
    const file = writePreviewMirror(tmp, m);
    expect(file).toBe(path.join(tmp, '.cds', 'preview-mirror.json'));
    expect(readPreviewMirror(tmp)?.capturedAt).toBe(m.capturedAt);
    fs.writeFileSync(file, JSON.stringify({ version: 99 }));
    expect(() => readPreviewMirror(tmp)).toThrow(/版本/);
    expect(readPreviewMirror(path.join(tmp, 'nope'))).toBeNull();
  });
});

describe('不冒充（指标回放锚到当下）', () => {
  it('镜像点位按「距采集多少秒」存，回放时落在请求窗口里；镜像里没有的容器返回 null 走原路', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    registerLoadedPreviewMirror({
      version: 1, capturedAt: '2026-09-16T08:00:00Z', source: { kind: 'parent-cds', label: 'p' },
      projects: [], buildProfiles: [], branches: [], deploymentRuns: [], reports: [], logs: {},
      metrics: { c1: [{ o: 600, c: 10, m: 100, rx: null, tx: null, rd: null, wr: null }, { o: 540, c: 30, m: 120, rx: 1, tx: 2, rd: null, wr: null }] },
    });
    expect(loadedPreviewMirrorSummary()?.containersWithMetrics).toBe(1);
    const r = replayPreviewMirrorSeries(['c1'], { after: -1800, points: 60 }, now)!;
    expect(r.before).toBe(now);
    expect(r.timestamps.every((t) => t > now - 1800_000 && t <= now)).toBe(true);
    // 两个点位各自填到离它最近的桶（可能各占相邻两桶），但值只会是这两个，不会凭空插值
    const cpu = r.series.c1.map((p) => p.cpuPercent).filter((v): v is number => v !== null);
    expect(cpu.length).toBeGreaterThanOrEqual(1);
    // 只会是这两个点位的值或它们的平均，不会凭空插出别的数
    for (const v of cpu) expect([10, 20, 30]).toContain(v);
    expect(replayPreviewMirrorSeries(['unknown'], { after: -1800 }, now)).toBeNull();
  });
  it('父实例按 60s 降采样过的点位回放成 60s 桶时不隔桶漏桶（面积图不许切成细条）', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    const pts = Array.from({ length: 30 }, (_, i) => ({ o: 1800 - i * 60 - 7, c: 10 + (i % 3), m: 1, rx: null, tx: null, rd: null, wr: null }));
    registerLoadedPreviewMirror({ version: 1, capturedAt: 'x', source: { kind: 'parent-cds', label: 'p' }, projects: [], buildProfiles: [], branches: [], deploymentRuns: [], reports: [], logs: {}, metrics: { c1: pts } });
    const r = replayPreviewMirrorSeries(['c1'], { after: -1800, points: 120 }, now)!;
    // 桶宽不细于点位间隔的 1.5 倍（60s 点位 → 90s 桶），于是要 120 个点也只给 20 个桶，但桶桶有值
    expect(r.groupSeconds).toBe(90);
    const filled = r.series.c1.filter((p) => p.cpuPercent !== null).length;
    expect(filled).toBeGreaterThanOrEqual(r.timestamps.length - 1);
  });
});

describe('接线守卫', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  it('两个部署点都会在拿到 mergedEnv 之后写镜像；子实例自己不导出', () => {
    const src = read('routes/branches.ts');
    expect((src.match(/maybeWritePreviewMirror\(entry, mergedEnv,/g) ?? []).length).toBe(2);
    const fn = src.slice(src.indexOf('function maybeWritePreviewMirror'), src.indexOf('function computeBranchWebEntries'));
    expect(fn).toContain('if (isPreviewInstance()) return;');
    expect(fn).toContain('findMirrorLeaks(mirror)');
    expect(fn).toContain('writePreviewMirror(entry.worktreePath, mirror)');
  });
  it('序列端点在预览实例上先回放镜像；启动时读镜像并装入；实例模式端点带镜像摘要', () => {
    const routes = read('routes/branches.ts');
    expect(routes).toContain("isPreviewInstance() ? replayPreviewMirrorSeries([...byContainer.keys()], seriesQuery) : null");
    const index = read('index.ts');
    expect(index).toContain('readPreviewMirror(config.repoRoot)');
    expect(index).toContain('registerLoadedPreviewMirror(mirror)');
    expect(index).toContain('seedPreviewInstanceDemoData(stateService, mirror)');
    const server = read('server.ts');
    expect(server).toContain("mirror: isPreviewInstance() ? loadedPreviewMirrorSummary() : null");
  });
});

describe('重启幂等（实机抓到的形状）', () => {
  it('同一份镜像第二次启动：演示报告不被删、日志不说「已播种」', () => {
    const m = buildPreviewMirror(parentState(), { nowMs: Date.now() });
    const child = freshState('child4');
    expect(seedPreviewInstanceDemoData(child, m)).toBe(true);
    const reportsAfterFirstBoot = child.listAcceptanceReports(null).length;
    expect(reportsAfterFirstBoot).toBeGreaterThan(0);
    expect(seedPreviewInstanceDemoData(child, m)).toBe(false);
    expect(child.listAcceptanceReports(null).length).toBe(reportsAfterFirstBoot);
  });
});
