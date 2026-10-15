import { withShellExecutionContext } from './shell-executor.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecOptions, IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';
import { StateService } from './state.js';
import { computePreviewSlug, slugifyForPreview } from './preview-slug.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';
import { fetchWithLockRetry } from './git-fetch-retry.js';
import { readWorktreeDirectoryIdentity, sameWorktreeDirectoryIdentity, worktreePathActivity, WorktreePathActivity } from './worktree-path-activity.js';

// 同一控制进程/规范repoRoot共用；元数据清理未知时复用现有活动围栏，不放行后继写入。
const repositoryMutations = new Map<string, Promise<void>>();
const repositoryMutationActivity = new WorktreePathActivity();
async function withRepositoryMutation<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = await fs.promises.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const previous = repositoryMutations.get(key) ?? Promise.resolve();
  const running = previous.then(() => repositoryMutationActivity.run([key], operation));
  const settled = running.then(() => undefined, () => undefined);
  repositoryMutations.set(key, settled);
  try { return await running; }
  finally { if (repositoryMutations.get(key) === settled) repositoryMutations.delete(key); }
}

/**
 * Current worktree layout version. See `CdsState.worktreeLayoutVersion`
 * and `WorktreeService.migrateFlatLayoutIfNeeded()` for the migration
 * story.
 */
export const CURRENT_WORKTREE_LAYOUT_VERSION = 2;

/** Project id attributed to orphan worktrees discovered during the flat→nested migration. */
export const LEGACY_PROJECT_ID = 'default';

export type DeploymentSourcePreparationErrorCode =
  | 'invalid-branch-ref'
  | 'deployment-worktree-unavailable'
  | 'deployment-worktree-recovery-failed';

/** 部署源码准备失败的稳定分类，避免把 cwd 缺失误报成非法分支。 */
export class DeploymentSourcePreparationError extends Error {
  constructor(
    readonly code: DeploymentSourcePreparationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentSourcePreparationError';
  }
}

/**
 * WorktreeService — thin wrapper around `git worktree` for building
 * isolated checkouts of a single repository.
 *
 * ── P4 Part 18 (G1) ─────────────────────────────────────────────
 * Previously this class held a single `_repoRoot` field, set in the
 * constructor and rarely mutated. That worked fine when CDS managed
 * exactly one Git repository bind-mounted at `config.repoRoot`, but
 * the multi-project clone flow (`.cds/repos/<projectId>`) needs the
 * repo root to vary per call. Keeping it as instance state would
 * introduce race conditions between concurrent deploys from
 * different projects.
 *
 * The fix is stateless: every method that touches `git` takes
 * `repoRoot` as its first argument, and callers resolve the right
 * root via `StateService.getProjectRepoRoot(projectId, fallback)`.
 * `pull()` is the one exception — it already uses `targetDir` (the
 * worktree itself) as its `cwd`, so it doesn't need a separate
 * repoRoot at all.
 *
 * The proxy auto-build path, the bootstrap main-branch path, and
 * all executor routes still operate on a single repo — they pass
 * `config.repoRoot` directly, preserving the legacy single-repo
 * behavior for users who haven't yet adopted multi-project.
 *
 * ── FU-04 — per-project worktree subdirectory ─────────────────
 * Worktree paths used to be `<base>/<slug>`. When two projects
 * shared a branch name (e.g. every project has a "main" / "master")
 * their worktrees collided in the flat layout. Since FU-04 every
 * worktree lives at `<base>/<projectId>/<slug>`; the bootstrap and
 * deploy paths always call `WorktreeService.worktreePathFor()`
 * rather than interpolating the slug directly.
 *
 * Legacy installs have flat worktrees at `<base>/<slug>`. On first
 * boot after the upgrade, `migrateFlatLayoutIfNeeded()` scans the
 * base for those orphan entries and adopts them into the `default`
 * project slot. We prefer **symlinks** over `fs.renameSync` because:
 *
 *   1. Symlinking is instant — no byte copy even across huge
 *      worktrees.
 *   2. It is reversible — deleting the symlink leaves the original
 *      tree untouched if we ever need to roll back.
 *   3. Git treats the symlinked worktree as identical to the
 *      original (same inode), so running containers that bind-mount
 *      the legacy path keep working during the upgrade window.
 *
 * The fallback to `fs.renameSync` is for platforms where symlinks
 * are unavailable or forbidden (Windows without developer-mode, or
 * cross-filesystem moves where the symlink target would be
 * unreachable). Rename is still same-filesystem O(1) on ext4/APFS,
 * so the degraded path is acceptable.
 */
