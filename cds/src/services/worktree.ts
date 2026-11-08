import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BuildProfile, ExecOptions, IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';
import { StateService } from './state.js';
import { computePreviewSlug, slugifyForPreview } from './preview-slug.js';
import { fetchWithLockRetry } from './git-fetch-retry.js';
import { readWorktreeDirectoryIdentity, sameWorktreeDirectoryIdentity, worktreePathActivity, WorktreePathActivity } from './worktree-path-activity.js';
import { hasDatabaseInitializationSource } from './stack-detector.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';
import { CODE_REVIEW_ZIP_LIMITS, shouldIncludeCodeReviewPath } from './code-review-source.js';

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

/** 仅应用已在镜像内且没有宿主文件依赖时，部署无需物化源码。 */
export function deploymentNeedsSourceCheckout(profiles: readonly BuildProfile[]): boolean {
  return profiles.length === 0 || profiles.some(p => !p.prebuiltImage
    || !!p.managedBuild || !!p.localArtifact || p.cacheMounts?.some(m => m.kind !== 'volume'));
}

export function hasDeploymentSource(value: object): value is { sourcePath: string; afterFull: string } {
  const source = value as {sourcePath?: unknown; afterFull?: unknown};
  return typeof source.sourcePath === 'string' && typeof source.afterFull === 'string';
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

/** 只由部署入口的配置与分支台账提供；外部路径缺失时不能借旧登记自动重建。 */
export type DeploymentSourceRecoveryPolicy =
  | { kind: 'existing-only' }
  | { kind: 'managed-missing'; worktreeBase: string; projectId?: string | null; branchId: string; assertCurrent?: () => void };

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

const deploymentWorktreeRecoveries = new Map<string, Promise<Awaited<ReturnType<IShellExecutor['exec']>>>>();

function canonicalRecoveryPath(dir: string): string {
  let current = path.resolve(dir);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); }
    catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw new DeploymentSourcePreparationError(
        'deployment-worktree-unavailable', '部署工作树未自动恢复，原目录已保留，请检查工作目录后重试');
      missing.unshift(path.basename(current)); current = parent;
    }
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
  private readonly remoteHeadTimeoutMs: number;

  constructor(
    private readonly shell: IShellExecutor,
    gitEnvProvider?: ((repoRoot: string) => Promise<ExecOptions['env'] | undefined>) | string,
    options: { remoteHeadTimeoutMs?: number } = {},
  ) {
    const budget = options.remoteHeadTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60_000) throw new Error('远端提交读取预算必须为1至60000毫秒');
    this.remoteHeadTimeoutMs = budget;
    this.gitEnvProvider = typeof gitEnvProvider === 'function' ? gitEnvProvider : undefined;
  }

  setGitEnvProvider(provider: (repoRoot: string) => Promise<ExecOptions['env'] | undefined>): void {
    this.gitEnvProvider = provider;
  }

  /** Capture committed source without checkout/reset or running project scripts. */
  async exportCodeReviewSnapshot(repoRoot: string, branch: string, excludePatterns: string[], control: {
    signal: AbortSignal; assertCurrent: () => void;
  }): Promise<{ zip: Buffer; commitSha: string; skippedFiles: number }> {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const assertCurrent = () => { control.signal.throwIfAborted(); control.assertCurrent(); };
    if (!this.shell.execBackgroundObservation) throw new Error('当前实例缺少仓库读取执行器');
    const observe = async (command: string, stdin?: string): Promise<string> => {
      assertCurrent(); let output = ''; let bytes = 0;
      const result = await this.shell.execBackgroundObservation!(command, { cwd: repoRoot, timeout: 45_000,
        signal: control.signal, beforeStart: assertCurrent, captureOutput: false, stdin,
        onData: (chunk, channel) => { bytes += Buffer.byteLength(chunk); if (bytes > 16 * 1024 * 1024) throw new Error('仓库目录超过读取上限'); if (channel !== 'stderr') output += chunk; } });
      assertCurrent(); if (result.exitCode !== 0) throw new Error('CDS 分支源码读取失败，请检查仓库同步与访问权限');
      return output;
    };
    return worktreePathActivity.run([repoRoot], () => withRepositoryMutation(repoRoot, async () => {
      await observe(`git check-ref-format ${quote(`refs/heads/${branch}`)}`);
      const env = await this.gitEnvProvider?.(repoRoot); assertCurrent();
      // An explicit remote-tracking ref avoids both mutable worktrees and FETCH_HEAD races.
      const fetched = await this.shell.exec(`git -c core.hooksPath=/dev/null -c fetch.recurseSubmodules=false fetch origin ${quote(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`, {
        cwd: repoRoot, env, signal: control.signal, beforeStart: assertCurrent, timeout: 60_000,
      });
      assertCurrent(); if (fetched.exitCode !== 0) throw new Error('无法同步所选 CDS 分支，请检查已有仓库授权');
      const commitSha = (await observe(`git rev-parse --verify ${quote(`refs/remotes/origin/${branch}^{commit}`)}`)).trim();
      if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('无法固定 CDS 分支提交');
      const tree = await observe(`git ls-tree -r -l -z ${quote(commitSha)}`);
      if (tree && !tree.endsWith('\0')) throw new Error('仓库目录读取不完整');
      const paths: string[] = []; let skippedFiles = 0;
      for (const row of tree.split('\0').filter(Boolean)) {
        const tab = row.indexOf('\t'); const [mode, type, , size] = row.slice(0, tab).trim().split(/\s+/);
        const name = row.slice(tab + 1);
        if (tab < 0) throw new Error('仓库目录格式无效');
        if (shouldIncludeCodeReviewPath(name, excludePatterns) && mode === '120000') throw new Error('审查范围包含符号链接，请先排除该路径');
        if (type !== 'blob' || !['100644', '100755'].includes(mode) || !shouldIncludeCodeReviewPath(name, excludePatterns)
          || !Number.isSafeInteger(Number(size)) || Number(size) > CODE_REVIEW_ZIP_LIMITS.file) { skippedFiles++; continue; }
        paths.push(name);
      }
      if (!paths.length) throw new Error('所选分支没有符合规则的源码文件');
      if (paths.length > CODE_REVIEW_ZIP_LIMITS.entries || Buffer.byteLength(JSON.stringify(paths)) > 1024 * 1024) throw new Error('所选分支源码数量或路径总长度超过上限');
      const temporary = await fs.promises.mkdtemp(path.join(tmpdir(), 'cds-review-source-'));
      try {
        const target = path.join(temporary, 'source.zip');
        // This trusted platform helper runs in the existing isolated executor.
        // Binary output is bounded before writing and file names never enter shell syntax.
        const script = `const fs=require('node:fs'),cp=require('node:child_process');const paths=JSON.parse(fs.readFileSync(0,'utf8'));const zip=cp.execFileSync('git',['-C',process.argv[1],'archive','--format=zip',process.argv[2],'--',...paths.map(p=>':(literal)'+p)],{maxBuffer:${CODE_REVIEW_ZIP_LIMITS.compressed},timeout:30000});fs.writeFileSync(process.argv[3],zip,{mode:0o600});`;
        await observe([process.execPath, '-e', script, repoRoot, commitSha, target].map(quote).join(' '), JSON.stringify(paths));
        const info = await fs.promises.stat(target); assertCurrent();
        if (info.size > CODE_REVIEW_ZIP_LIMITS.compressed) throw new Error('源码快照超过 100 MiB');
        return { zip: await fs.promises.readFile(target), commitSha, skippedFiles };
      } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
    }), true);
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
    control?: { shell: IShellExecutor; resolveEnv: (provider: () => Promise<ExecOptions['env'] | undefined>) => Promise<ExecOptions['env'] | undefined> },
  ): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    const provider = async () => this.gitEnvProvider?.(cwd);
    const env = control ? await control.resolveEnv(provider) : await provider();
    return withRepositoryMutation(repoRoot, () => fetchWithLockRetry(control?.shell ?? this.shell, cwd, branch, { maxAttempts, env }));
  }

  /** 只准备原 origin 的完整对象；调用者仍须独立证明构建输入等价。 */
  async ensureCommitAvailable(repoRoot: string, fullSha: string, assertCurrent: () => void,
    remainingMs: () => number): Promise<string> {
    if (!repoRoot || !/^[0-9a-f]{40}$/i.test(fullSha) || typeof assertCurrent !== 'function'
      || typeof remainingMs !== 'function') throw new Error('提交对象准备需要明确仓库、完整提交与有效资格');
    assertCurrent();
    if (!this.shell.execOwnedOperation) throw new Error('提交对象准备的归属执行能力不可用');
    const initial = remainingMs();
    if (!Number.isFinite(initial) || initial <= 0) throw new Error('提交对象准备已超时');
    const deadline = performance.now() + initial;
    const check = () => {
      assertCurrent();
      const timeout = Math.floor(Math.min(remainingMs(), deadline - performance.now()));
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('提交对象准备已超时');
      return timeout;
    };
    const qualified: IShellExecutor = { exec: async (command, options) => {
      const timeout = check();
      let cleanupUnknown = false;
      try { return await this.shell.execOwnedOperation!(command, { ...options, timeout,
        beforeStart: () => { options?.beforeStart?.(); check(); } });
      } catch (error) {
        // 未知清理须先进入原mutation围栏，不能被失效资格覆盖。
        cleanupUnknown = (error as { code?: string } | null)?.code === 'cleanup';
        throw error;
      } finally { if (!cleanupUnknown) check(); }
    } };
    const withinBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
      const timeout = check(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('提交对象准备已超时')), timeout);
      })]);
      } finally { clearTimeout(timer); check(); }
    };
    const resolveEnv = async (provider: () => Promise<ExecOptions['env'] | undefined>) => {
      try { return await withinBudget(provider); }
      catch { check(); throw new Error('提交对象认证暂不可用'); }
    };
    const sha = fullSha.toLowerCase();
    const resolve = () => qualified.exec(`git rev-parse --verify '${sha}^{commit}'`, { cwd: repoRoot });
    let resolved = await resolve();
    if (resolved.exitCode !== 0) {
      const fetched = await withinBudget(() => this.fetchWithLockRetry(repoRoot, sha, 1, repoRoot, { shell: qualified, resolveEnv }));
      if (fetched.exitCode === 0) resolved = await resolve();
    }
    check();
    if (resolved.exitCode !== 0 || resolved.stdout.trim().toLowerCase() !== sha) throw new Error('目标提交不可用，请确认完整提交及仓库访问权限');
    return sha;
  }

  /** Resolve a new unpinned request from the actual remote, without resetting any serving worktree. */
  async resolveLatestRemoteHead(repoRoot: string, branch: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<string> {
    if (!isSafeGitRef(branch) || branch.startsWith('refs/')) throw new Error('远端分支名称无效');
    const deadline = AbortSignal.timeout(this.remoteHeadTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted(); assertCurrent?.();
    const read = async () => {
      const env = await this.gitEnvProvider?.(repoRoot);
      combined.throwIfAborted(); assertCurrent?.();
      const ref = `refs/heads/${branch}`;
      const quoted = "'" + ref.replace(/'/g, "'\"'\"'") + "'";
      const result = await this.shell.exec(`git ls-remote --exit-code --refs origin ${quoted}`, {
        cwd: repoRoot, env, signal: combined, timeout: this.remoteHeadTimeoutMs,
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
  private async createManagedWorktree(repoRoot: string, branch: string, targetDir: string,
    cold?: { key: string; assertCurrent: () => void }): Promise<void> {
    let owned: fs.Stats | undefined;
    const check = (): void => {
      if (!cold) return;
      cold.assertCurrent();
      if (canonicalRecoveryPath(targetDir) !== cold.key) throw new Error('冷恢复目录身份已变化');
      let current: fs.Stats | undefined;
      try { current = fs.lstatSync(targetDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (owned ? !current || !current.isDirectory() || current.isSymbolicLink()
        || current.dev !== owned.dev || current.ino !== owned.ino : current) throw new Error('冷恢复目录已被占用');
    };
    const shell: IShellExecutor = !cold ? this.shell : { exec: async (command, options) => {
      let reservedHere = false;
      const qualify = (): void => {
        check();
        if (command.startsWith('git worktree add ') && !owned) {
          fs.mkdirSync(path.dirname(targetDir), { recursive: true });
          fs.mkdirSync(targetDir); // 独占缺失路径；陌生空目录也不能被git add写入。
          owned = fs.lstatSync(targetDir);
          reservedHere = true;
          check();
        }
      };
      qualify();
      let startRejected = false;
      let result: Awaited<ReturnType<IShellExecutor['exec']>>;
      try { result = await this.shell.exec(command, { ...options, beforeStart: () => {
        try { options?.beforeStart?.(); qualify(); }
        catch (error) { startRejected = true; throw error; }
      } }); } catch (error) {
        if (startRejected && reservedHere && owned && (error as { code?: string } | null)?.code !== 'cleanup') {
          try {
            const current = fs.lstatSync(targetDir);
            if (canonicalRecoveryPath(targetDir) === cold!.key && current.isDirectory()
              && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) fs.rmdirSync(targetDir);
          } catch { /* 仅移除本次尚未派发的空预留；陌生、非空及不可核实目录均保留。 */ }
        }
        throw error;
      }
      check(); // cleanup异常直接传播，不能被后到资格错误覆盖掉原repo未知围栏。
      return result;
    } };
    const fetchResult = await this.fetchWithLockRetry(repoRoot, branch, 3, repoRoot, cold ? {
      shell, resolveEnv: async provider => {
        check();
        const env = await provider();
        check();
        return env;
      },
    } : undefined);
    if (fetchResult.exitCode !== 0) {
      throw new Error(`拉取分支 "${branch}" 失败:\n${combinedOutput(fetchResult)}`);
    }

    await withRepositoryMutation(repoRoot, async () => {
      check();
      // Always prune stale worktree references before creating a new one.
      // This handles the case where git has a registered worktree whose
      // directory no longer exists (e.g. after a crash or manual rm).
      await shell.exec('git worktree prune', { cwd: repoRoot });

      // Warm显式create沿用原清理；cold只能操作本次独占的空目录。
      if (!cold) {
        const checkDir = await shell.exec(`test -d "${targetDir}" && echo exists`);
        if (checkDir.stdout.trim() === 'exists') {
          await shell.exec(`rm -rf "${targetDir}"`);
        }
      }

      const addCommand = `git worktree add "${targetDir}" "origin/${branch}"`;
      let addResult = await shell.exec(addCommand, { cwd: repoRoot });
      if (addResult.exitCode !== 0 && isMissingRegisteredWorktreeError(addResult)) {
        await shell.exec('git worktree prune', { cwd: repoRoot });
        addResult = await shell.exec(addCommand, { cwd: repoRoot });
      }
      if (addResult.exitCode !== 0) {
        throw new Error(`创建工作树 "${branch}" 失败:\n${combinedOutput(addResult)}`);
      }
    });
    check();
  }

  private async deploymentWorktreeHead(targetDir: string): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    let root = path.resolve(targetDir);
    try { root = await fs.promises.realpath(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeploymentSourcePreparationError(
        'deployment-worktree-unavailable', '部署工作树不可访问，请检查目录权限后重试');
    }
    // 默认托管目录位于主仓库内；缺少自身.git时不得向上借用父仓库HEAD。别名以真实目录为界。
    return this.shell.exec('git rev-parse HEAD', { cwd: targetDir,
      env: { GIT_CEILING_DIRECTORIES: path.dirname(root) } });
  }

  private async ensureDeploymentWorktree(
    repoRoot: string,
    branch: string,
    targetDir: string,
    recovery: DeploymentSourceRecoveryPolicy,
  ): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    const key = await this.deploymentRecoveryKey(targetDir, recovery);
    const usable = await this.deploymentWorktreeHead(targetDir);
    if (usable.exitCode === 0 && /^[0-9a-f]{7,40}$/i.test(usable.stdout.trim())) return usable;
    // 仅合并同一实际冷路径的恢复；每次调用先独立核对配置身份。
    const pending = deploymentWorktreeRecoveries.get(key);
    if (pending) return pending;
    const pendingRecovery = this.recoverDeploymentWorktree(repoRoot, branch, targetDir, recovery);
    deploymentWorktreeRecoveries.set(key, pendingRecovery);
    try { return await pendingRecovery; }
    finally { if (deploymentWorktreeRecoveries.get(key) === pendingRecovery) deploymentWorktreeRecoveries.delete(key); }
  }

  private async deploymentRecoveryKey(targetDir: string, recovery: DeploymentSourceRecoveryPolicy): Promise<string> {
    const unavailable = () => new DeploymentSourcePreparationError('deployment-worktree-unavailable',
      '部署工作树未自动恢复，原目录已保留，请检查工作目录后重试');
    if (recovery.kind !== 'managed-missing' || recovery.projectId != null && typeof recovery.projectId !== 'string') throw unavailable();
    recovery.assertCurrent?.();
    const projectId = recovery.projectId?.trim() ? recovery.projectId : LEGACY_PROJECT_ID;
    const singleComponent = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && value !== '.' && value !== '..' && !/[\\/]/.test(value);
    if (!singleComponent(projectId) || !singleComponent(recovery.branchId)
      || path.resolve(targetDir) !== path.resolve(WorktreeService.worktreePathFor(recovery.worktreeBase, projectId, recovery.branchId))) throw unavailable();
    const key = canonicalRecoveryPath(targetDir), base = canonicalRecoveryPath(recovery.worktreeBase);
    if (path.dirname(path.dirname(key)) !== base
      || key !== path.resolve(WorktreeService.worktreePathFor(base, projectId, recovery.branchId))) throw unavailable();
    recovery.assertCurrent?.();
    return key;
  }

  private async recoverDeploymentWorktree(
    repoRoot: string,
    branch: string,
    targetDir: string,
    recovery: DeploymentSourceRecoveryPolicy,
  ): Promise<Awaited<ReturnType<IShellExecutor['exec']>>> {
    const usable = await this.deploymentWorktreeHead(targetDir);
    if (usable.exitCode === 0 && /^[0-9a-f]{7,40}$/i.test(usable.stdout.trim())) return usable;
    await this.deploymentRecoveryKey(targetDir, recovery);

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
      if (!removedLegacyAlias) {
        throw new DeploymentSourcePreparationError(
          'deployment-worktree-unavailable',
          '部署工作树已存在但不可用，已保留原目录，请检查并修复后重试',
        );
      }
    }

    try {
      if (recovery.kind === 'managed-missing') recovery.assertCurrent?.();
      const key = await this.deploymentRecoveryKey(targetDir, recovery);
      await this.createManagedWorktree(repoRoot, branch, targetDir, { key,
        assertCurrent: () => { if (recovery.kind === 'managed-missing') recovery.assertCurrent?.(); },
      });
      if (recovery.kind === 'managed-missing') recovery.assertCurrent?.();
    } catch (error) {
      // 未确认清理仍可能写目标，保留原异常给repo及路径两层围栏。
      if ((error as { code?: string } | null)?.code === 'cleanup') throw error;
      throw new DeploymentSourcePreparationError(
        'deployment-worktree-recovery-failed',
        '部署工作树暂时无法恢复，请检查仓库访问与存储状态后重试',
      );
    }

    const recovered = await this.deploymentWorktreeHead(targetDir);
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
   *  host repo root. Kept at the 2-arg signature for that reason. */
  async pull(branch: string, targetDir: string): Promise<{ head: string; before: string; after: string; afterFull: string; updated: boolean }> {
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

  /** Fetch and resolve the exact target without allocating a source checkout. */
  async resolveDeploymentCommit(branch: string, targetDir: string, commitSha?: string, repoRoot?: string,
    recovery: DeploymentSourceRecoveryPolicy = { kind: 'existing-only' }) {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      const { gitCwd: _gitCwd, ...target } = await this.resolveDeploymentTarget(branch, targetDir, commitSha, repoRoot, recovery);
      return target;
    }, true);
  }

  /** A failed/partial tree read retains the exact checkout instead of scanning mutable host source. */
  async needsDatabaseInitializationSource(targetDir: string, commitSha: string, workDirs: readonly string[]): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error('数据库初始化必须绑定完整提交');
    try {
      const tree = await this.shell.exec(`git ls-tree -r -z --name-only ${commitSha}`, { cwd: targetDir, timeout: 30_000 });
      if (tree.exitCode !== 0 || (tree.stdout && !tree.stdout.endsWith('\0'))) return true;
      return hasDatabaseInitializationSource(tree.stdout.split('\0').filter(Boolean), workDirs);
    } catch { return true; }
  }

  private async resolveDeploymentTarget(branch: string, targetDir: string, commitSha: string | undefined,
    repoRoot: string | undefined, recovery: DeploymentSourceRecoveryPolicy) {
    if (commitSha !== undefined && !/^[0-9a-f]{7,40}$/i.test(commitSha)) throw new Error('目标提交必须是有效的 Git SHA');
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    let absent = false;
    try { await fs.promises.lstat(targetDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') absent = true; else throw error; }
    let gitCwd = absent && repoRoot ? repoRoot : targetDir;
    const valid = await this.shell.exec(`git check-ref-format --branch ${quote(branch)}`, { cwd: repoRoot || (absent ? undefined : targetDir) });
    if (valid.exitCode !== 0) throw new DeploymentSourcePreparationError('invalid-branch-ref', '无法准备非法分支的部署源码');
    if (recovery.kind === 'managed-missing') {
      recovery.assertCurrent?.();
      const projectId = recovery.projectId?.trim() ? recovery.projectId : LEGACY_PROJECT_ID;
      const component = (value: unknown): value is string => typeof value === 'string' && value.length > 0
        && value !== '.' && value !== '..' && !/[\\/]/.test(value);
      if (!component(projectId) || !component(recovery.branchId)
        || path.resolve(targetDir) !== path.resolve(WorktreeService.worktreePathFor(recovery.worktreeBase,
          projectId, recovery.branchId))) throw new DeploymentSourcePreparationError(
          'deployment-worktree-unavailable', '部署工作树未自动恢复，原目录已保留，请检查工作目录后重试');
    }
    const before = absent && repoRoot && recovery.kind === 'existing-only'
      ? { exitCode: 1, stdout: '', stderr: '' } : await this.deploymentWorktreeHead(targetDir);
    if (before.exitCode !== 0 || !/^[0-9a-f]{7,40}$/i.test(before.stdout.trim())) {
      const recoveryKey = recovery.kind === 'managed-missing' ? await this.deploymentRecoveryKey(targetDir, recovery) : undefined;
      const listed = absent && repoRoot ? await this.shell.exec('git -c core.quotePath=false worktree list --porcelain', { cwd: repoRoot }) : undefined;
      const registered = listed?.exitCode === 0 && listed.stdout.split('\n').some(line =>
        line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length).trim()) === recoveryKey);
      if (absent && repoRoot && (recovery.kind === 'existing-only' || listed?.exitCode === 0 && !registered)) {
        // main 的显式仓库只读对象路径保留；这一步不创建或恢复 canonical 工作树。
        before.stdout = '';
      } else if (repoRoot && recovery.kind === 'managed-missing') {
        const recovered = await this.ensureDeploymentWorktree(repoRoot, branch, targetDir, recovery);
        before.stdout = recovered.stdout;
      } else {
        throw new DeploymentSourcePreparationError('deployment-worktree-unavailable',
          '部署工作树已存在但不可用，已保留原目录，请检查并修复后重试');
      }
    }
    const ref = commitSha || `origin/${branch}`;
    const resolve = () => this.shell.exec(`git rev-parse --verify ${quote(`${ref}^{commit}`)}`, { cwd: gitCwd });
    let resolved = await resolve();
    // 受理已冻结完整身份，本地精确对象可直接使用；未点名和短SHA仍刷新远端。
    const localExact = commitSha?.length === 40 && resolved.exitCode === 0
      && resolved.stdout.trim().toLowerCase() === commitSha.toLowerCase();
    if (!localExact) {
      const fetched = await this.fetchWithLockRetry(gitCwd, branch, 3, repoRoot || gitCwd);
      if (fetched.exitCode !== 0) throw new Error(`部署源码拉取失败:\n${combinedOutput(fetched)}`);
      resolved = await resolve();
    }
    if (resolved.exitCode !== 0 && commitSha?.length === 40) {
      const targeted = await this.fetchWithLockRetry(gitCwd, commitSha, 3, repoRoot || gitCwd);
      if (targeted.exitCode === 0) resolved = await resolve();
    }
    const sha = resolved.stdout.trim().toLowerCase();
    if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)
      || (commitSha?.length === 40 && sha !== commitSha.toLowerCase())) throw new Error('目标提交不可用，请确认完整提交及仓库访问权限');
    const log = await this.shell.exec(`git log --oneline -1 ${quote(sha)}`, { cwd: gitCwd });
    return { gitCwd, head: log.stdout.trim() || sha, before: before.stdout.trim(), after: sha.slice(0, 7),
      afterFull: sha, updated: before.stdout.trim().toLowerCase() !== sha };
  }

  /** 源码部署保持每次独立、可写的目录，不能按SHA合并运行数据或并行构建。 */
  async prepareDeploymentSource(branch: string, targetDir: string, commitSha?: string, repoRoot?: string,
    recovery: DeploymentSourceRecoveryPolicy = { kind: 'existing-only' }): Promise<{
    head: string; before: string; after: string; afterFull: string; updated: boolean; sourcePath: string;
  }> {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      const { gitCwd, ...target } = await this.resolveDeploymentTarget(branch, targetDir, commitSha, repoRoot, recovery);
      const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const sourceRoot = WorktreeService.deploymentSourceRootFor(targetDir);
      fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      const sourcePath = path.join(sourceRoot, randomUUID());
      const added = await withRepositoryMutation(repoRoot || gitCwd, () => this.shell.exec(`git worktree add --detach ${quote(sourcePath)} ${quote(target.afterFull)}`, { cwd: gitCwd }));
      if (added.exitCode !== 0) {
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        throw new Error(`部署源码目录准备失败:\n${combinedOutput(added)}`);
      }
      const actual = await this.deploymentWorktreeHead(sourcePath);
      if (actual.exitCode !== 0 || actual.stdout.trim().toLowerCase() !== target.afterFull) {
        await withRepositoryMutation(repoRoot || gitCwd, () => this.shell.exec(`git worktree remove --force ${quote(sourcePath)}`, { cwd: gitCwd }));
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        throw new Error('部署源码目录未匹配目标提交，已拒绝执行');
      }
      return { ...target, sourcePath };
    }, true);
  }

  async remove(repoRoot: string, targetDir: string): Promise<void> {
    return worktreePathActivity.run([targetDir, WorktreeService.deploymentSourceRootFor(targetDir)], async () => {
      const result = await this.shell.exec(
        `git worktree remove --force "${targetDir}"`,
        { cwd: repoRoot },
      );
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
