import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildReleaseExecution,
  discoverReleaseStrategies,
  validateReleaseStrategy,
  normalizeRepositoryIdentity,
} from '../../src/services/release-strategy.js';
import type { BranchEntry, Project, ReleaseRun, ReleaseTarget } from '../../src/types.js';

describe('release strategy discovery and generation', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('discovers existing script, compose and static no-script paths without crossing the project boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-strategy-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'exec_dep.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '1.0.0' } }));
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const result = discoverReleaseStrategies(project(), branch(root));

    expect(result.projectIdentity).toEqual({
      projectId: 'proj-a',
      projectSlug: 'proj-a',
      repository: 'owner/proj-a',
    });
    expect(result.recommendedMode).toBe('existing-script');
    expect(result.candidates.map((candidate) => candidate.mode)).toEqual([
      'existing-script',
      'generated-compose',
      'generated-static',
    ]);
    expect(result.candidates.find((candidate) => candidate.mode === 'generated-static')?.strategy).toMatchObject({
      buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
      artifactDirectory: 'dist',
    });
  });

  it('generates a deterministic compose script tied to the immutable commit and records its hash', () => {
    const first = buildReleaseExecution(target({
      mode: 'generated-compose',
      composeFile: 'compose.yml',
      composeProject: 'proj-a-prod',
    }), run());
    const second = buildReleaseExecution(target({
      mode: 'generated-compose',
      composeFile: 'compose.yml',
      composeProject: 'proj-a-prod',
    }), run());

    expect(first.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    const script = decodeGeneratedCommand(first.command);
    expect(script).toContain('git -C "$repo" worktree add --detach "$worktree" "$CDS_COMMIT_SHA"');
    expect(script).toContain("docker compose -p 'proj-a-prod' -f \"$worktree/compose.yml\" up -d --build --remove-orphans");
    expect(script).toContain('os.replace(sys.argv[1], sys.argv[2])');
  });

  it('generates a static release with offline entry validation and atomic current/previous pointers', () => {
    const execution = buildReleaseExecution(target({
      mode: 'generated-static',
      buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
      artifactDirectory: 'dist',
      publicDirectory: '/srv/proj-a-web',
    }), run());
    const script = decodeGeneratedCommand(execution.command);

    expect(script).toContain("publish_root='/srv/proj-a-web'");
    expect(script).toContain('chmod 755 "$publish_root" "$publish_root/.releases"');
    expect(script).toContain("raise SystemExit('index.html has no JS/CSS entry reference')");
    expect(script).toContain('find "$version.tmp" -type d -exec chmod 755 {} +');
    expect(script).toContain('ln -sfn "$(readlink "$publish_root/current")" "$publish_root/previous"');
    expect(script).toContain('os.replace(sys.argv[1], sys.argv[2])');
  });

  it('rejects traversal and incomplete generated strategies before SSH execution', () => {
    expect(validateReleaseStrategy({
      mode: 'generated-compose',
      composeFile: '../other/compose.yml',
      composeProject: 'proj-a-prod',
    })).toBe('composeFile must be a safe relative path');
    expect(validateReleaseStrategy({
      mode: 'generated-static',
      buildCommand: '',
      artifactDirectory: 'dist',
      publicDirectory: '/srv/proj-a-web',
    })).toBe('generated-static strategy requires buildCommand');
    expect(validateReleaseStrategy({
      mode: 'generated-static',
      buildCommand: 'pnpm build',
      artifactDirectory: 'dist',
      publicDirectory: '/',
    })).toBe('publicDirectory must be a non-system absolute directory with at least two path segments');
  });

  it('normalizes HTTPS, SSH and GitHub full-name repository identities consistently', () => {
    expect(normalizeRepositoryIdentity('Owner/Repo')).toBe('owner/repo');
    expect(normalizeRepositoryIdentity('https://github.com/Owner/Repo.git')).toBe('owner/repo');
    expect(normalizeRepositoryIdentity('git@github.com:Owner/Repo.git')).toBe('owner/repo');
  });

  it('executes a generated static release twice and preserves atomic current and previous versions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-static-e2e-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    const published = path.join(root, 'published');
    fs.mkdirSync(path.join(repo, 'site', 'assets'), { recursive: true });
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'cds-test@example.test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'CDS Test']);
    writeStaticFixture(repo, 'version-one');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'first']);
    const firstSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    executeStaticRelease(repo, published, firstSha, 'rel-first');
    expect(fs.readFileSync(path.join(published, 'current', 'index.html'), 'utf8')).toContain('version-one');
    expect(fs.statSync(published).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(published, '.releases')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(published, 'current')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(published, 'current', 'index.html')).mode & 0o777).toBe(0o644);

    writeStaticFixture(repo, 'version-two');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'second']);
    const secondSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    executeStaticRelease(repo, published, secondSha, 'rel-second');

    expect(fs.readFileSync(path.join(published, 'current', 'index.html'), 'utf8')).toContain('version-two');
    expect(fs.readFileSync(path.join(published, 'previous', 'index.html'), 'utf8')).toContain('version-one');
  });
});

