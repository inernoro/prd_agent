import { describe, expect, it } from 'vitest';
import type { ReleaseTarget } from '../../src/types.js';
import { buildScriptCheckCommand, extractReleaseScriptPaths } from '../../src/services/release-service.js';

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
  });

  it('builds a remote command that checks script files without executing them', () => {
    const cmd = buildScriptCheckCommand(target(), ['./fast.sh', './exec_dep.sh']);

    expect(cmd).toContain("cd '/opt/prd agent'");
    expect(cmd).toContain("for f in './fast.sh' './exec_dep.sh'; do");
    expect(cmd).toContain('test -f "$f"');
    expect(cmd).toContain('test -x "$f"');
    expect(cmd).not.toContain('CDS_COMMIT_SHA=');
  });
});
