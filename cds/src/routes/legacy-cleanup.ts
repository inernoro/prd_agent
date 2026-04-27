/**
 * 遗留「default」项目清理路由
 *
 * 用户诉求：「不要使用？project 这种，而是使用真正的项目名或项目id」
 *          「default 我早就说要去掉，始终去不掉」
 *
 * 现实：历史上 CDS 从单项目升级到多项目时，所有旧数据都被归到 `default`
 * 项目名下做向前兼容。直接删 default 会让旧 branches/profiles/infra 全部
 * 孤立 → 生产事故。本路由提供 **可控迁移**：
 *
 *   GET  /api/legacy-cleanup/status         —— 看看 default 还有多少数据
 *   POST /api/legacy-cleanup/rename-default —— 把 default 改成用户给的 id/name
 *
 * 用户在顶部 banner 点「迁移 →」弹对话框输入新 id，一键改名。
 * 之后：
 *   - 所有 branches.projectId='default' → 新 id
 *   - 所有 buildProfiles.projectId='default' → 新 id
 *   - 所有 infraServices.projectId='default' → 新 id
 *   - Project.id='default' → 新 id，Project.legacyFlag 清掉
 *   - customEnv['default'] scope → 新 id scope
 *   - worktree 目录物理改名 `<base>/default/` → `<base>/<newId>/`
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { StateService } from '../services/state.js';
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

const LEGACY_PROJECT_ID = 'default';
const SLUG_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;

export interface LegacyCleanupRouterDeps {
  stateService: StateService;
  shell: IShellExecutor;
  worktreeBase: string;
}

export function createLegacyCleanupRouter(deps: LegacyCleanupRouterDeps): Router {
  const { stateService, shell, worktreeBase } = deps;
  const router = Router();

  router.get('/legacy-cleanup/status', (_req, res) => {
    const allBranches = stateService.getAllBranches();
    const branches = allBranches.filter(b => (b.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    const profiles = stateService.getBuildProfiles().filter(p => (p.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    const infra = stateService.getInfraServices().filter(s => (s.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    const hasLegacyProject = (stateService.getProjects?.() || []).some(p => p.id === LEGACY_PROJECT_ID);
    const legacyWorktreeExists = fs.existsSync(path.posix.join(worktreeBase, LEGACY_PROJECT_ID));
    const rawEnv = stateService.getCustomEnvRaw?.() || {};
    const customEnvScopeExists = Boolean(rawEnv[LEGACY_PROJECT_ID] && Object.keys(rawEnv[LEGACY_PROJECT_ID]).length > 0);

    const hasResources = branches.length > 0 || profiles.length > 0 || infra.length > 0;
    // Two distinct user-facing states:
    //
    //   needsMigration — the default project still owns real data
    //     (project record itself, branches, profiles, infra, OR a
    //     non-empty customEnv['default'] scope). Requires the rename
    //     flow so entries don't get orphaned and so user secrets in
    //     the env scope get copied into the new project's scope
    //     instead of being silently dropped.
    //
    //   residualOnly — rename already happened, real data is gone;
    //     the only thing left is an empty worktreeBase/default
    //     directory. Safe to delete via cleanup-residual.
    //
    // PR #498 round-5 review (Bugbot): customEnvScopeExists used to
    // route to residualOnly which surfaces "清理残留" button, but the
    // cleanup-residual endpoint refuses with 409 when the scope is
    // non-empty (round-1 fix), creating a dead-end UX where the only
    // visible action always fails. Including customEnvScopeExists in
    // needsMigration directs the user to "迁移 →" instead, which
    // correctly copies the env vars into the renamed project's scope.
    const needsMigration = hasLegacyProject || hasResources || customEnvScopeExists;
    const residualOnly = !needsMigration && legacyWorktreeExists;

    let recommendation: string;
    if (needsMigration) {
      recommendation = '建议点「迁移 →」为 default 项目改个真实名字。';
    } else if (residualOnly) {
      recommendation = 'default 已迁移,只剩残留工作目录。点「清理残留」即可彻底消除横幅。';
    } else {
      recommendation = '无需操作,default 项目已空。';
    }

    res.json({
      // `legacyInUse` retained for back-compat; the banner-visibility
      // gate is now this OR residualOnly.
      legacyInUse: needsMigration || residualOnly,
      needsMigration,
      residualOnly,
      counts: {
        branches: branches.length,
        buildProfiles: profiles.length,
        infraServices: infra.length,
        hasLegacyProject,
        legacyWorktreeExists,
        customEnvScopeExists,
      },
      recommendation,
    });
  });

  router.post('/legacy-cleanup/cleanup-residual', (_req, res) => {
    // Safe-by-construction cleanup for the residualOnly state: refuses
    // when any real data (project record, branches, profiles, infra,
    // non-empty env scope) is still attributed to `default`. Only
    // removes truly stale filesystem + state fixtures left over after
    // a successful rename-default migration.
    const allBranches = stateService.getAllBranches();
    const hasLegacyProject = (stateService.getProjects?.() || []).some(p => p.id === LEGACY_PROJECT_ID);
    const branchesOnLegacy = allBranches.filter(b => (b.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    const profilesOnLegacy = stateService.getBuildProfiles().filter(p => (p.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    const infraOnLegacy = stateService.getInfraServices().filter(s => (s.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID);
    // PR #498 review (2026-04-26): a non-empty customEnv['default']
    // scope is also "real data" — silently dropping it would lose
    // user secrets. The rename-default flow is what migrates these
    // values; this cleanup endpoint only removes empty placeholders.
    const rawEnvForCheck = stateService.getCustomEnvRaw?.() || {};
    const legacyEnvKeyCount = Object.keys(rawEnvForCheck[LEGACY_PROJECT_ID] || {}).length;

    if (hasLegacyProject || branchesOnLegacy.length > 0 || profilesOnLegacy.length > 0 || infraOnLegacy.length > 0 || legacyEnvKeyCount > 0) {
      res.status(409).json({
        error: 'not_residual',
        message: 'default 项目仍有真实数据,请先走「迁移 →」,不要使用本接口。',
        counts: {
          hasLegacyProject,
          branches: branchesOnLegacy.length,
          buildProfiles: profilesOnLegacy.length,
          infraServices: infraOnLegacy.length,
          customEnvKeys: legacyEnvKeyCount,
        },
      });
      return;
    }

    const actions: string[] = [];

    // 1) Filesystem: remove the empty `<base>/default/` directory. If
    // it somehow isn't empty (future bug), bail out — do NOT recurse
    // through user data silently.
    const legacyDir = path.posix.join(worktreeBase, LEGACY_PROJECT_ID);
    if (fs.existsSync(legacyDir)) {
      try {
        const entries = fs.readdirSync(legacyDir);
        if (entries.length === 0) {
          fs.rmdirSync(legacyDir);
          actions.push(`removed empty dir ${legacyDir}`);
        } else {
          res.status(409).json({
            error: 'dir_not_empty',
            message: `残留目录 ${legacyDir} 非空 (${entries.length} 项),拒绝自动删除。请手动检查。`,
            entries: entries.slice(0, 20),
          });
          return;
        }
      } catch (err) {
        res.status(500).json({
          error: 'rmdir_failed',
          message: `删除 ${legacyDir} 失败: ${(err as Error).message}`,
        });
        return;
      }
    }

    // 2) State: drop any lingering `default` customEnv scope. The
    // rename-default flow already migrates its contents; anything left
    // here is empty placeholder noise.
    const rawEnv = stateService.getCustomEnvRaw?.() || {};
    if (rawEnv[LEGACY_PROJECT_ID]) {
      stateService.dropCustomEnvScope?.(LEGACY_PROJECT_ID);
      actions.push(`dropped customEnv scope "${LEGACY_PROJECT_ID}"`);
    }

    stateService.save();

    res.json({
      cleaned: true,
      actions,
      message: actions.length > 0
        ? `已清理 ${actions.length} 项残留。`
        : '已经是干净状态,无需清理。',
    });
  });

  router.post('/legacy-cleanup/rename-default', async (req, res) => {
    const { newId, newName } = (req.body || {}) as { newId?: string; newName?: string };
    const normalizedId = String(newId || '').trim().toLowerCase();
    if (!normalizedId) {
      res.status(400).json({ error: '必须提供 newId' });
      return;
    }
    if (normalizedId === LEGACY_PROJECT_ID) {
      res.status(400).json({ error: 'newId 不能还是 default' });
      return;
    }
    if (!SLUG_REGEX.test(normalizedId)) {
      res.status(400).json({ error: 'newId 只能包含小写字母、数字、短横线，且不能以短横线开头/结尾' });
      return;
    }
    if ((stateService.getProjects?.() || []).some(p => p.id === normalizedId)) {
      res.status(409).json({ error: `项目 id "${normalizedId}" 已存在` });
      return;
    }

    // 先自动拍一份快照（破坏性操作前）
    const snapshot = stateService.createConfigSnapshot({
      trigger: 'pre-destructive',
      label: `迁移遗留 default → ${normalizedId} 前`,
      projectId: LEGACY_PROJECT_ID,
    });

    const stats: Record<string, number> = { branches: 0, profiles: 0, infra: 0, envScopes: 0 };

    // 1) branches
    for (const b of stateService.getAllBranches()) {
      if ((b.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID) {
        b.projectId = normalizedId;
        stats.branches++;
      }
    }

    // 2) profiles
    for (const p of stateService.getBuildProfiles()) {
      if ((p.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID) {
        p.projectId = normalizedId;
        stats.profiles++;
      }
    }

    // 3) infra
    for (const s of stateService.getInfraServices()) {
      if ((s.projectId || LEGACY_PROJECT_ID) === LEGACY_PROJECT_ID) {
        s.projectId = normalizedId;
        stats.infra++;
      }
    }

    // 4) projects
    const projects = stateService.getProjects?.() || [];
    const defaultProj = projects.find(p => p.id === LEGACY_PROJECT_ID);
    if (defaultProj) {
      defaultProj.id = normalizedId;
      if (newName && typeof newName === 'string') defaultProj.name = newName.trim();
      // 清 legacyFlag —— 迁移后不再是 legacy
      defaultProj.legacyFlag = false;
    } else {
      // 没有 Project 记录但有资源（pre-P4），直接新建一个最小记录
      stateService.addProject?.({
        id: normalizedId,
        name: newName?.trim() || normalizedId,
        slug: normalizedId,
        kind: 'manual',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // 5) customEnv scope —— 只迁移"default" scope 本身的变量，不含 global
    const rawEnv = stateService.getCustomEnvRaw?.() || {};
    const legacyScope = rawEnv[LEGACY_PROJECT_ID] || {};
    for (const [k, v] of Object.entries(legacyScope)) {
      stateService.setCustomEnvVar(k, v, normalizedId);
      stats.envScopes++;
    }
    stateService.dropCustomEnvScope?.(LEGACY_PROJECT_ID);

    stateService.save();

    // 6) worktree 物理目录迁移（symlink 最快 + reversible）
    const oldDir = path.posix.join(worktreeBase, LEGACY_PROJECT_ID);
    const newDir = path.posix.join(worktreeBase, normalizedId);
    let worktreeMoveResult = 'skipped (目录不存在)';
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      try {
        // 先尝试重命名（同文件系统原子）
        fs.renameSync(oldDir, newDir);
        worktreeMoveResult = 'renamed';
        // 同时重写 state 里的 branch.worktreePath
        for (const b of stateService.getAllBranches()) {
          if (b.worktreePath && b.worktreePath.startsWith(oldDir + '/')) {
            b.worktreePath = b.worktreePath.replace(oldDir + '/', newDir + '/');
          }
        }
        stateService.save();
      } catch (err) {
        // 跨文件系统或权限问题：退化到 symlink（不阻断迁移）
        try {
          fs.symlinkSync(oldDir, newDir, 'dir');
          worktreeMoveResult = 'symlinked (rename failed: ' + (err as Error).message + ')';
        } catch (err2) {
          worktreeMoveResult = 'failed: ' + (err2 as Error).message;
        }
      }
    } else if (fs.existsSync(newDir)) {
      worktreeMoveResult = 'skipped (目标已存在)';
    }

    stateService.recordDestructiveOp({
      type: 'other',
      snapshotId: snapshot.id,
      summary: `遗留 default 项目迁移为 "${normalizedId}"（${stats.branches} 分支 / ${stats.profiles} profile / ${stats.infra} infra）`,
    });

    res.json({
      migrated: true,
      from: LEGACY_PROJECT_ID,
      to: normalizedId,
      stats,
      worktreeMove: worktreeMoveResult,
      snapshotId: snapshot.id,
      message: `已将 default 项目迁移为「${normalizedId}」。如有异常可在「历史版本」里回滚。`,
    });
  });

  return router;
}
