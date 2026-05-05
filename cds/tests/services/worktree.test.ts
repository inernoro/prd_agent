import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeService, CURRENT_WORKTREE_LAYOUT_VERSION, LEGACY_PROJECT_ID } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

/**
 * P4 Part 18 (G1.2): WorktreeService is now stateless — every
 * repo-touching method takes `repoRoot` as its first argument. The
 * previous `repoRoot` constructor arg + getter/setter have been
 * removed. See `doc/design.cds-multi-project.md` and the commit
 * message for the rationale.
 */
describe('WorktreeService', () => {
  const REPO = '/repo';
  let mock: MockShellExecutor;
  let service: WorktreeService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new WorktreeService(mock);
  });

  describe('create', () => {
    it('should fetch then create a worktree', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: 'Preparing worktree', stderr: '', exitCode: 0 }));

      await service.create(REPO, 'feature/new-ui', '/tmp/wt/feature-new-ui');
      expect(mock.commands[0]).toContain('git fetch');
      expect(mock.commands.find(c => c.includes('git worktree add'))).toContain('/tmp/wt/feature-new-ui');
      expect(mock.commands.find(c => c.includes('git worktree add'))).toContain('origin/feature/new-ui');
    });

    it('should clean up stale worktree directory before creating', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: 'exists\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/rm -rf/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: 'Preparing worktree', stderr: '', exitCode: 0 }));

      await service.create(REPO, 'main', '/tmp/wt/main');
      expect(mock.commands).toContainEqual(expect.stringContaining('git worktree prune'));
      expect(mock.commands).toContainEqual(expect.stringContaining('rm -rf'));
      expect(mock.commands).toContainEqual(expect.stringContaining('git worktree add'));
    });

    it('should throw if fetch fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({
        stdout: '',
        stderr: 'fatal: remote error',
        exitCode: 128,
      }));

      await expect(service.create(REPO, 'bad-branch', '/tmp/wt/bad')).rejects.toThrow('拉取分支');
    });

    it('should throw if worktree add fails', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      mock.addResponsePattern(/git worktree add/, () => ({
        stdout: '',
        stderr: 'fatal: already exists',
        exitCode: 128,
      }));

      await expect(service.create(REPO, 'dup', '/tmp/wt/dup')).rejects.toThrow('创建工作树');
    });

    // P4 Part 18 (G1.2): this is the multi-repo guarantee. Two
    // concurrent creates against different repoRoot values must
    // issue their git commands with the correct cwd — the service no
    // longer holds repoRoot as instance state, so there is no way
    // for one call to clobber another.
    it('uses different repoRoots on concurrent calls without interference', async () => {
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
      mock.addResponsePattern(/git worktree add/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await Promise.all([
        service.create('/repo-a', 'feature-a', '/tmp/wt/a'),
        service.create('/repo-b', 'feature-b', '/tmp/wt/b'),
      ]);

      // Both repo roots appear as cwd. `test -d` + `rm -rf` don't set
      // cwd (they're absolute-path checks), so we only inspect
      // git-rooted commands: fetch / prune / worktree add.
      const gitCwds = mock.commands
        .map((cmd, i) => ({ cmd, cwd: mock.cwds[i] }))
        .filter(({ cmd }) => /git (fetch|worktree)/.test(cmd))
        .map(({ cwd }) => cwd);

      expect(gitCwds).toContain('/repo-a');
      expect(gitCwds).toContain('/repo-b');
      // Every git command that has cwd set must be one of the two
      // roots — never a mix-up.
      for (const cwd of gitCwds) {
        expect(cwd === '/repo-a' || cwd === '/repo-b').toBe(true);
      }
    });
  });

  describe('remove', () => {
    it('should remove a worktree', async () => {
      mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.remove(REPO, '/tmp/wt/old');
      expect(mock.commands[0]).toContain('git worktree remove');
      expect(mock.commands[0]).toContain('--force');
      expect(mock.commands[0]).toContain('/tmp/wt/old');
    });

    it('should throw if remove fails', async () => {
      mock.addResponsePattern(/git worktree remove/, () => ({
        stdout: '',
        stderr: 'error: not a worktree',
        exitCode: 1,
      }));

      await expect(service.remove(REPO, '/tmp/wt/bad')).rejects.toThrow();
    });
  });

  describe('pull', () => {
    // NOTE: pull() does not take repoRoot because every git command
    // runs inside targetDir (the worktree). The 2-arg signature is
    // preserved across the G1.2 refactor.
    it('should return updated=true when new commits are pulled', async () => {
      let callCount = 0;
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => {
        callCount++;
        // First call: before SHA, Second call: after SHA (different)
        return callCount === 1
          ? { stdout: 'abc1234\n', stderr: '', exitCode: 0 }
          : { stdout: 'def5678\n', stderr: '', exitCode: 0 };
      });
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at def5678', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'def5678 new feature\n', stderr: '', exitCode: 0 }));

      const result = await service.pull('main', '/tmp/wt/main');
      expect(result.updated).toBe(true);
      expect(result.before).toBe('abc1234');
      expect(result.after).toBe('def5678');
      expect(result.head).toBe('def5678 new feature');
    });

    it('should return updated=false when already at latest', async () => {
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({
        stdout: 'abc1234\n', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 existing commit\n', stderr: '', exitCode: 0 }));

      const result = await service.pull('main', '/tmp/wt/main');
      expect(result.updated).toBe(false);
      expect(result.before).toBe('abc1234');
      expect(result.after).toBe('abc1234');
    });

    it('should throw if fetch fails', async () => {
      mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git fetch/, () => ({
        stdout: '', stderr: 'fatal: network error', exitCode: 128,
      }));

      await expect(service.pull('bad', '/tmp/wt/bad')).rejects.toThrow('拉取失败');
    });

    it('should throw if reset fails', async () => {
      mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc\n', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git reset --hard/, () => ({
        stdout: '', stderr: 'fatal: ambiguous argument', exitCode: 1,
      }));

      await expect(service.pull('bad', '/tmp/wt/bad')).rejects.toThrow('重置失败');
    });
  });

  describe('branchExists', () => {
    it('should return true if remote branch exists', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/feature/exists\n',
        stderr: '',
        exitCode: 0,
      }));

      const exists = await service.branchExists(REPO, 'feature/exists');
      expect(exists).toBe(true);
    });

    it('should return false if remote branch does not exist', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const exists = await service.branchExists(REPO, 'feature/nope');
      expect(exists).toBe(false);
    });
  });

  describe('findBranchBySlug', () => {
    it('should match branch by slugified name (slash to hyphen)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: [
          'abc123\trefs/heads/main',
          'def456\trefs/heads/claude/fix-software-defects-dlxzp',
          'ghi789\trefs/heads/feature/new-ui',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug(REPO, 'claude-fix-software-defects-dlxzp');
      expect(result).toBe('claude/fix-software-defects-dlxzp');
    });

    it('should return null when no branch slug matches', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/main\ndef456\trefs/heads/develop\n',
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug(REPO, 'claude-nonexistent-branch');
      expect(result).toBeNull();
    });

    it('should handle case-insensitive slug matching', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: 'abc123\trefs/heads/Claude/Fix-Login-ISSUE\n',
        stderr: '',
        exitCode: 0,
      }));

      const result = await service.findBranchBySlug(REPO, 'claude-fix-login-issue');
      expect(result).toBe('Claude/Fix-Login-ISSUE');
    });

    it('should return null on git command failure', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: '',
        stderr: 'fatal: error',
        exitCode: 128,
      }));

      const result = await service.findBranchBySlug(REPO, 'anything');
      expect(result).toBeNull();
    });
  });

  // ── findBranchByPreviewSlug：v1 / v2 / v3 三档反查 ──
  //
  // 用例核心场景：subdomain 命中 auto-build 时，host 里的 slug 是按
  // computePreviewSlug 算出来的（含项目身份），需要反向找到原始 git ref。
  describe('findBranchByPreviewSlug', () => {
    const STD_REMOTE = [
      'abc123\trefs/heads/main',
      'def456\trefs/heads/claude/audio-upload-asr-TGR1f',
      'ghi789\trefs/heads/feature/login',
    ].join('\n');

    it('matches v3 slug (tail-prefix-project)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'audio-upload-asr-tgr1f-claude-prd-agent', ['prd-agent']);
      expect(result).toBe('claude/audio-upload-asr-TGR1f');
    });

    it('matches v2 slug (project-prefix-tail)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'prd-agent-claude-audio-upload-asr-tgr1f', ['prd-agent']);
      expect(result).toBe('claude/audio-upload-asr-TGR1f');
    });

    it('matches v1 bare slug (legacy single-project)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'claude-audio-upload-asr-tgr1f', ['prd-agent']);
      expect(result).toBe('claude/audio-upload-asr-TGR1f');
    });

    it('matches main branch via v3 tail-only form', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'main-prd-agent', ['prd-agent']);
      expect(result).toBe('main');
    });

    it('returns null when slug matches no remote branch', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'nonexistent-branch-prd-agent', ['prd-agent']);
      expect(result).toBeNull();
    });

    it('returns null when projectSlugs is empty (no v2/v3 attempt)', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      // v2/v3 needs project context; v1 bare match still works
      const v1Result = await service.findBranchByPreviewSlug(
        REPO, 'claude-audio-upload-asr-tgr1f', []);
      expect(v1Result).toBe('claude/audio-upload-asr-TGR1f');
      const v3Result = await service.findBranchByPreviewSlug(
        REPO, 'audio-upload-asr-tgr1f-claude-prd-agent', []);
      expect(v3Result).toBeNull();
    });

    it('tries multiple project slugs', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: STD_REMOTE, stderr: '', exitCode: 0,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'login-feature-prd-agent', ['demo', 'prd-agent', 'other']);
      expect(result).toBe('feature/login');
    });

    it('returns null on git failure', async () => {
      mock.addResponsePattern(/git ls-remote/, () => ({
        stdout: '', stderr: 'fatal: error', exitCode: 128,
      }));
      const result = await service.findBranchByPreviewSlug(
        REPO, 'anything', ['prd-agent']);
      expect(result).toBeNull();
    });
  });

  // ── FU-04 — per-project worktree subdirectory ──
  //
  // These tests live in the WorktreeService suite (not in
  // state.test.ts) because the layout + migration logic is owned by
  // WorktreeService. StateService just exposes the getters/setters
  // the migration helper uses as callbacks.
  describe('worktreePathFor (FU-04)', () => {
    it('builds <base>/<projectId>/<slug> for a fresh install', () => {
      const out = WorktreeService.worktreePathFor('/var/cds/wt', 'proj1', 'main');
      expect(out).toBe('/var/cds/wt/proj1/main');
    });

    it('falls back to "default" when projectId is undefined', () => {
      const out = WorktreeService.worktreePathFor('/wt', undefined, 'main');
      expect(out).toBe(`/wt/${LEGACY_PROJECT_ID}/main`);
    });

    it('falls back to "default" when projectId is empty string', () => {
      const out = WorktreeService.worktreePathFor('/wt', '   ', 'master');
      expect(out).toBe(`/wt/${LEGACY_PROJECT_ID}/master`);
    });

    it('isolates two projects sharing a branch name (no collision)', () => {
      const a = WorktreeService.worktreePathFor('/wt', 'projA', 'main');
      const b = WorktreeService.worktreePathFor('/wt', 'projB', 'main');
      expect(a).not.toBe(b);
      expect(a).toBe('/wt/projA/main');
      expect(b).toBe('/wt/projB/main');
    });
  });

  describe('migrateFlatLayoutIfNeeded (FU-04)', () => {
    let tmpBase: string;

    beforeEach(() => {
      tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-fu04-'));
    });

    afterEach(() => {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('is a no-op when state.worktreeLayoutVersion is already current', () => {
      // Seed a legacy-looking flat entry so we can prove it wasn't touched.
      fs.mkdirSync(path.join(tmpBase, 'main'));
      let stamped: number | undefined;

      const migrated = WorktreeService.migrateFlatLayoutIfNeeded({
        worktreeBase: tmpBase,
        projectIds: ['default'],
        branches: [],
        currentVersion: CURRENT_WORKTREE_LAYOUT_VERSION,
        updateBranchWorktreePath: () => { throw new Error('should not be called'); },
        markMigrated: (v) => { stamped = v; },
      });

      expect(migrated).toBe(0);
      expect(stamped).toBeUndefined();
      // Flat entry still there, not symlinked into a default bucket.
      expect(fs.existsSync(path.join(tmpBase, 'default'))).toBe(false);
    });

    it('is a no-op (but stamps the version) when worktreeBase does not exist', () => {
      const missing = path.join(tmpBase, 'does-not-exist');
      let stamped = 0;

      const migrated = WorktreeService.migrateFlatLayoutIfNeeded({
        worktreeBase: missing,
        projectIds: [],
        branches: [],
        currentVersion: undefined,
        updateBranchWorktreePath: () => { throw new Error('should not be called'); },
        markMigrated: (v) => { stamped = v; },
      });

      expect(migrated).toBe(0);
      expect(stamped).toBe(CURRENT_WORKTREE_LAYOUT_VERSION);
    });

    it('symlinks legacy flat worktrees into <base>/default/<slug> and rewrites BranchEntry.worktreePath', () => {
      // Pre-seed three flat worktrees mimicking a legacy install.
      const legacyMain = path.join(tmpBase, 'main');
      const legacyFeat = path.join(tmpBase, 'feature-x');
      fs.mkdirSync(legacyMain);
      fs.writeFileSync(path.join(legacyMain, 'marker.txt'), 'legacy-main', 'utf-8');
      fs.mkdirSync(legacyFeat);

      const branches = [
        { id: 'main', projectId: 'default', worktreePath: legacyMain },
        { id: 'feature-x', projectId: 'default', worktreePath: legacyFeat },
      ];
      const pathUpdates: Record<string, string> = {};
      let stamped = 0;

      const migrated = WorktreeService.migrateFlatLayoutIfNeeded({
        worktreeBase: tmpBase,
        projectIds: ['default'],
        branches,
        currentVersion: undefined, // legacy install
        updateBranchWorktreePath: (id, p) => { pathUpdates[id] = p; },
        markMigrated: (v) => { stamped = v; },
      });

      expect(migrated).toBeGreaterThanOrEqual(2);
      expect(stamped).toBe(CURRENT_WORKTREE_LAYOUT_VERSION);

      // Nested links exist and resolve to the legacy dirs.
      const nestedMain = path.join(tmpBase, LEGACY_PROJECT_ID, 'main');
      const nestedFeat = path.join(tmpBase, LEGACY_PROJECT_ID, 'feature-x');
      expect(fs.existsSync(nestedMain)).toBe(true);
      expect(fs.existsSync(nestedFeat)).toBe(true);
      // Symlink's target is the original flat path, so the marker
      // file is visible through the new nested path.
      expect(fs.readFileSync(path.join(nestedMain, 'marker.txt'), 'utf-8')).toBe('legacy-main');

      // BranchEntry.worktreePath gets rewritten to the nested layout.
      expect(pathUpdates['main']).toBe(nestedMain);
      expect(pathUpdates['feature-x']).toBe(nestedFeat);
    });

    it('skips directories whose name matches an existing project id', () => {
      // 'proj1' is a known project — should NOT be treated as a legacy slug.
      fs.mkdirSync(path.join(tmpBase, 'proj1'));
      fs.mkdirSync(path.join(tmpBase, 'proj1', 'main')); // already nested
      fs.mkdirSync(path.join(tmpBase, 'orphan-slug'));   // should migrate

      const pathUpdates: Record<string, string> = {};
      const migrated = WorktreeService.migrateFlatLayoutIfNeeded({
        worktreeBase: tmpBase,
        projectIds: ['proj1'],
        branches: [
          { id: 'orphan-slug', projectId: 'default', worktreePath: path.join(tmpBase, 'orphan-slug') },
        ],
        currentVersion: undefined,
        updateBranchWorktreePath: (id, p) => { pathUpdates[id] = p; },
        markMigrated: () => {},
      });

      // Only 'orphan-slug' migrated; 'proj1' left alone.
      expect(migrated).toBe(1);
      expect(pathUpdates['orphan-slug']).toBe(path.join(tmpBase, LEGACY_PROJECT_ID, 'orphan-slug'));
      // proj1 nested dir untouched.
      expect(fs.existsSync(path.join(tmpBase, 'proj1', 'main'))).toBe(true);
      // No default/proj1 weirdness:
      expect(fs.existsSync(path.join(tmpBase, LEGACY_PROJECT_ID, 'proj1'))).toBe(false);
    });
  });
});
