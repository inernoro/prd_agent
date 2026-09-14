/**
 * 预览实例形状快照的守卫（2026-09-14）。
 *
 * 这批数据的坏法：
 *
 * 1. **时间存成绝对日期**。几个月后 90 天窗口把整批数据甩到窗外，页面变回空的，
 *    而且没人会发现——演示数据自己腐烂。所以存的必须是相对天数。
 * 2. **冒充真实部署**。快照是别的实例的数据，不标出来源就是骗人。
 * 3. **把真实数据的库也播一遍**。补播不能照抄首播的「零项目」守卫（它永远为假），
 *    得自己判「库里有没有不属于演示的项目」。
 * 4. **播完形状不对**。搬过来的目的就是让曲线有形状，所以要真的跑一遍聚合核对。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import {
  seedPreviewInstanceDemoData,
  seedPreviewInstanceSnapshot,
  isSnapshotProjectId,
  PREVIEW_DEMO_PROJECT_ID,
} from '../../src/services/preview-instance-seed.js';
import { buildPipelineOverview, buildPipelineSeries } from '../../src/services/acceptance-pipeline.js';

interface SnapB { id: string; deployAgo: number | null }

const SNAP = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../..', 'src/services/preview-demo-snapshot.json'), 'utf8'),
);

describe('快照文件本身', () => {
  it('时间是相对天数，不是绝对日期', () => {
    // 绝对日期会让这批数据随时间滑出窗口。抽查所有条目，一个绝对时刻都不许有。
    for (const b of SNAP.branches) {
      expect(b, `分支 ${b.id} 带了绝对时刻`).not.toHaveProperty('createdAt');
      expect(typeof b.createdAgo === 'number' || b.createdAgo === null).toBe(true);
    }
    for (const r of SNAP.reports) {
      expect(r, `报告「${r.title}」带了绝对时刻`).not.toHaveProperty('createdAt');
      expect(typeof r.createdAgo === 'number' || r.createdAgo === null).toBe(true);
    }
  });

  it('相对天数都落在窗口内且非负', () => {
    const all = [
      ...SNAP.branches.map((b: { createdAgo: number | null }) => b.createdAgo),
      ...SNAP.reports.map((r: { createdAgo: number | null }) => r.createdAgo),
    ].filter((v): v is number => v != null);
    expect(all.length).toBeGreaterThan(300);
    for (const v of all) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v, '超出 95 天的条目在 90 天窗口里永远看不到').toBeLessThanOrEqual(95);
    }
  });

  it('项目 id 一律带前缀，不可能和真实项目撞', () => {
    for (const p of SNAP.projects) expect(isSnapshotProjectId(p.id), `${p.id} 没带前缀`).toBe(true);
    for (const b of SNAP.branches) expect(isSnapshotProjectId(b.projectId)).toBe(true);
    for (const r of SNAP.reports) {
      // 无主报告的 projectId 本来就是 null，那是真实存在的一类，不能被改写掉。
      if (r.projectId != null) expect(isSnapshotProjectId(r.projectId)).toBe(true);
    }
    expect(SNAP.reports.filter((r: { projectId: string | null }) => r.projectId == null).length)
      .toBeGreaterThan(0);
  });

  it('没有 emoji', () => {
    const raw = JSON.stringify(SNAP);
    expect(raw).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe('播种', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-snap-seed-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('播完之后条数与快照一致，且第二次是空跑', () => {
    expect(seedPreviewInstanceSnapshot(service)).toBe(true);
    const snapBranches = service.getAllBranches().filter((b) => isSnapshotProjectId(b.projectId));
    expect(snapBranches).toHaveLength(SNAP.branches.length);
    const titles = new Set(service.listAcceptanceReports(null).map((r) => r.title));
    // 快照里有同名报告（同一目标多次归档），去重后的标题数才是能落库的条数。
    const uniqueTitles = new Set(SNAP.reports.map((r: { title: string }) => r.title));
    for (const t of uniqueTitles) expect(titles.has(t as string), `报告「${t}」没播进去`).toBe(true);

    expect(seedPreviewInstanceSnapshot(service), '第二次播种不是空跑，会重复灌数据').toBe(false);
  });

  it('每条都标了来源与时点，不冒充本实例的部署', () => {
    seedPreviewInstanceSnapshot(service);
    const captured = String(SNAP.capturedAt).slice(0, 10);
    for (const p of service.getProjects().filter((x) => isSnapshotProjectId(x.id))) {
      expect(p.description).toContain('演示数据');
      expect(p.description).toContain(captured);
    }
    for (const b of service.getAllBranches().filter((x) => isSnapshotProjectId(x.projectId))) {
      expect(b.notes).toContain('演示数据');
    }
  });

  it('搬过来的分支一律不标成运行中', () => {
    // 这台实例上没有任何容器；标成 running 会让分支列表显示一排点不开的「运行中」。
    seedPreviewInstanceSnapshot(service);
    for (const b of service.getAllBranches().filter((x) => isSnapshotProjectId(x.projectId))) {
      expect(b.status, `${b.id} 标成了 ${b.status}`).toBe('idle');
      expect(Object.keys(b.services || {})).toHaveLength(0);
    }
  });

  it('已经播过但播错的分支，会被补回来', () => {
    // 补播天生只加不改，而预览实例的 state 跨部署保留——一次播错就一直错下去。
    // 实机验到过：改完抽取端重新部署，页面上那个假数纹丝不动。
    seedPreviewInstanceSnapshot(service);
    const victim = SNAP.branches.find((b: SnapB) => b.deployAgo != null)!;
    const stored = service.getBranch(victim.id)!;
    stored.lastDeployAt = undefined;
    expect(seedPreviewInstanceSnapshot(service), '播错的没被认出来').toBe(true);
    expect(service.getBranch(victim.id)!.lastDeployAt, '播错的没被补回来').toBeTruthy();
    // 补完之后再跑一次仍要是空跑。
    expect(seedPreviewInstanceSnapshot(service)).toBe(false);
  });

  it('修复不越界：用户改过的备注不许被覆盖', () => {
    seedPreviewInstanceSnapshot(service);
    const victim = SNAP.branches.find((b: SnapB) => b.deployAgo != null)!;
    const stored = service.getBranch(victim.id)!;
    stored.lastDeployAt = undefined;
    stored.notes = '我自己写的备注';
    seedPreviewInstanceSnapshot(service);
    expect(service.getBranch(victim.id)!.notes).toBe('我自己写的备注');
  });

  it('库里有真实项目时一条都不播', () => {
    service.addProject({
      id: 'a-real-project',
      slug: 'a-real-project',
      name: '真实项目',
      kind: 'git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    expect(seedPreviewInstanceSnapshot(service), '挂着真实数据的实例被灌了演示数据').toBe(false);
    expect(service.getAllBranches().filter((b) => isSnapshotProjectId(b.projectId))).toHaveLength(0);
  });

  it('和原有演示项目并存，互不干扰', () => {
    expect(seedPreviewInstanceDemoData(service)).toBe(true);
    expect(service.getProject(PREVIEW_DEMO_PROJECT_ID), '原来的演示项目没了').toBeTruthy();
    expect(service.getProjects().filter((p) => isSnapshotProjectId(p.id)).length).toBeGreaterThan(0);
    // 全量入口第二次也必须是空跑。
    expect(seedPreviewInstanceDemoData(service)).toBe(false);
  });
});

describe('播完之后，页面拿到的形状要对', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-snap-shape-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
    seedPreviewInstanceDemoData(service);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('「起过预览」这个事实要活着搬过来，不能在路上丢掉', () => {
    // 真实发生过：快照里 70 条有 69 条起过预览，播种时把 services 清空（免得列表
    // 显示一排点不开的「运行中」），而那三十多条分支的部署事实恰恰只记在 services 上、
    // 没有部署时刻，于是事实整个丢了，页面显示「没起预览 39」这种假数。
    const snapDeployed = SNAP.branches.filter((b: { deployed: boolean }) => b.deployed).length;
    const o = buildPipelineOverview(
      service.getProjects(), service.getAllBranches(), [], service.listAcceptanceReports(null), {},
    );
    const undeployed = o.total.changes - o.total.deployed;
    const snapUndeployed = SNAP.branches.length - snapDeployed;
    // 演示项目那 5 条也在库里（其中有没起过预览的），所以给一点余量，但不能差几十条。
    expect(undeployed, `没起预览 ${undeployed} 条，快照里只有 ${snapUndeployed} 条`)
      .toBeLessThanOrEqual(snapUndeployed + 5);
  });

  it('存量总览有真实量级，不再是个位数', () => {
    // 搬这批数据的全部理由就是「5 条看不出形状」。跑一遍真聚合，确认量级真的上来了。
    const o = buildPipelineOverview(
      service.getProjects(), service.getAllBranches(), [], service.listAcceptanceReports(null), {},
    );
    expect(o.total.changes, '改动量级没上来，这批数据白搬了').toBeGreaterThan(50);
    expect(o.projects.length).toBeGreaterThan(5);
  });

  it('走向序列三档都有非零的日子，且不是全挤在同一天', () => {
    const s = buildPipelineSeries(
      service.getProjects(), service.getAllBranches(), service.listAcceptanceReports(null), { days: 90 },
    );
    const nz = (xs: number[]): number => xs.filter((v) => v > 0).length;
    // 三条线各自至少要在 10 天上有值，否则折线还是三条贴零的直线。
    expect(nz(s.pass), '通过那条线几乎没有非零日').toBeGreaterThanOrEqual(10);
    expect(nz(s.conditional)).toBeGreaterThanOrEqual(10);
    expect(nz(s.fail)).toBeGreaterThanOrEqual(10);
    expect(nz(s.changes)).toBeGreaterThanOrEqual(5);
  });

  it('稀疏是真实特征，要保留而不是被抹平', () => {
    // 这份数据真实的样子就是「多数日子没有动静」。如果播种把它摊匀了，
    // 曲线会变得很好看，但它讲的就不是真事了。
    const s = buildPipelineSeries(
      service.getProjects(), service.getAllBranches(), service.listAcceptanceReports(null), { days: 90 },
    );
    const zeroDays = s.days.filter((_, i) => s.pass[i] + s.conditional[i] + s.fail[i] === 0).length;
    expect(zeroDays, '一天不缺的曲线说明数据被摊匀了，不是真实形状').toBeGreaterThan(15);
  });
});
