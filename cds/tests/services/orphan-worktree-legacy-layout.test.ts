/**
 * 从扁平布局迁移过来的存量部署，孤儿对账绝不能碰到活的工作树
 *（Codex PR #1275 二轮 P1，真删代码级别的风险）。
 *
 * FU-04 的 migrateFlatLayoutIfNeeded 用**符号链接**而不是移动：原来的
 * `<base>/<slug>` 真实 worktree 原地保留，只在 `<base>/default/<slug>` 建一条
 * 指向它的链接，台账 worktreePath 改指嵌套路径。于是顶层同时躺着：
 *   - `default/`      ← 真正的项目桶
 *   - `prd-agent-main/` ← 遗留的真 worktree（活的，容器还在用）
 *
 * 旧实现「顶层每个目录都当项目桶」，会把后者往下枚举一层，吐出
 * `prd-agent-main/cds`、`prd-agent-main/prd-api` 这些**源码子目录**当孤儿候选。
 * 三道护栏一道都拦不住：不等于任何台账路径（台账指的是嵌套链接路径）、
 * 挂载检查是后代语义（容器挂的是 worktree 根）、两小时年龄线随便就过。
 * 结果是递归删掉在跑的工作树。
 *
 * 这里直接在临时目录里搭出迁移后的真实布局，跑真的 fs 实现（不 mock），
 * 断言那些源码子目录**根本不会出现在候选里**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultOrphanWorktreeFs } from '../../src/services/janitor.js';
import { computeOrphanWorktreePlan } from '../../src/services/orphan-worktree.js';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-worktrees-'));
  // 迁移后的真实形态
  fs.mkdirSync(path.join(base, 'default'), { recursive: true });
  // 遗留的扁平 worktree（活的），里面是源码子目录
  const legacy = path.join(base, 'prd-agent-main');
  for (const sub of ['cds', 'prd-api', 'prd-admin', 'doc']) {
    fs.mkdirSync(path.join(legacy, sub), { recursive: true });
  }
  // default 桶下是指向它的符号链接
  try {
    fs.symlinkSync(legacy, path.join(base, 'default', 'prd-agent-main'), 'dir');
  } catch {
    /* 平台不支持符号链接时跳过这一步，白名单断言仍然成立 */
  }
  // 桶下另有一个真正的孤儿目录
  fs.mkdirSync(path.join(base, 'default', 'dead-branch'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('迁移后的扁平遗留 worktree', () => {
  it('遗留 worktree 不被当成项目桶，其源码子目录不进候选', async () => {
    const dirs = await defaultOrphanWorktreeFs.listWorktreeDirs(base, ['default']);
    const paths = dirs.map((d) => d.path);
    for (const sub of ['cds', 'prd-api', 'prd-admin', 'doc']) {
      expect(paths.some((p) => p.endsWith(`/prd-agent-main/${sub}`))).toBe(false);
    }
    // 真正的孤儿仍然要被找出来，功能不能因为加护栏就废了
    expect(paths.some((p) => p.endsWith('/default/dead-branch'))).toBe(true);
  });

  it('符号链接形态的桶内条目不进候选（只认真实目录）', async () => {
    const dirs = await defaultOrphanWorktreeFs.listWorktreeDirs(base, ['default']);
    expect(dirs.map((d) => d.path).some((p) => p.endsWith('/default/prd-agent-main'))).toBe(false);
  });

  it('拿不到项目清单时整轮不枚举（宁可不清也不误删）', async () => {
    expect(await defaultOrphanWorktreeFs.listWorktreeDirs(base, [])).toEqual([]);
  });
});

describe('纯判定层的血缘兜底（枚举层万一再出岔子）', () => {
  const NOW = Date.parse('2026-07-28T12:00:00Z');
  const OLD = NOW - 24 * 60 * 60_000;
  const claimed = '/srv/wt/default/main';

  it('候选是台账路径的子目录 → 保留', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [{ path: `${claimed}/cds`, mtimeMs: OLD }],
      claimedPaths: [claimed],
      mountedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons[`${claimed}/cds`]).toContain('子目录');
  });

  it('候选是台账路径的上级 → 保留（删了它等于连锅端掉在用的分支）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [{ path: '/srv/wt/default', mtimeMs: OLD }],
      claimedPaths: [claimed],
      mountedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons['/srv/wt/default']).toContain('上级');
  });

  it('与所有台账路径毫无包含关系 → 才算真孤儿', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [{ path: '/srv/wt/default/dead', mtimeMs: OLD }],
      claimedPaths: [claimed],
      mountedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual(['/srv/wt/default/dead']);
  });

  it('同名前缀但不是路径边界 → 不误判为血缘（default-old 不是 default 的子目录）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [{ path: '/srv/wt/default/main-old', mtimeMs: OLD }],
      claimedPaths: [claimed],
      mountedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual(['/srv/wt/default/main-old']);
  });
});
