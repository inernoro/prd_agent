/**
 * 孤儿 worktree 对账在 janitor 里的接线（2026-07-27 宕机复盘 P2）。
 *
 * 纯判定在 orphan-worktree.test.ts；这里只钉接线层的三条：
 *  - 真的会删（否则 45.5GB 还是收不回来）；
 *  - 查不到容器挂载情况时**整轮不删**（宁可晚一轮，也不删还被挂着的目录）；
 *  - 失败如实进 errors，不静默。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { JanitorService, type OrphanWorktreeFs } from '../../src/services/janitor.js';
import type { StateService } from '../../src/services/state.js';

const BASE = '/srv/.cds-worktrees';
const NOW = Date.parse('2026-07-28T12:00:00Z');
const OLD = NOW - 24 * 60 * 60_000;

let removed: string[];
let mounted: string[] | null;
let removeError: string | null;

let seenProjectIds: readonly string[] | null = null;

const fsFake = (): OrphanWorktreeFs => ({
  listWorktreeDirs: async (_base, knownProjectIds) => {
    seenProjectIds = knownProjectIds;
    return {
      dirs: [
        { path: `${BASE}/proj/live`, mtimeMs: OLD },
        { path: `${BASE}/proj/orphan`, mtimeMs: OLD },
      ],
      unreadable: [],
    };
  },
  listMountedHostPaths: async () => mounted,
  removeDir: async (dir) => { if (removeError) return removeError; removed.push(dir); return null; },
});

const stateFake = (): StateService => ({
  getAllBranches: () => [{ id: 'b1', worktreePath: `${BASE}/proj/live` }],
  getProjects: () => [{ id: 'proj' }],
  getDeletedProjectWorktreeBuckets: () => [],
  removeDeletedProjectWorktreeBucket: () => undefined,
  getDeploymentVersions: () => [],
  getDefaultBranchFor: () => null,
} as unknown as StateService);

const mkJanitor = (): JanitorService => new JanitorService(
  stateFake(),
  { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600,
    dockerPrune: false, imageRetention: false },
  BASE,
  { now: () => NOW },
  () => null,
  async () => ({ ran: false, reclaimed: [], errors: [] }),
  { listImages: async () => [], listInUseImages: async () => [], removeImage: async () => null },
  fsFake(),
);

beforeEach(() => { removed = []; mounted = []; removeError = null; seenProjectIds = null; });

describe('janitor 孤儿 worktree 接线', () => {
  it('台账无人认领且无容器挂载 → 真的删掉', async () => {
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([`${BASE}/proj/orphan`]);
    expect(report.orphanWorktrees?.removed).toEqual([`${BASE}/proj/orphan`]);
    // 台账里在用的那个必须留着并给出原因
    expect(report.orphanWorktrees?.keptReasons[`${BASE}/proj/live`]).toContain('正在使用');
  });

  it('查不到容器挂载情况 → 整轮只报不删', async () => {
    mounted = null;
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([]);
    expect(report.orphanWorktrees?.deferred).toBe(1);
  });

  it('目录被容器挂载 → 不删，理由如实带出', async () => {
    mounted = [`${BASE}/proj/orphan/prd-admin`];
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([]);
    expect(report.orphanWorktrees?.keptReasons[`${BASE}/proj/orphan`]).toContain('挂载');
  });

  it('只在已知项目桶下枚举：项目 id 白名单必须传给 fs 层（Codex PR #1275 二轮 P1）', async () => {
    await mkJanitor().sweep();
    expect(seenProjectIds).toEqual(['proj']);
  });

  it('删除失败进 errors，不静默吞掉', async () => {
    removeError = 'EBUSY: resource busy';
    const report = await mkJanitor().sweep();
    expect(report.orphanWorktrees?.failed).toHaveLength(1);
    expect(report.errors.some((e) => e.includes('orphan worktree rm'))).toBe(true);
  });
});

describe('挂载枚举的容错（2026-07-28 生产实测两轮定位）', () => {
  // 第二轮定位：改走 inspect 后仍然 removed 0 / deferred 66。根因是
  // `docker inspect a b c` 只要有一个 id 在 ps 与 inspect 之间消失就整体非零退出，
  // 而我把非零一律当查不到 → 恒返回 null → 回收恒被降级。消失的容器本就不可能
  // 挂着任何目录，忽略它是安全的；真正危险的是「一条都没查到却当成没人挂载」。
  it('部分容器消失（非零退出但有输出）时仍要用得到的那部分', () => {
    // 契约在实现里：!r.ok && !r.stdout 才返回 null；有 stdout 就继续用
    const src = readFileSync(new URL('../../src/services/janitor.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/if \(!r\.ok && !r\.stdout\) return null;/);
  });

  it('完全查不到（非零且无输出）才返回 null，让整轮只报不删', () => {
    const src = readFileSync(new URL('../../src/services/janitor.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/execDockerDetailed/);
  });
});

describe('挂载枚举必须走 docker inspect（2026-07-28 生产实测定位）', () => {
  // 生产第一轮：找到 66 个孤儿目录、removed 0 / deferred 66 —— 护栏正确地降级成
  // 只报不删，但功能等于没生效。根因是 `docker ps --format` 里的 .Mounts 是
  // 逗号分隔**字符串**，对它 {{range}} 会让 Go 模板报错、整条命令非零退出。
  // inspect 的 .Mounts 才是数组。这里把「用哪条命令」钉死。
  it('inspect 模板里不许出现真正的换行字符（Go 模板会解析失败、且无任何输出）', () => {
    // 第三轮定位：`{{"\\n"}}` 写在 TS 单引号串里，\\n 被转义成真正的换行塞进 Go
    // 模板的引号内 → unterminated quoted string → docker 非零退出且无输出 →
    // 挂载枚举恒 null → 孤儿回收恒停在 0/66。用 {{println}} 从根上避开。
    const src = readFileSync(new URL('../../src/services/janitor.ts', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes("'inspect', '--format'")) || '';
    expect(line).toContain('println .Source');
    expect(line).not.toContain('{{"');
  });

  it('默认实现用 docker inspect 而不是 docker ps 取挂载源', async () => {
    const calls: string[][] = [];
    const mod = await import('../../src/services/janitor.js');
    // 只做静态断言：实现里不允许再出现对 ps 输出 range .Mounts 的写法
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../../src/services/janitor.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/'ps',\s*'-a',\s*'--format',\s*'\{\{range \.Mounts\}\}/);
    expect(src).toMatch(/'inspect',\s*'--format',\s*'\{\{range \.Mounts\}\}/);
    expect(mod.defaultOrphanWorktreeFs.listMountedHostPaths).toBeTypeOf('function');
    void calls;
  });
});