export class WorktreeService {
  private gitEnvProvider?: (repoRoot: string) => Promise<ExecOptions['env'] | undefined>;

  constructor(
    private readonly shell: IShellExecutor,
    gitEnvProvider?: ((repoRoot: string) => Promise<ExecOptions['env'] | undefined>) | string,
  ) {
    this.gitEnvProvider = typeof gitEnvProvider === 'function' ? gitEnvProvider : undefined;
  }

  setGitEnvProvider(provider: (repoRoot: string) => Promise<ExecOptions['env'] | undefined>): void {
    this.gitEnvProvider = provider;
  }

  /**
   * Canonical worktree path for a given (project, branch slug) pair.
   *
   * FU-04 — the `<base>/<projectId>/<slug>` nesting guarantees that
   * two projects sharing a branch name don't clobber each other.
   * `projectId` is forced to `LEGACY_PROJECT_ID` when the caller
   * passes undefined/empty so the helper is safe to use from the
   * pre-P4 code paths that don't thread projectId.
   */
  static worktreePathFor(base: string, projectId: string | undefined | null, branchSlug: string): string {
    const effectiveProjectId = projectId && projectId.trim() ? projectId : LEGACY_PROJECT_ID;
    return path.posix.join(base, effectiveProjectId, branchSlug);
  }

  /**
   * One-shot flat→nested layout migration.
   *
   * Called once at boot (idempotent). For every direct child of
   * `worktreeBase` that looks like a legacy worktree (a directory or
   * existing symlink whose name is NOT a known project id), we:
   *
   *   1. Create `<base>/default/` if it doesn't exist.
   *   2. Symlink `<base>/default/<slug>` → `<base>/<slug>` (absolute
   *      target so the link resolves correctly even when the working
   *      directory changes).
   *   3. Update every BranchEntry whose `worktreePath ===
   *      <base>/<slug>` to point at the new nested path.
   *
   * Falls back to `fs.renameSync` if `fs.symlinkSync` throws (Windows
   * without dev-mode, EPERM, cross-device). In that case the legacy
   * path is no longer usable after migration, but state.json has
   * already been rewritten so nothing stale points at it.
   *
   * Returns the number of legacy entries migrated. `0` means nothing
   * to do (either a fresh install or a previous boot already ran
   * the migration).
   */
  static migrateFlatLayoutIfNeeded(params: {
    worktreeBase: string;
    projectIds: string[];
    branches: Array<{ id: string; projectId?: string; worktreePath: string }>;
    currentVersion: number | undefined;
    updateBranchWorktreePath: (branchId: string, nextPath: string) => void;
    markMigrated: (version: number) => void;
  }): number {
    const { worktreeBase, projectIds, branches, currentVersion, updateBranchWorktreePath, markMigrated } = params;

    if ((currentVersion ?? 1) >= CURRENT_WORKTREE_LAYOUT_VERSION) {
      return 0; // already migrated
    }

    // Treat an unreadable / missing base as "nothing to migrate" —
    // fresh installs hit this branch and we simply stamp the version.
    if (!fs.existsSync(worktreeBase)) {
      markMigrated(CURRENT_WORKTREE_LAYOUT_VERSION);
      return 0;
    }

    const legacyDir = path.posix.join(worktreeBase, LEGACY_PROJECT_ID);
    const knownProjectIds = new Set<string>(projectIds);
    // The legacy bucket itself is always reserved — if it already
    // exists (e.g. someone ran a partial migration by hand) it's a
    // directory, not a worktree, and we must not recurse into it.
    knownProjectIds.add(LEGACY_PROJECT_ID);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(worktreeBase, { withFileTypes: true });
    } catch {
      // Permission error etc. — leave the version stamp alone so we
      // retry next boot.
      return 0;
    }