function writeStaticFixture(repo: string, version: string): void {
  fs.writeFileSync(path.join(repo, 'site', 'index.html'), `<html><body>${version}<script src="/assets/app.js"></script></body></html>\n`);
  fs.writeFileSync(path.join(repo, 'site', 'assets', 'app.js'), `window.releaseVersion = '${version}';\n`);
}

function executeStaticRelease(repo: string, published: string, commitSha: string, releaseId: string): void {
  const execution = buildReleaseExecution(target({
    mode: 'generated-static',
    buildCommand: 'mkdir -p dist/assets && cp site/index.html dist/index.html && cp site/assets/app.js dist/assets/app.js',
    artifactDirectory: 'dist',
    publicDirectory: published,
  }), { ...run(), releaseId, commitSha });
  execFileSync('bash', ['-lc', `umask 077; ${execution.command}`], {
    cwd: repo,
    env: { ...process.env, CDS_COMMIT_SHA: commitSha, CDS_RELEASE_ID: releaseId, CDS_TARGET_ID: 'target-a' },
    stdio: 'pipe',
  });
}

function project(): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-a',
    slug: 'proj-a',
    name: 'Project A',
    kind: 'git',
    githubRepoFullName: 'owner/proj-a',
    createdAt: now,
    updatedAt: now,
  };
}

function branch(root: string): BranchEntry {
  return {
    id: 'proj-a-main',
    projectId: 'proj-a',
    branch: 'main',
    worktreePath: root,
    services: {},
    status: 'running',
    createdAt: new Date().toISOString(),
    githubCommitSha: 'a'.repeat(40),
  };
}

function target(strategy: ReleaseTarget['strategy']): ReleaseTarget {
  return {
    id: 'target-a',
    projectId: 'proj-a',
    name: 'Project A production',
    type: 'ssh',
    createdAt: new Date().toISOString(),
    isEnabled: true,
    strategy,
    ssh: {
      host: 'prod.example.test',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-a',
      appPath: '/srv/proj-a-repo',
      deployCommand: '',
      healthcheckUrl: 'https://prod.example.test/health',
    },
  };
}

function run(): ReleaseRun {
  return {
    releaseId: 'rel-fixed',
    projectId: 'proj-a',
    branchId: 'proj-a-main',
    commitSha: 'a'.repeat(40),
    artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchName: 'main' },
    targetId: 'target-a',
    planId: 'proj-a:generated',
    status: 'queued',
    startedAt: '2026-07-17T00:00:00.000Z',
    logs: [],
    seq: 0,
  };
}

function decodeGeneratedCommand(command: string): string {
  const match = command.match(/^printf %s '([^']+)' \| base64 -d \| bash$/);
  if (!match) throw new Error(`unexpected command: ${command}`);
  return Buffer.from(match[1], 'base64').toString('utf8');
}
