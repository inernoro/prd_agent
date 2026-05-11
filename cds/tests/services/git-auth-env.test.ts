import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { resolveGitAuthEnv } from '../../src/services/git-auth-env.js';
import type { CdsConfig } from '../../src/types.js';
import type { GitHubAppClient } from '../../src/services/github-app-client.js';

function makeConfig(repoRoot: string): CdsConfig {
  return {
    repoRoot,
    worktreeBase: path.join(repoRoot, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'cds-test' },
  };
}

describe('resolveGitAuthEnv', () => {
  it('prefers project GitHub App installation token for repo git commands', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-git-auth-'));
    try {
      const state = new StateService(path.join(tmp, 'state.json'));
      state.load();
      const now = new Date().toISOString();
      state.addProject({
        id: 'p1',
        slug: 'prd-agent',
        name: 'prd-agent',
        kind: 'git',
        repoPath: tmp,
        githubInstallationId: 123,
        createdAt: now,
        updatedAt: now,
      });
      const githubApp = {
        getInstallationToken: async (installationId: number) => `token-${installationId}`,
      } as Pick<GitHubAppClient, 'getInstallationToken'> as GitHubAppClient;

      const auth = await resolveGitAuthEnv({
        repoRoot: tmp,
        config: makeConfig(tmp),
        stateService: state,
        githubApp,
      });

      expect(auth.source).toBe('github-app');
      expect(auth.projectId).toBe('p1');
      expect(auth.env?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(auth.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
      expect(String(auth.env?.GIT_CONFIG_VALUE_0 || '')).toContain('AUTHORIZATION: basic ');
      expect(String(auth.env?.GIT_CONFIG_VALUE_0 || '')).not.toContain('token-123');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