    // Map every legacy slug → its existing absolute path so the
    // BranchEntry sweep below can rewrite matching worktreePath
    // values in one pass.
    const legacyByPath = new Map<string, string>(); // absolute legacy path → slug
    const migratedSlugs: string[] = [];

    for (const entry of entries) {
      // Skip anything that isn't a top-level dir/symlink (regular
      // files are noise, skip them silently).
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      // Skip known project buckets — those are already nested-layout.
      if (knownProjectIds.has(entry.name)) continue;

      const legacyAbs = path.posix.join(worktreeBase, entry.name);
      legacyByPath.set(legacyAbs, entry.name);

      const nestedAbs = path.posix.join(legacyDir, entry.name);

      // Ensure the `<base>/default/` bucket exists before the first
      // symlink. Creating it eagerly before the loop would spray an
      // empty directory on clean installs that have no legacy data.
      try {
        fs.mkdirSync(legacyDir, { recursive: true });
      } catch {
        /* best effort — mkdir failure propagates via the symlink below */
      }

      // If something already exists at the nested path (unlikely but
      // possible if a previous migration run was interrupted after
      // creating the link but before bumping the version marker),
      // skip — it already points where we want.
      if (fs.existsSync(nestedAbs) || isSymlink(nestedAbs)) {
        migratedSlugs.push(entry.name);
        continue;
      }

      try {
        fs.symlinkSync(legacyAbs, nestedAbs, 'dir');
        migratedSlugs.push(entry.name);
      } catch {
        // Symlink unavailable (Windows, cross-device, etc.) — rename instead.
        try {
          fs.renameSync(legacyAbs, nestedAbs);
          // After rename, legacyAbs is gone, so drop from the map
          // before the branch rewrite sweep.
          legacyByPath.delete(legacyAbs);
          legacyByPath.set(nestedAbs, entry.name);
          migratedSlugs.push(entry.name);
        } catch {
          // Couldn't migrate this one entry — leave it alone and keep
          // going; state.json stamp below is intentionally skipped
          // in that case so we retry next boot.
          continue;
        }
      }
    }

    // Rewrite matching BranchEntry.worktreePath values so future
    // deploys / pulls / removes hit the nested location.
    for (const branch of branches) {
      const existing = path.posix.normalize(branch.worktreePath);
      const slug = legacyByPath.get(existing);
      if (!slug) continue;
      const nested = path.posix.join(legacyDir, slug);
      updateBranchWorktreePath(branch.id, nested);
    }

