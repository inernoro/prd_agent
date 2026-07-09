import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { ReleaseTarget } from '../../src/types.js';
import { buildReleaseCommand, buildScriptCheckCommand, extractReleaseScriptPaths, isDefaultScriptChain, isLocalProdReleaseCommand, probeHealthcheckStatus, releaseScriptPhase } from '../../src/services/release-service.js';

function target(appPath = '/opt/prd agent'): ReleaseTarget {
  const now = new Date().toISOString();
  return {
    id: 'target-prod',
    projectId: 'prd-agent',
    name: '生产站点',
    type: 'ssh',
    createdAt: now,
    updatedAt: now,
    isEnabled: true,
    ssh: {
      host: 'prod.example.test',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-prod',
      appPath,
      deployCommand: './fast.sh && ./exec_dep.sh',
      rollbackCommand: './rollback.sh',
      healthcheckUrl: 'https://prod.example.test/healthz',
    },
  };
}

describe('release service script preflight helpers', () => {
  it('extracts unique shell scripts from the site publish command', () => {
    expect(extractReleaseScriptPaths('./fast.sh && ./exec_dep.sh && ./fast.sh')).toEqual([
      './fast.sh',
      './exec_dep.sh',
    ]);
    expect(extractReleaseScriptPaths('CDS_ENV=prod ./scripts/deploy.sh --force')).toEqual([
      './scripts/deploy.sh',
    ]);
    expect(extractReleaseScriptPaths("CDS_ENV=prod '/opt/cds/scripts/local-prod-release.sh'")).toEqual([
      '/opt/cds/scripts/local-prod-release.sh',
    ]);
  });

  it('recognizes the default site publish scripts as individually traceable steps', () => {
    expect(isDefaultScriptChain('./fast.sh && ./exec_dep.sh')).toBe(true);
    expect(isDefaultScriptChain('./fast.sh && ./exec_dep.sh && ./notify.sh')).toBe(false);
    expect(isDefaultScriptChain('CDS_ENV=prod ./fast.sh && ./exec_dep.sh')).toBe(false);
  });

  it('uses stable script phases for release progress and streamed script output', () => {
    expect(releaseScriptPhase('./fast.sh')).toBe('script:fast.sh');
    expect(releaseScriptPhase('./exec_dep.sh')).toBe('script:exec_dep.sh');
    expect(releaseScriptPhase('./scripts/deploy.prod.sh')).toBe('script:scripts-deploy.prod.sh');
  });

  it('builds a remote command that checks script files without executing them', () => {
    const cmd = buildScriptCheckCommand(target(), ['./fast.sh', './exec_dep.sh']);

    expect(cmd).toContain("cd '/opt/prd agent'");
    expect(cmd).toContain("for f in './fast.sh' './exec_dep.sh'; do");
    expect(cmd).toContain('test -f "$f"');
    expect(cmd).toContain('test -x "$f"');
    expect(cmd).not.toContain('CDS_COMMIT_SHA=');
  });

  it('checks local production release scripts before the app directory exists', () => {
    const cmd = buildScriptCheckCommand(target('/opt/a-prod/current'), ['/opt/cds/current/scripts/local-prod-release.sh']);

    expect(cmd).toContain("for f in '/opt/cds/current/scripts/local-prod-release.sh'; do");
    expect(cmd).toContain('test -f "$f"');
    expect(cmd).toContain('test -x "$f"');
    expect(cmd).not.toContain("cd '/opt/a-prod/current'");
  });

  it('recognizes local production release commands', () => {
    expect(isLocalProdReleaseCommand("CDS_LOCAL_PROD_DIR='/opt/a-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'")).toBe(true);
    expect(isLocalProdReleaseCommand('./deploy.sh')).toBe(false);
  });

  it('exports release variables before running compound shell commands', () => {
    const cmd = buildReleaseCommand(
      target(),
      {
        releaseId: 'rel_test',
        projectId: 'prd-agent',
        branchId: 'branch-main',
        commitSha: 'abc123',
        artifact: {
          type: 'branch-preview',
          commitSha: 'abc123',
          branchId: 'branch-main',
          branchName: 'main',
          previewUrl: 'https://main.example.test',
          artifactPath: '/worktrees/prd-agent/branch-main',
        },
        targetId: 'target-prod',
        planId: 'plan-ssh',
        status: 'running',
        startedAt: '2026-07-04T00:00:00.000Z',
        logs: [],
        seq: 0,
      },
      'if [ "$CDS_BRANCH_NAME" != "main" ]; then exit 43; fi; ./deploy.sh',
    );

    expect(cmd).toContain("cd '/opt/prd agent' && export ");
    expect(cmd).toContain("CDS_COMMIT_SHA='abc123'");
    expect(cmd).toContain("CDS_PROJECT_ID='prd-agent'");
    expect(cmd).toContain("CDS_BRANCH_ID='branch-main'");
    expect(cmd).toContain("CDS_TARGET_ID='target-prod'");
    expect(cmd).toContain("CDS_BRANCH_NAME='main'");
    expect(cmd).toContain("CDS_ARTIFACT_PATH='/worktrees/prd-agent/branch-main'");
    expect(cmd).toContain('&& if [ "$CDS_BRANCH_NAME" != "main" ]; then exit 43; fi; ./deploy.sh');
    expect(cmd).not.toContain('; if [ "$CDS_BRANCH_NAME" != "main" ]; then exit 43; fi; ./deploy.sh');
    expect(cmd).not.toContain("CDS_BRANCH_NAME='main' if");
  });

  it('creates the local production app directory before running the bundled release script', () => {
    const cmd = buildReleaseCommand(
      target('/opt/a-prod/current'),
      {
        releaseId: 'rel_test',
        projectId: 'prd-agent',
        branchId: 'branch-main',
        commitSha: 'abc123',
        artifact: {
          type: 'branch-preview',
          commitSha: 'abc123',
          branchId: 'branch-main',
          branchName: 'main',
          previewUrl: 'https://main.example.test',
          artifactPath: '/worktrees/prd-agent/branch-main',
        },
        targetId: 'target-prod',
        planId: 'plan-ssh',
        status: 'running',
        startedAt: '2026-07-04T00:00:00.000Z',
        logs: [],
        seq: 0,
      },
      "CDS_LOCAL_PROD_DIR='/opt/a-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'",
    );

    expect(cmd).toContain("mkdir -p '/opt/a-prod/current' && cd '/opt/a-prod/current' && export ");
    expect(cmd).toContain("CDS_COMMIT_SHA='abc123'");
    expect(cmd).toContain("CDS_ARTIFACT_PATH='/worktrees/prd-agent/branch-main'");
    expect(cmd).toContain("&& CDS_LOCAL_PROD_DIR='/opt/a-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'");
  });

  it('reports healthcheck response timing and failure details', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200).end('ok');
        return;
      }
      res.writeHead(503).end('down');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address() as { port: number };
      const healthy = await probeHealthcheckStatus(`http://127.0.0.1:${addr.port}/ok`, 500);
      expect(healthy.status).toBe('healthy');
      expect(typeof healthy.responseTimeMs).toBe('number');
      expect(healthy.checkedAt).toBeTruthy();

      const failed = await probeHealthcheckStatus(`http://127.0.0.1:${addr.port}/down`, 500);
      expect(failed.status).toBe('failed');
      expect(failed.message).toBe('healthcheck HTTP 503');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
