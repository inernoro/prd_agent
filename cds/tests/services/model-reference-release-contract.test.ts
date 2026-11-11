import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProfileRuntimeEnvWithProvenance } from '../../src/services/env-provenance.js';

const root = new URL('../../../', import.meta.url);
const compose = load(readFileSync(new URL('cds-compose.yml', root), 'utf8')) as {
  services: { llmgw: { environment: Record<string, string> } };
};
const identityKey = 'LlmGateway__ModelReferences__MapDeploymentIdentity';
const identityTemplate = compose.services.llmgw.environment[identityKey];
const dockerfile = readFileSync(new URL('llmgw/console-api/Dockerfile', root), 'utf8');
const originalBranch = process.env.VITE_GIT_BRANCH;

afterEach(() => {
  if (originalBranch === undefined) delete process.env.VITE_GIT_BRANCH;
  else process.env.VITE_GIT_BRANCH = originalBranch;
});

describe('model reference release identity contract', () => {
  it.each(['main', 'codex/model-reference-fix'])('uses the platform-forced complete branch %s', (branch) => {
    const result = resolveProfileRuntimeEnvWithProvenance(
      { branch, githubCommitSha: 'a'.repeat(40) },
      { dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0' },
      [{ source: 'project', env: { VITE_GIT_BRANCH: 'wrong-project-branch' } }],
      [{ source: 'profile', env: { VITE_GIT_BRANCH: 'wrong-profile-branch', [identityKey]: identityTemplate } }],
      { jwtIssuer: 'test-only' },
    );
    expect(result.env[identityKey]).toBe(`prd-agent:cds::${branch}`);
    expect(result.provenance.find((entry) => entry.key === 'VITE_GIT_BRANCH')).toMatchObject({
      source: 'platform-injected', detail: 'version-metadata',
    });
  });

  it('never invents main when no branch authority is supplied', () => {
    delete process.env.VITE_GIT_BRANCH;
    expect(identityTemplate).toBe('prd-agent:cds::${VITE_GIT_BRANCH}');
    expect(() => resolveProfileRuntimeEnvWithProvenance(
      { branch: '' }, { dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0' }, [],
      [{ source: 'profile', env: { [identityKey]: identityTemplate } }], { jwtIssuer: 'test-only' },
    )).toThrow('环境变量模板缺少值: VITE_GIT_BRANCH');
  });

  it('bakes the validated build argument into the published console assembly', () => {
    const buildStage = dockerfile.split(/^FROM .* AS final$/m)[0];
    expect(buildStage).toMatch(/^ARG GIT_COMMIT=""$/m);
    expect(buildStage).toMatch(/dotnet publish[^\n]*\/p:SourceRevisionId="\$GIT_COMMIT"/);
    expect(readFileSync(new URL('.dockerignore', root), 'utf8')).toMatch(/^\.git$/m);
  });

  it.each(['a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'a'.repeat(39) + ';'])(
    'rejects an invalid commit before publishing (%s)', (commit) => {
      expect(() => runBuildValidation(commit)).toThrow();
    },
  );

  it('allows the existing development Compose to build without a version', () => {
    const dev = load(readFileSync(new URL('docker-compose.dev.yml', root), 'utf8')) as {
      services: { llmgw: { build: { args?: Record<string, string> } } };
    };
    expect(dev.services.llmgw.build.args?.GIT_COMMIT).toBeUndefined();
    expect(runBuildValidation('')).toBe('');
  });

  it.each(['a'.repeat(40), '0123456789ABCDEF'.repeat(2) + '01234567'])(
    'accepts only a complete hexadecimal commit (%s)', (commit) => {
      expect(runBuildValidation(commit)).toBe(commit);
    },
  );
});

function runBuildValidation(commit: string): string {
  // Execute the actual Docker RUN precondition in sh; no mirrored validator or Docker daemon.
  const publishRun = dockerfile.match(/^RUN if[\s\S]*?&& dotnet publish[^\n]*/m)?.[0];
  expect(publishRun).toBeDefined();
  const validation = publishRun!.slice(4).split('&& dotnet publish')[0].replace(/\\\n/g, ' ');
  return execFileSync('sh', ['-c', `${validation} && printf '%s' "$GIT_COMMIT"`], {
    cwd: fileURLToPath(root), env: { ...process.env, GIT_COMMIT: commit }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
