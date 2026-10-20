import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildReleaseExecution, validateReleaseStrategy } from '../../src/services/release-strategy.js';
import { hasReleaseCI } from '../../src/services/project-release-script.js';
import { ReleaseService } from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ReleaseRun, ReleaseTarget, ReleaseStrategy } from '../../src/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-project-release-')); roots.push(root);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.test');
  const content = '#!/bin/bash\nset -eu\ncase "$1" in check) :;; deploy) printf old > "$RELEASE_OUTPUT";; *) exit 64;; esac\n';
  fs.writeFileSync(path.join(repo, 'cds-release.sh'), content); git('add', '.'); git('commit', '-m', 'original');
  const sha = git('rev-parse', 'HEAD');
  const run = { releaseId: 'rel_test', targetId: 'target', commitSha: sha, artifact: { artifactPath: repo } } as ReleaseRun;
  const target = (strategy: ReleaseStrategy) => ({ strategy, ssh: { appPath: repo } } as ReleaseTarget);
  const execute = (strategy: ReleaseStrategy, id = 'rel_test') => {
    const execution = buildReleaseExecution(target(strategy), { ...run, releaseId: id });
    execFileSync('bash', ['-c', execution.command], { cwd: repo, env: { ...process.env, CDS_COMMIT_SHA: sha, CDS_RELEASE_ID: id, CDS_TARGET_ID: 'target', RELEASE_OUTPUT: path.join(root, 'output') }, stdio: ['pipe', 'pipe', 'pipe'] });
    return execution;
  };
  return { root, repo, git, sha, run, target, content, execute };
}
describe('project-owned publishing contract', () => {
  it('executes the committed script instead of a newer or dirty host copy, with the content hash', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.repo, 'cds-release.sh'), f.content.replace('old', 'new'));
    f.git('add', '.'); f.git('commit', '-m', 'newer');
    fs.writeFileSync(path.join(f.repo, 'cds-release.sh'), f.content.replace('old', 'dirty'));
    const result = f.execute({ mode: 'project-script' });
    expect(fs.readFileSync(path.join(f.root, 'output'), 'utf8')).toBe('old');
    expect(result.scriptSha256).toBe(crypto.createHash('sha256').update(f.content).digest('hex'));
    expect(fs.realpathSync(path.join(f.root, '.cds-releases/target/current'))).toContain('rel_test');
  });
  it('rejects a missing, uncommitted or symlinked release file', () => {
    const f = fixture();
    expect(() => buildReleaseExecution(f.target({ mode: 'project-script', scriptFile: 'missing.sh' }), f.run)).toThrow(/请提交脚本并通过 CI/);
    fs.symlinkSync('/etc/passwd', path.join(f.repo, 'linked.sh')); f.git('add', '.'); f.git('commit', '-m', 'link');
    expect(() => buildReleaseExecution(f.target({ mode: 'project-script', scriptFile: 'linked.sh' }), { ...f.run, commitSha: f.git('rev-parse', 'HEAD') })).toThrow(/普通发布脚本/);
  });
  it('rejects traversal, absolute paths, embedded commands and malformed Bash', () => {
    for (const scriptFile of ['../release.sh', '/opt/release.sh', 'a/../release.sh', 'x.sh;id', 'a\\b.sh']) expect(validateReleaseStrategy({ mode: 'project-script', scriptFile })).not.toBeNull();
    const f = fixture();
    expect(() => buildReleaseExecution(f.target({ mode: 'managed-script', script: 'if then' }), f.run)).toThrow(/语法/);
    expect(validateReleaseStrategy({ mode: 'managed-script', script: '' })).not.toBeNull();
  });
  it('retains immutable script evidence for rollback after the preview checkout is retired', () => {
    const f = fixture();
    const first = buildReleaseExecution(f.target({ mode: 'project-script' }), f.run);
    fs.renameSync(f.repo, f.repo + '-retired');
    const historical = { ...f.run, executionSnapshot: { ...first, strategy: { mode: 'project-script' as const } } };
    expect(buildReleaseExecution(f.target({ mode: 'project-script' }), historical).scriptSha256).toBe(first.scriptSha256);
    historical.executionSnapshot.scriptContent = '# tampered';
    expect(() => buildReleaseExecution(f.target({ mode: 'project-script' }), historical)).toThrow(/指纹不一致/);
  });
  it('does not execute deploy after check fails and does not switch current', () => {
    const f = fixture();
    expect(() => f.execute({ mode: 'managed-script', script: 'if [ "$1" = check ]; then exit 17; fi\nprintf bad > "$RELEASE_OUTPUT"\n' })).toThrow();
    expect(fs.existsSync(path.join(f.root, 'output'))).toBe(false);
    expect(fs.existsSync(path.join(f.root, '.cds-releases/target/current'))).toBe(false);
  });
  it('keeps the CDS-managed fallback explicit, checks it and records its own body hash', () => {
    const f = fixture();
    const script = 'set -eu\nif [ "$1" = deploy ]; then printf managed > "$RELEASE_OUTPUT"; fi\n';
    const result = f.execute({ mode: 'managed-script', script });
    expect(fs.readFileSync(path.join(f.root, 'output'), 'utf8')).toBe('managed');
    expect(result.scriptSha256).toBe(crypto.createHash('sha256').update(script).digest('hex'));
    expect(fs.readdirSync(path.join(f.root, '.cds-releases/target')).some(name => name.startsWith('managed.'))).toBe(false);
  });
  it('rejects a stale green CI result or a failed rerun for the same commit', () => {
    const sha = 'a'.repeat(40);
    expect(hasReleaseCI(undefined, sha)).toBe(false);
    expect(hasReleaseCI({ ciWorkflowConclusion: 'success', ciTargetSha: 'b'.repeat(40) } as BranchEntry, sha)).toBe(false);
    expect(hasReleaseCI({ ciWorkflowConclusion: 'failure', ciTargetSha: sha } as BranchEntry, sha)).toBe(false);
    expect(hasReleaseCI({ ciWorkflowConclusion: 'success', ciTargetSha: sha } as BranchEntry, sha)).toBe(true);
  });
  it('real preflight requires this commit CI and cannot reuse a green preflight after CI fails', async () => {
    const f = fixture();
    const state = new StateService(path.join(f.root, 'state.json')); state.load();
    const now = new Date().toISOString();
    state.addProject({ id: 'project', slug: 'project', name: 'Project', kind: 'git', githubRepoFullName: 'owner/project', createdAt: now, updatedAt: now });
    state.addBranch({ id: 'branch', projectId: 'project', branch: 'main', worktreePath: f.repo, status: 'running', pinnedCommit: f.sha, createdAt: now, services: {} });
    state.addRemoteHost({ id: 'host', name: 'Host', host: '127.0.0.1', sshPort: 22, sshUser: 'deploy', sshPrivateKeyEncrypted: 'fixture', sshPrivateKeyFingerprint: 'fixture', tags: [], isEnabled: true, createdAt: now });
    state.upsertReleaseTarget({ id: 'target', projectId: 'project', name: 'Target', type: 'ssh', isEnabled: true, createdAt: now, strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' }, ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'host', appPath: f.repo, deployCommand: '', healthcheckUrl: 'https://project.example.test/health' } });
    let deployments = 0;
    const service = new ReleaseService(state, { sshExecutor: async req => {
      if (req.command.includes('CDS_RELEASE_ID=')) deployments++;
      return req.command.includes('CDS_REPO_ORIGIN=') ? 'CDS_REPO_ORIGIN=https://github.com/owner/project.git\n' : '';
    } });
    const input = { branchId: 'branch', targetId: 'target', previewUrl: 'https://preview.example.test', operator: 'test' };
    const missing = await service.preflight(input);
    expect(missing.ok).toBe(false);
    expect(missing.checks.find(c => c.id === 'release-ci')?.status).toBe('fail');
    Object.assign(state.getBranch('branch')!, { ciTargetSha: f.sha, ciWorkflowConclusion: 'success' });
    const green = await service.preflight(input);
    expect(green.ok, JSON.stringify(green.checks)).toBe(true);
    expect(green.checks.find(c => c.id === 'release-script')?.message).toContain(crypto.createHash('sha256').update(f.content).digest('hex'));
    Object.assign(state.getBranch('branch')!, { ciWorkflowConclusion: 'failure' });
    await expect(service.startRelease({ ...input, preflightId: green.preflightId })).rejects.toThrow(/发布前检查未通过/);
    expect(deployments).toBe(0);
    await state.flush();
  });
  it('a failed project-owned final check restores the previous script and keeps the release failed', async () => {
    const f = fixture();
    const state = new StateService(path.join(f.root, 'state.json')); state.load();
    const now = new Date().toISOString();
    const health = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); });
    await new Promise<void>(resolve => health.listen(0, '127.0.0.1', resolve));
    try {
      state.addProject({ id: 'project', slug: 'project', name: 'Project', kind: 'git', githubRepoFullName: 'owner/project', createdAt: now, updatedAt: now });
      state.addBranch({ id: 'branch', projectId: 'project', branch: 'main', worktreePath: f.repo, status: 'running', pinnedCommit: f.sha, ciTargetSha: f.sha, ciWorkflowConclusion: 'success', createdAt: now, services: {} });
      state.addRemoteHost({ id: 'host', name: 'Host', host: '127.0.0.1', sshPort: 22, sshUser: 'deploy', sshPrivateKeyEncrypted: 'fixture', sshPrivateKeyFingerprint: 'fixture', tags: [], isEnabled: true, createdAt: now });
      const target = { id: 'target', projectId: 'project', name: 'Target', type: 'ssh', isEnabled: true, createdAt: now, strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' }, ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'host', appPath: f.repo, deployCommand: '', healthcheckUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/health` } } as ReleaseTarget;
      state.upsertReleaseTarget(target);
      const priorExecution = buildReleaseExecution(target, f.run);
      state.addReleaseRun({ ...f.run, releaseId: 'rel_prior', projectId: 'project', branchId: 'branch', targetId: 'target', planId: 'project:project-script', status: 'success', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', logs: [], seq: 0, executionSnapshot: { ...priorExecution, strategy: target.strategy! } });
      const deployments: string[] = [];
      const service = new ReleaseService(state, { sshExecutor: async req => {
        if (req.command.includes('CDS_REPO_ORIGIN=')) return 'CDS_REPO_ORIGIN=https://github.com/owner/project.git\n';
        if (req.command.includes('CDS_RELEASE_ID=')) {
          deployments.push(req.command);
          if (!req.command.includes('-auto-restore')) throw new Error('project public resource check failed');
        }
        return '';
      } });
      const run = await service.startRelease({ branchId: 'branch', targetId: 'target', previewUrl: 'https://preview.example.test', operator: 'test' });
      await vi.waitFor(() => expect(state.getReleaseRun(run.releaseId)?.status).toBe('failed'));
      const failed = state.getReleaseRun(run.releaseId)!;
      expect(deployments).toHaveLength(2);
      expect(failed.autoRestoredAt).toBeTruthy();
      expect(failed.logs.some(log => log.message.includes('发布脚本执行失败，正在自动恢复'))).toBe(true);
      expect(failed.logs.some(log => log.message.includes('已恢复上一成功版本'))).toBe(true);
    } finally {
      await state.flush();
      await new Promise<void>(resolve => health.close(() => resolve()));
    }
  });
});