    markMigrated(CURRENT_WORKTREE_LAYOUT_VERSION);
    return migratedSlugs.length;
  }

  /**
   * git fetch with lock-aware retry —— 实现见 ./git-fetch-retry.ts。
   *
   * 实测背景（2026-05-06）：PR #526 push 触发 webhook deploy 接连两次
   * 撞 lock。增加退避重试后 race 消失。Bugbot 2026-05-06 e0f66dce 反馈
   * SSE broadcast 路径也要同样语义,故抽出共享 helper,这里只是 thin wrapper
   * 保留方法名兼容旧 call site。
   */
  private async fetchWithLockRetry(
    cwd: string,
    branch: string,
    maxAttempts = 3,
    repoRoot = cwd,
  ): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    const env = await this.gitEnvProvider?.(cwd);
    return withRepositoryMutation(repoRoot, () => fetchWithLockRetry(this.shell, cwd, branch, { maxAttempts, env }));
  }

  /** Resolve a new unpinned request from the actual remote, without resetting any serving worktree. */
  async resolveLatestRemoteHead(repoRoot: string, branch: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<string> {
    if (!isSafeGitRef(branch) || branch.startsWith('refs/')) throw new Error('远端分支名称无效');
    const deadline = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted(); assertCurrent?.();
    const read = async () => {
      const env = await this.gitEnvProvider?.(repoRoot);
      combined.throwIfAborted(); assertCurrent?.();
      const ref = `refs/heads/${branch}`;
      const quoted = "'" + ref.replace(/'/g, "'\"'\"'") + "'";
      const result = await this.shell.exec(`git ls-remote --exit-code --refs origin ${quoted}`, {
        cwd: repoRoot, env, signal: combined, timeout: 15_000,
      });
      combined.throwIfAborted(); assertCurrent?.();
      if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 4096) throw new Error('无法确认远端最新提交');
      const rows = result.stdout.trim().split(/\r?\n/);
      const match = rows.length === 1 ? /^([a-f0-9]{40})\s+(\S+)$/i.exec(rows[0]) : null;
      if (!match || match[2] !== ref) throw new Error('远端最新提交身份缺失或不唯一');
      return match[1].toLowerCase();
    };
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('远端最新提交读取已取消或超时')); };
      const cleanup = () => combined.removeEventListener('abort', abort);
      combined.addEventListener('abort', abort, { once: true });
      void read().then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }

  async create(repoRoot: string, branch: string, targetDir: string): Promise<void> {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      await this.createManagedWorktree(repoRoot, branch, targetDir);
    });
  }

  /** 调用方已持有 targetDir 活动锁时复用，避免恢复路径二次获取同一把锁。 */
  private async createManagedWorktree(repoRoot: string, branch: string, targetDir: string): Promise<void> {
    const fetchResult = await this.fetchWithLockRetry(repoRoot, branch);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`拉取分支 "${branch}" 失败:\n${combinedOutput(fetchResult)}`);
    }

    await withRepositoryMutation(repoRoot, async () => {
      // Always prune stale worktree references before creating a new one.
      // This handles the case where git has a registered worktree whose
      // directory no longer exists (e.g. after a crash or manual rm).
      await this.shell.exec('git worktree prune', { cwd: repoRoot });

      // Remove leftover directory if it still exists
      const checkDir = await this.shell.exec(`test -d "${targetDir}" && echo exists`);
      if (checkDir.stdout.trim() === 'exists') {
        await this.shell.exec(`rm -rf "${targetDir}"`);
      }

      const addCommand = `git worktree add "${targetDir}" "origin/${branch}"`;
      let addResult = await this.shell.exec(addCommand, { cwd: repoRoot });
      if (addResult.exitCode !== 0 && isMissingRegisteredWorktreeError(addResult)) {
        await this.shell.exec('git worktree prune', { cwd: repoRoot });
        addResult = await this.shell.exec(addCommand, { cwd: repoRoot });
      }
      if (addResult.exitCode !== 0) {
        throw new Error(`创建工作树 "${branch}" 失败:\n${combinedOutput(addResult)}`);
      }
    });
  }

  private async ensureDeploymentWorktree(
    repoRoot: string,
    branch: string,
    targetDir: string,
  ): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    const usable = await this.shell.exec('git rev-parse HEAD', { cwd: targetDir });
    if (usable.exitCode === 0 && /^[0-9a-f]{7,40}$/i.test(usable.stdout.trim())) return usable;

    let targetExists = true;
    try {
      await fs.promises.lstat(targetDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') targetExists = false;
      else {
        throw new DeploymentSourcePreparationError(
          'deployment-worktree-unavailable',
          '部署工作树不可访问，请检查目录权限后重试',
        );
      }
    }

    // 已存在但不是本仓库登记的 worktree 时禁止删除，避免恢复流程误伤外部目录。
    if (targetExists) {
      const listed = await this.shell.exec('git -c core.quotePath=false worktree list --porcelain', { cwd: repoRoot });
      const registered = new Set(listed.exitCode === 0 ? listed.stdout.split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => path.resolve(line.slice('worktree '.length).trim()))
        : []);
      let removedLegacyAlias = false;
      if (!registered.has(path.resolve(targetDir))) {
        try {
          // FU-04 只产生 default/<slug> -> ../<slug>；不跟随未知链接目标核实归属。
          const alias = await readWorktreeDirectoryIdentity(targetDir, false);
          const parent = path.dirname(path.resolve(targetDir)), base = path.dirname(parent), slug = path.basename(targetDir);
          const realBase = await fs.promises.realpath(base), flat = path.join(base, slug);
          if (alias?.entry.link && path.basename(parent) === LEGACY_PROJECT_ID
            && alias.entryPath === path.join(realBase, LEGACY_PROJECT_ID, slug)
            && path.resolve(parent, alias.entry.link) === flat && registered.has(path.join(realBase, slug))) {
            const current = await readWorktreeDirectoryIdentity(targetDir, false);
            if (current && sameWorktreeDirectoryIdentity(alias, current)) {
              let missing = false;
              try { fs.lstatSync(flat); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; }
              // 同一进程内不在缺失确认与 unlink 之间让出；只移除别名，不删除/遍历其目标。
              if (missing) { fs.unlinkSync(targetDir); removedLegacyAlias = true; }
            }
          }
        } catch { /* 无法证明精确归属或安全移除时，保留原对象并按陌生目录拒绝。 */ }
      }
      if (!registered.has(path.resolve(targetDir)) && !removedLegacyAlias) {
        throw new DeploymentSourcePreparationError(
          'deployment-worktree-unavailable',
          '部署工作树不可用，且该目录不属于当前仓库的受管工作树，已拒绝自动清理',
        );
      }
    }

    try {
      await this.createManagedWorktree(repoRoot, branch, targetDir);
    } catch (error) {
      throw new DeploymentSourcePreparationError(
        'deployment-worktree-recovery-failed',
        `部署工作树恢复失败: ${(error as Error).message}`,
      );
    }

    const recovered = await this.shell.exec('git rev-parse HEAD', { cwd: targetDir });
    if (recovered.exitCode !== 0 || !/^[0-9a-f]{7,40}$/i.test(recovered.stdout.trim())) {
      throw new DeploymentSourcePreparationError(
        'deployment-worktree-recovery-failed',
        '部署工作树恢复后仍不可用，已停止部署',
      );
    }
    return recovered;
  }

  /** Pull latest code for an existing worktree.
   *  Returns { head, before, after, afterFull, updated } so caller can detect "already up to date".
   *  `after` 是短 SHA（rev-parse --short），`afterFull` 是**完整 40 位 SHA**（rev-parse HEAD）——
   *  刷新 githubCommitSha 必须用 afterFull，该字段被 GitHub check-run / release / acceptance
   *  元数据 / OperationLog.commitSha（类型注释要求全 SHA）复用，截断成短 SHA 会让外部集成指向
   *  歧义 revision（Codex P2）。
   *
   *  NOTE: `pull` does not need `repoRoot` because every git command
   *  runs inside `targetDir` (the worktree itself) rather than the
   *  host repo root. The optional cancellation signal belongs to the operation, not repository identity. */
  async pull(branch: string, targetDir: string, signal?: AbortSignal): Promise<{ head: string; before: string; after: string; afterFull: string; updated: boolean }> {
    return withShellExecutionContext({ signal, priority: 'delivery' }, () => this.pullInternal(branch, targetDir));
  }

  private async pullInternal(branch: string, targetDir: string): Promise<{ head: string; before: string; after: string; afterFull: string; updated: boolean }> {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
    // Get current SHA before pull
    const beforeResult = await this.shell.exec(
      'git rev-parse --short HEAD',
      { cwd: targetDir },
    );
    const before = beforeResult.stdout.trim();

      // Fetch latest from remote (lock-aware retry, 见 fetchWithLockRetry 注释)
      const fetchResult = await this.fetchWithLockRetry(targetDir, branch);
      if (fetchResult.exitCode !== 0) {
        throw new Error(`拉取失败:\n${combinedOutput(fetchResult)}`);
      }

      // Hard reset worktree to latest remote HEAD
      const resetResult = await this.shell.exec(
        `git reset --hard origin/${branch}`,
        { cwd: targetDir },
      );
      if (resetResult.exitCode !== 0) {
        throw new Error(`重置失败:\n${combinedOutput(resetResult)}`);
      }

      // Get new SHA after pull（短 + 全 两种：短给日志/比对，全给需要落库的 githubCommitSha）
      const afterResult = await this.shell.exec(
        'git rev-parse --short HEAD',
        { cwd: targetDir },
      );
      const after = afterResult.stdout.trim();
      const afterFullResult = await this.shell.exec(
        'git rev-parse HEAD',
        { cwd: targetDir },
      );
      const afterFull = afterFullResult.stdout.trim();

      // Return short log of HEAD for confirmation
      const logResult = await this.shell.exec(
        'git log --oneline -1',
        { cwd: targetDir },
      );
      return { head: logResult.stdout.trim(), before, after, afterFull, updated: before !== after };
    });
  }

  static deploymentSourceRootFor(targetDir: string): string {
    return path.join(path.dirname(targetDir), '.deployment-sources', path.basename(targetDir));
  }

  /** 准备本次部署专用的源码目录，不 reset 已运行容器可能挂载的旧目录。 */
  async prepareDeploymentSource(repoRoot: string, branch: string, targetDir: string, commitSha?: string, signal?: AbortSignal): Promise<{
    head: string; before: string; after: string; afterFull: string; updated: boolean; sourcePath: string;
  }> {
    return withShellExecutionContext({ signal }, () => worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      if (commitSha !== undefined && !/^[0-9a-f]{7,40}$/i.test(commitSha)) throw new Error('目标提交必须是有效的 Git SHA');
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      // 分支格式只依赖 Git 语法，不应依赖可能被 LRU 回收的分支工作树。
      const valid = await this.shell.exec(`git check-ref-format --branch ${quote(branch)}`);
      if (valid.exitCode !== 0) {
        throw new DeploymentSourcePreparationError('invalid-branch-ref', '无法准备非法分支的部署源码');
      }
      const before = await this.ensureDeploymentWorktree(repoRoot, branch, targetDir);
      const fetched = await this.fetchWithLockRetry(targetDir, branch, 3, repoRoot);
      if (fetched.exitCode !== 0) throw new Error(`部署源码拉取失败:\n${combinedOutput(fetched)}`);
      const ref = commitSha || `origin/${branch}`;
      const resolve = () => this.shell.exec(`git rev-parse --verify ${quote(`${ref}^{commit}`)}`, { cwd: targetDir });
      let resolved = await resolve();
      // 浅克隆或已前进的分支可能不含旧提交；全长身份可向原仓库精确取回，不能退到 HEAD。
      if (resolved.exitCode !== 0 && commitSha?.length === 40) {
        const targeted = await this.fetchWithLockRetry(targetDir, commitSha, 3, repoRoot);
        if (targeted.exitCode === 0) resolved = await resolve();
      }
      const sha = resolved.stdout.trim().toLowerCase();
      if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('目标提交不可用，请确认完整提交及仓库访问权限');
      const sourceRoot = WorktreeService.deploymentSourceRootFor(targetDir);
      fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      const sourcePath = path.join(sourceRoot, randomUUID());
      const added = await withRepositoryMutation(repoRoot, () => this.shell.exec(`git worktree add --detach ${quote(sourcePath)} ${quote(sha)}`, { cwd: targetDir }));
      if (added.exitCode !== 0) {
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        throw new Error(`部署源码目录准备失败:\n${combinedOutput(added)}`);
      }
      const actual = await this.shell.exec('git rev-parse HEAD', { cwd: sourcePath });
      if (actual.exitCode !== 0 || actual.stdout.trim().toLowerCase() !== sha) {
        await withRepositoryMutation(repoRoot, () => this.shell.exec(`git worktree remove --force ${quote(sourcePath)}`, { cwd: targetDir }));
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        throw new Error('部署源码目录未匹配目标提交，已拒绝执行');
      }
      const log = await this.shell.exec(`git log --oneline -1 ${quote(sha)}`, { cwd: targetDir });
      return { head: log.stdout.trim() || sha, before: before.stdout.trim(), after: sha.slice(0, 7),
        afterFull: sha, updated: before.stdout.trim().toLowerCase() !== sha, sourcePath };
    }, true));
  }

  async remove(repoRoot: string, targetDir: string): Promise<void> {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      const result = await withRepositoryMutation(repoRoot, () => this.shell.exec(
        `git worktree remove --force "${targetDir}"`,
        { cwd: repoRoot },
      ));
      if (result.exitCode !== 0) {
        throw new Error(`删除工作树 "${targetDir}" 失败:\n${combinedOutput(result)}`);
      }
    });
  }

  async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const env = await this.gitEnvProvider?.(repoRoot);
    const result = await this.shell.exec(
      `git ls-remote --heads origin "${branch}"`,
      { cwd: repoRoot, env },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Find a remote branch whose name ends with the given suffix.
   * Returns the full branch name or null.
   */
  async findBranchBySuffix(repoRoot: string, suffix: string): Promise<string | null> {
    const env = await this.gitEnvProvider?.(repoRoot);
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: repoRoot, env },
    );
    if (result.exitCode !== 0) return null;

    const lowerSuffix = suffix.toLowerCase();
    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);

    // Exact match first
    const exact = branches.find(b => b.toLowerCase() === lowerSuffix);
    if (exact) return exact;

    // Suffix match: branch name ends with the suffix
    const suffixMatch = branches.find(b => {
      const lower = b.toLowerCase();
      return lower.endsWith(`/${lowerSuffix}`) || lower.endsWith(`-${lowerSuffix}`);
    });
    return suffixMatch || null;
  }

  /**
   * Find a remote branch whose slugified name matches the given slug.
   * This handles cases where the slug (e.g. "claude-fix-software-defects-dlxzp")
   * was derived from a branch with "/" (e.g. "claude/fix-software-defects-dlxzp").
   */
  async findBranchBySlug(repoRoot: string, slug: string): Promise<string | null> {
    const env = await this.gitEnvProvider?.(repoRoot);
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: repoRoot, env },
    );
    if (result.exitCode !== 0) return null;

    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);

    const lowerSlug = slug.toLowerCase();
    return branches.find(b => StateService.slugify(b) === lowerSlug) || null;
  }

  /**
   * Reverse-map a v1 / v2 / v3 preview-URL slug back to its remote branch name.
   *
   * Use case: subdomain auto-build. Browser hits
   *   https://audio-upload-asr-tgr1f-claude-prd-agent.example.com/
   * The host's leftmost label is the slug, but the actual git ref is
   * `claude/audio-upload-asr-TGR1f` (with `/`, mixed case). Without this
   * reverse mapping the user just sees "远程仓库中未找到分支 ..." even though
   * the ref exists.
   *
   * Three-tier forward match (matches the cascade in proxy.ts resolveBranchEntry):
   *   - v3: `${tail}-${prefix}-${projectSlug}` → computePreviewSlug(branch, p) === slug
   *   - v2: `${projectSlug}-${slugify(branch)}` → projectSlug-prefix slugifies match
   *   - v1: `${slugify(branch)}` → bare slugify (legacy projects)
   *
   * Try every (branch, projectSlug) combo. First exact match wins.
   *
   * Why "forward match" not "reverse parse": parsing a slug back to (prefix,
   * tail, projectSlug) is ambiguous when projectSlug contains hyphens
   * (e.g. `prd-agent` vs branch `audio-upload-asr-tgr1f-claude` — where does
   * project end and branch start?). Computing the canonical slug for each
   * known branch and comparing equality avoids the ambiguity entirely.
   */
  async findBranchByPreviewSlug(
    repoRoot: string,
    slug: string,
    projectSlugs: string[],
  ): Promise<string | null> {
    const env = await this.gitEnvProvider?.(repoRoot);
    const result = await this.shell.exec(
      `git ls-remote --heads origin`,
      { cwd: repoRoot, env },
    );
    if (result.exitCode !== 0) return null;

    const branches = result.stdout.trim().split('\n')
      .map(line => line.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);
    if (branches.length === 0) return null;

    const lowerSlug = slug.toLowerCase();
    const projectSlugsClean = projectSlugs
      .filter(Boolean)
      .map((p) => slugifyForPreview(p))
      .filter(Boolean);

    for (const branch of branches) {
      // v1: bare slugify match (legacy single-project URLs)
      if (StateService.slugify(branch) === lowerSlug) return branch;

      const branchSlug = StateService.slugify(branch);
      for (const ps of projectSlugsClean) {
        // v3: tail-prefix-project (重要的靠前)
        if (computePreviewSlug(branch, ps) === lowerSlug) return branch;
        // v2: project-prefix-tail (legacy multi-project URL外发期)
        if (`${ps}-${branchSlug}` === lowerSlug) return branch;
      }
    }
    return null;
  }
}

/** Treat a broken symlink as "something exists" — avoids recreating
 *  a link on top of itself when the target was manually deleted but
 *  the link entry survived. */
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isMissingRegisteredWorktreeError(result: Awaited<ReturnType<IShellExecutor['exec']>>): boolean {
  return /missing but already registered worktree/i.test(combinedOutput(result));
}
