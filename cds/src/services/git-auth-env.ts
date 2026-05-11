import type { CdsConfig, ExecOptions } from '../types.js';
import type { StateService } from './state.js';
import type { GitHubAppClient } from './github-app-client.js';

export interface GitAuthEnvInput {
  repoRoot: string;
  config: CdsConfig;
  stateService: StateService;
  githubApp?: GitHubAppClient | null;
}

export interface GitAuthEnvResult {
  env?: ExecOptions['env'];
  source: 'github-app' | 'device-flow' | 'none';
  projectId?: string;
}

function gitExtraHeaderEnv(token: string): ExecOptions['env'] {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function projectForRepoRoot(input: GitAuthEnvInput) {
  const normalized = input.repoRoot;
  const exact = input.stateService.getProjects().find((p) => p.repoPath === normalized);
  if (exact) return exact;
  const branch = input.stateService.getAllBranches().find((b) => b.worktreePath === normalized);
  if (branch?.projectId) {
    const project = input.stateService.getProject(branch.projectId);
    if (project) return project;
  }
  return input.stateService.resolveProjectForAutoBuild(normalized);
}

/**
 * Build a git env that lets non-interactive fetch/ls-remote access private
 * GitHub repos. Prefer the project-linked GitHub App installation token, and
 * fall back to the one-slot Device Flow token used by the clone UI.
 */
export async function resolveGitAuthEnv(input: GitAuthEnvInput): Promise<GitAuthEnvResult> {
  const project = projectForRepoRoot(input);
  if (input.githubApp && project?.githubInstallationId) {
    const token = await input.githubApp.getInstallationToken(project.githubInstallationId);
    return {
      env: gitExtraHeaderEnv(token),
      source: 'github-app',
      projectId: project.id,
    };
  }

  const deviceToken = input.stateService.getGithubDeviceAuth()?.token;
  if (deviceToken) {
    return {
      env: gitExtraHeaderEnv(deviceToken),
      source: 'device-flow',
      projectId: project?.id,
    };
  }

  return {
    env: { GIT_TERMINAL_PROMPT: '0' },
    source: 'none',
    projectId: project?.id,
  };
}

export function mergeGitAuthEnv(base: ExecOptions | undefined, auth: GitAuthEnvResult): ExecOptions {
  return {
    ...(base || {}),
    env: {
      ...(base?.env || {}),
      ...(auth.env || { GIT_TERMINAL_PROMPT: '0' }),
    },
  };
}
