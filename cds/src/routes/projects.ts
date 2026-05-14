/**
 * Projects API router.
 *
 * P1 (initial shell) served a single hard-coded "default" project.
 *
 * P4 Part 1 taught the router to read StateService.getProjects() and
 * rely on the migration that auto-creates a "legacy default" project.
 *
 * P4 Part 2 (this commit) wires up real creation and deletion:
 *   - POST /api/projects   → validates input, generates id + slug,
 *                            creates a dedicated docker network
 *                            (`cds-proj-<id>`), persists via
 *                            StateService.addProject(). Rolls the
 *                            network back if the save fails.
 *   - DELETE /api/projects/:id → refuses the legacy project, removes
 *                            the docker network, then removes the
 *                            state entry via StateService.removeProject().
 *
 * P4 Part 3 will thread projectId into Branch/BuildProfile/InfraService/
 * RoutingRule so that project-scoped listings and deletes cascade
 * correctly.
 *
 * See doc/design.cds-multi-project.md,
 * doc/plan.cds-multi-project-phases.md P4.
 */

import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import type { StateService } from '../services/state.js';
import { detectStack, detectModules, type StackDetection } from '../services/stack-detector.js';
import { discoverComposeFiles, parseCdsCompose } from '../services/compose-parser.js';
import { deriveEnvMetaForVars } from '../services/env-classifier.js';
import { ProjectFilesService, ProjectFileError, type ProjectFilePayload } from '../services/project-files.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { IShellExecutor, Project, CdsConfig, AgentKey, BuildProfile, InfraService } from '../types.js';
import { combinedOutput } from '../types.js';

type OnboardingRuntime = NonNullable<Project['onboardingRuntime']>;
type OnboardingService = NonNullable<Project['onboardingServices']>[number];

interface InfraPresetDefinition {
  id: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  env?: Record<string, string>;
  envVars?: Record<string, string>;
}

const ONBOARDING_RUNTIMES = new Set<OnboardingRuntime>([
  'auto',
  'node',
  'python',
  'dotnet',
  'java',
  'go',
  'rust',
  'php',
  'static',
  'dockerfile',
  'custom',
]);
const INFRA_PRESETS = new Set(['mongodb', 'postgres', 'mysql', 'redis', 'rabbitmq']);

export interface ProjectsRouterDeps {
  stateService: StateService;
  /** Shell for docker network create/inspect/rm. Injectable for tests. */
  shell: IShellExecutor;
  /** Root CDS config — unused in Part 2 but reserved for Part 3 when we derive per-project paths. */
  config?: CdsConfig;
  /** Kept for backward compat with P1 callers; ignored. */
  legacyProjectName?: string;
}

/**
 * Stable identifier of the migration-created legacy project. Exported
 * so tests can assert on it and the frontend can special-case it for
 * labelling and to hide the delete button.
 */
export const LEGACY_PROJECT_ID = 'default';

/**
 * Maximum length of `Project.name` we accept on POST. Long names would
 * overflow the UI card and the docker network name derivation.
 */
const MAX_NAME_LENGTH = 60;

/**
 * Regex for acceptable slugs. Matches kebab/alphanumeric and forbids
 * leading/trailing dashes. Kept permissive enough that the user can
 * pass their own slug, strict enough to be URL- and docker-safe.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;

/**
 * Derive a URL-friendly slug from a free-form project name. Same
 * algorithm as CdsConfig.repoRoot → projectSlug in StateService so
 * legacy and newly-created projects use a consistent slug style.
 */
function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'project';
}

/**
 * Generate a short, stable-across-restarts-until-deletion project id.
 * We use a 12-char hex (6 random bytes) — collision-free enough for a
 * single-node CDS with at most a few dozen projects, and short enough
 * to embed into the docker network name without wrapping.
 */
function generateProjectId(): string {
  return randomBytes(6).toString('hex');
}

/** Derive the dedicated docker network name for a project. */
function dockerNetworkFor(projectId: string): string {
  return `cds-proj-${projectId}`;
}

/**
 * P4 Part 18 (Phase E audit fix #9): strip userinfo (user:password@)
 * from a git URL before storing or echoing it. This prevents the
 * common footgun where a user pastes
 *   https://token:x-oauth-basic@github.com/foo/bar.git
 * and we persist the token to state.json in plain text.
 *
 * We keep http/https/ssh/file URLs parseable via the standard URL
 * class, and fall back to a regex for the SSH shorthand
 * (git@github.com:foo/bar.git) which the URL class doesn't parse.
 */
export function _redactUrlUserInfo(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    // Not a URL the standard parser understands — keep it as-is.
    // SSH shorthand (git@host:path) has no userinfo concept, it's
    // just the user the remote expects. No redaction needed.
    return raw;
  }
}

/**
 * P4 Part 18 (Phase E audit fix #1): rewrite a public github.com
 * HTTPS URL to include the Device Flow access token so private repos
 * clone successfully.
 *
 * Rules:
 *   - URL must be https://github.com/... (any other host is left alone)
 *   - URL must not already carry userinfo (we don't override explicit
 *     credentials because the user might be intentionally testing)
 *   - token must be non-empty
 * Returns the original URL when any rule fails.
 *
 * The token is only used in the ephemeral shell argument — NEVER
 * persisted to state.json (which stores the original `gitRepoUrl`).
 */
export function _injectGithubTokenIfPossible(raw: string, token: string | undefined): string {
  if (!token) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== 'https:') return raw;
  if (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com')) return raw;
  if (u.username || u.password) return raw;
  // GitHub recommends `x-access-token` as the username for Device-Flow
  // tokens on HTTPS clones. See
  // https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

/**
 * Does the given URL look like an HTTPS github.com clone URL?
 * Used by the UF-01 preflight check in the clone route.
 */
export function _isGithubHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'github.com' || u.hostname.endsWith('.github.com');
}

/**
 * Extract "owner/repo" from common GitHub clone URL formats.
 *
 * This lets project creation auto-bind the repo for webhook routing
 * when the user picked or pasted a GitHub URL. Installation id can be
 * filled later from the incoming webhook payload; routing only needs
 * repository.full_name.
 */
export function _githubFullNameFromCloneUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  const clean = _redactUrlUserInfo(raw.trim());
  let ownerRepo = '';
  try {
    const u = new URL(clean);
    if (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com')) return undefined;
    ownerRepo = u.pathname.replace(/^\/+/, '').replace(/\.git$/i, '');
  } catch {
    const m = clean.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) ownerRepo = m[1];
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ownerRepo)) return undefined;
  return ownerRepo;
}

/**
 * Translate a raw git clone stderr blob into a Chinese actionable
 * message when it matches known "no credentials available" patterns.
 * Returns the original message on no-match. Used by the UF-01 fix in
 * the clone route so users hitting a private-repo clone without a
 * Device Flow token see a clear "please sign in first" instead of
 * the bare english "could not read Username" error.
 */
export function _mapGitCloneError(rawMsg: string, isGithubUrl: boolean, hasDeviceToken: boolean): string {
  const msg = rawMsg || '';
  const looksLikeAuthProblem =
    /could not read Username/i.test(msg) ||
    /terminal prompts disabled/i.test(msg) ||
    /Authentication failed/i.test(msg) ||
    /remote: Repository not found/i.test(msg);
  if (!looksLikeAuthProblem) return msg;
  if (isGithubUrl && !hasDeviceToken) {
    return (
      '无法访问该 GitHub 仓库:未登录 GitHub。\n' +
      '请点击 Settings → GitHub 完成 Device Flow 登录,或在创建对话框内点击"使用 GitHub 登录",然后重试克隆。\n\n' +
      '原始 git 错误:\n' + msg
    );
  }
  if (isGithubUrl && hasDeviceToken) {
    return (
      '已登录 GitHub 但仍无法访问该仓库。可能原因:\n' +
      '- 当前 token 的 scope 不包含该仓库(请确认授权时勾选了 repo)\n' +
      '- 该仓库属于未授权给 GitHub App 的组织\n' +
      '- token 已过期或被撤销(请在 Settings → GitHub 重新登录)\n\n' +
      '原始 git 错误:\n' + msg
    );
  }
  return msg;
}

/**
 * Format a plaintext Agent Key preview for display.
 * Returns `cdsp_<slug>_<first12>…<last4>` so the UI can show "this is the
 * one" without exposing the full secret. Only called at sign time when we
 * still have the plaintext in hand.
 */
function formatKeyPreview(plaintext: string): string {
  const lastUnderscore = plaintext.lastIndexOf('_');
  if (lastUnderscore < 0) return plaintext;
  const prefix = plaintext.slice(0, lastUnderscore + 1);
  const suffix = plaintext.slice(lastUnderscore + 1);
  if (suffix.length <= 16) return plaintext;
  return prefix + suffix.slice(0, 12) + '…' + suffix.slice(-4);
}

/**
 * Minimal helper that enforces a project-key request can only touch its
 * own project. Returns null when access is allowed (or when the request
 * isn't using a project key at all), or a `{ status, body }` object for
 * the caller to `res.status(x).json(y)` on mismatch.
 *
 * This is NOT a middleware — we inline-call it at the top of the 5-6
 * write-heavy routes we care about. Read-only GETs don't need it.
 */
export function assertProjectAccess(
  req: { cdsProjectKey?: { projectId: string; keyId: string } },
  targetProjectId: string | undefined,
): null | { status: number; body: Record<string, unknown> } {
  const projectKey = req.cdsProjectKey;
  if (!projectKey) return null; // bootstrap key or cookie auth — no scope check
  if (!targetProjectId) return null; // no target to check against
  if (projectKey.projectId === targetProjectId) return null;
  return {
    status: 403,
    body: {
      error: 'project_mismatch',
      expected: projectKey.projectId,
      got: targetProjectId,
      message:
        '这把 key 只能操作 ' + projectKey.projectId + ' 项目，请让用户在目标项目页重新「授权 Agent」',
    },
  };
}

/**
 * Roll-up runtime stats rendered on the project list card so the user
 * can tell at a glance whether a project is alive without clicking in.
 *
 * - branchCount: total branches in the project (including cold / error)
 * - runningBranchCount: branches with at least one running service
 * - runningServiceCount: sum of services in `running` state across branches
 * - lastDeployedAt: max(lastAccessedAt) across branches; BranchEntry
 *   updates lastAccessedAt on deploy completion (branches.ts:1210/1366),
 *   so this is a good "latest deploy" proxy. null when no branch ever
 *   deployed. Cached values from state.json — not a live docker check.
 */
interface ProjectStats {
  branchCount: number;
  runningBranchCount: number;
  appServiceCount: number;
  runningServiceCount: number;
  appServices: Array<{
    id: string;
    branch: string;
    status?: string;
    runningCount?: number;
  }>;
  infraServiceCount: number;
  runningInfraServiceCount: number;
  infraServices: Array<{
    id: string;
    name?: string;
    status?: string;
    dockerImage?: string;
  }>;
  lastDeployedAt: string | null;
}

const EMPTY_STATS: ProjectStats = {
  branchCount: 0,
  runningBranchCount: 0,
  appServiceCount: 0,
  runningServiceCount: 0,
  appServices: [],
  infraServiceCount: 0,
  runningInfraServiceCount: 0,
  infraServices: [],
  lastDeployedAt: null,
};

interface ProjectSummary extends Project, ProjectStats {}

function toSummary(project: Project, stats: ProjectStats): ProjectSummary {
  return { ...project, ...stats };
}

async function resolveRemoteDefaultBranch(shell: IShellExecutor, repoPath: string): Promise<string | null> {
  const headResult = await shell.exec(
    'git symbolic-ref --short refs/remotes/origin/HEAD',
    { cwd: repoPath, timeout: 5_000 },
  );
  if (headResult.exitCode !== 0) return null;
  return headResult.stdout.trim().replace(/^origin\//, '') || null;
}

/**
 * SECURITY P1 (2026-05-09): mask plaintext values in `customEnv` /
 * `defaultEnv` when the caller is NOT this project's owner.
 *
 * Audit P1 PoC: `curl -H "X-AI-Access-Key: $static" /api/projects` returned
 * customEnv with ROOT_ACCESS_PASSWORD / JWT_SECRET / GITHUB_PAT / the
 * AI_ACCESS_KEY itself in plaintext. Static keys, cdsg_ global keys, and
 * unscoped sessions are NOT project owners — they get the key names but
 * not the values. Project-scoped cdsp_ keys (matching project) and human
 * cookie sessions get the real values.
 *
 * We replace each value with `***[masked]***` so the UI can still render
 * "X env vars configured" and the user knows which keys exist, but no
 * machine credential walks away with the secret material.
 */
function hasOwnerAccess(req: unknown, projectId: string): boolean {
  const r = req as {
    cdsProjectKey?: { projectId: string };
    _cdsCookieAuth?: boolean;
  };
  if (r._cdsCookieAuth === true) return true;
  if (r.cdsProjectKey && r.cdsProjectKey.projectId === projectId) return true;
  return false;
}

function maskEnvMap(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const k of Object.keys(env)) out[k] = '***[masked]***';
  return out;
}

function maskProjectSummary<T extends ProjectSummary>(req: unknown, summary: T): T {
  if (hasOwnerAccess(req, summary.id)) return summary;
  return {
    ...summary,
    customEnv: maskEnvMap(summary.customEnv),
    defaultEnv: maskEnvMap(summary.defaultEnv),
  };
}

export function createProjectsRouter(deps: ProjectsRouterDeps): Router {
  const router = Router();
  const { stateService, shell, config } = deps;

  function statsFor(project: Project): ProjectStats {
    // P4 Part 17 (G9 fix): use the project-scoped helper so non-legacy
    // projects show their real branch count instead of always 0. The
    // helper treats branches without a projectId as belonging to the
    // legacy 'default' project, which preserves the pre-P4 rollup
    // behaviour for the legacy project.
    const isSharedService = project.kind === 'shared-service';
    const branches = isSharedService ? [] : stateService.getBranchesForProject(project.id);
    let runningBranchCount = 0;
    let appServiceCount = 0;
    let runningServiceCount = 0;
    let lastDeployedAt: string | null = null;
    const appServiceMap = new Map<string, ProjectStats['appServices'][number]>();
    const infra = stateService.getInfraServicesForProject(project.id);
    const runningInfra = infra.filter((service) => service.status === 'running').length;
    for (const b of branches) {
      const services = Object.values(b.services || {});
      appServiceCount += services.length;
      const runningHere = services.filter((s) => s.status === 'running').length;
      if (runningHere > 0) runningBranchCount++;
      runningServiceCount += runningHere;
      for (const service of services) {
        if (service.status === 'running') {
          const existing = appServiceMap.get(service.profileId);
          if (existing) {
            existing.runningCount = (existing.runningCount || 1) + 1;
          } else {
            appServiceMap.set(service.profileId, {
              id: service.profileId,
              branch: b.branch,
              status: service.status,
              runningCount: 1,
            });
          }
        }
      }
      if (b.lastAccessedAt && (!lastDeployedAt || b.lastAccessedAt > lastDeployedAt)) {
        lastDeployedAt = b.lastAccessedAt;
      }
    }
    return {
      branchCount: branches.length,
      runningBranchCount,
      appServiceCount,
      runningServiceCount,
      appServices: Array.from(appServiceMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
      infraServiceCount: infra.length,
      runningInfraServiceCount: runningInfra,
      infraServices: infra.map((service) => ({
        id: service.id,
        name: service.name,
        status: service.status,
        dockerImage: service.dockerImage,
      })),
      lastDeployedAt,
    };
  }

  /**
   * Idempotent docker network create. If the network already exists
   * (exit code 0 from `docker network inspect`) this is a no-op.
   * Otherwise we run `docker network create` and throw on failure so
   * the caller can roll back the state mutation.
   */
  async function ensureDockerNetwork(name: string): Promise<void> {
    const inspect = await shell.exec(`docker network inspect ${name}`);
    if (inspect.exitCode === 0) return;
    const create = await shell.exec(`docker network create ${name}`);
    if (create.exitCode !== 0) {
      throw new Error(
        `Failed to create Docker network "${name}": ${combinedOutput(create)}`,
      );
    }
  }

  /**
   * Remove a docker network. Best-effort: we log on failure but don't
   * block the state deletion, because a dangling network is far less
   * harmful than a zombie project entry that the user can't remove.
   */
  async function removeDockerNetwork(name: string): Promise<{ ok: boolean; detail?: string }> {
    // Check existence first so we don't emit a spurious error on a
    // re-attempted delete.
    const inspect = await shell.exec(`docker network inspect ${name}`);
    if (inspect.exitCode !== 0) return { ok: true, detail: 'network already gone' };
    const rm = await shell.exec(`docker network rm ${name}`);
    if (rm.exitCode !== 0) {
      return { ok: false, detail: combinedOutput(rm) };
    }
    return { ok: true };
  }

  function autoProfileHandle(detection: StackDetection): 'api' | 'web' | 'app' {
    if (detection.framework === 'nextjs' || detection.framework === 'remix' || detection.framework === 'vite-react') {
      return 'web';
    }
    if (
      detection.framework === 'express' ||
      detection.framework === 'nestjs' ||
      detection.framework === 'django' ||
      detection.framework === 'fastapi' ||
      detection.framework === 'flask' ||
      detection.framework === 'rails'
    ) {
      return 'api';
    }
    if (['nodejs', 'python', 'go', 'rust', 'java', 'ruby', 'php'].includes(detection.stack)) {
      return 'api';
    }
    return 'app';
  }

  function profileIdSlug(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42) || 'project';
  }

  function nextAutoProfileId(project: Project, handle: string): string {
    const allIds = new Set(stateService.getBuildProfiles().map((p) => p.id));
    const slug = profileIdSlug(project.slug || project.name || project.id);
    const shortId = profileIdSlug(project.id).slice(0, 12) || 'project';
    const candidates = [handle, `${slug}-${handle}`, `${shortId}-${handle}`];
    for (const candidate of candidates) {
      if (!allIds.has(candidate)) return candidate;
    }
    for (let i = 2; i <= 99; i++) {
      const candidate = `${slug}-${handle}-${i}`;
      if (!allIds.has(candidate)) return candidate;
    }
    return `${shortId}-${handle}-${Date.now().toString(36)}`;
  }

  function composeAutoCommand(detection: StackDetection): string {
    const install = detection.installCommand?.trim();
    const build = detection.buildCommand?.trim();
    const run = detection.runCommand?.trim();
    const parts: string[] = [];
    if (install) parts.push(install);
    if (build && (!run || !run.includes(build))) parts.push(build);
    if (run) parts.push(run);
    return parts.join(' && ');
  }

  function defaultCacheMountsFor(image: string): BuildProfile['cacheMounts'] {
    const cacheBase = stateService.getCacheBase();
    const mounts: NonNullable<BuildProfile['cacheMounts']> = [];
    if (image.includes('node')) {
      mounts.push({ hostPath: `${cacheBase}/pnpm`, containerPath: '/pnpm/store' });
    }
    if (image.includes('dotnet')) {
      mounts.push({ hostPath: `${cacheBase}/nuget`, containerPath: '/root/.nuget/packages' });
    }
    return mounts.length > 0 ? mounts : undefined;
  }

  function recommendedVolumePathsForImage(image: string): string[] | null {
    const lower = (image || '').toLowerCase();
    const baseRaw = lower.split('/').pop() || lower;
    const base = baseRaw.split(':')[0];
    if (base.startsWith('mysql') || base.startsWith('mariadb')) return ['/var/lib/mysql'];
    if (base.startsWith('postgres')) return ['/var/lib/postgresql/data'];
    if (base.startsWith('redis')) return ['/data'];
    if (base.startsWith('mongo')) return ['/data/db'];
    if (base.startsWith('rabbitmq')) return ['/var/lib/rabbitmq'];
    return null;
  }

  function recommendedInfraVolumes(project: Project, infraId: string, image: string): InfraService['volumes'] {
    const paths = recommendedVolumePathsForImage(image);
    if (!paths) return [];
    const prefix = project.legacyFlag ? infraId : `${project.slug.slice(0, 12)}-${infraId}`;
    return paths.map((containerPath, idx) => ({
      name: `cds-${prefix}-data${idx === 0 ? '' : `-${idx + 1}`}`,
      containerPath,
      type: 'volume' as const,
    }));
  }

  function makeSecret(bytes = 10): string {
    return randomBytes(bytes).toString('hex');
  }

  function createInfraPreset(project: Project, presetId: string): InfraPresetDefinition | null {
    if (presetId === 'mongodb') {
      const user = 'app';
      const password = makeSecret();
      return {
        id: 'mongodb',
        name: 'MongoDB',
        dockerImage: 'mongo:7',
        containerPort: 27017,
        env: {
          MONGO_INITDB_ROOT_USERNAME: user,
          MONGO_INITDB_ROOT_PASSWORD: password,
        },
        envVars: {
          MONGODB_URL: `mongodb://${user}:${password}@mongodb:27017/app?authSource=admin`,
        },
      };
    }
    if (presetId === 'postgres') {
      const password = makeSecret();
      return {
        id: 'postgres',
        name: 'PostgreSQL',
        dockerImage: 'postgres:16-alpine',
        containerPort: 5432,
        env: {
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: 'app',
        },
        envVars: {
          DATABASE_URL: `postgresql://app:${password}@postgres:5432/app`,
          POSTGRES_URL: `postgresql://app:${password}@postgres:5432/app`,
        },
      };
    }
    if (presetId === 'mysql') {
      const rootPassword = makeSecret();
      const password = makeSecret();
      return {
        id: 'mysql',
        name: 'MySQL',
        dockerImage: 'mysql:8',
        containerPort: 3306,
        env: {
          MYSQL_ROOT_PASSWORD: rootPassword,
          MYSQL_DATABASE: 'app',
          MYSQL_USER: 'app',
          MYSQL_PASSWORD: password,
        },
        envVars: {
          DATABASE_URL: `mysql://app:${password}@mysql:3306/app`,
          MYSQL_URL: `mysql://app:${password}@mysql:3306/app`,
        },
      };
    }
    if (presetId === 'redis') {
      return {
        id: 'redis',
        name: 'Redis',
        dockerImage: 'redis:7-alpine',
        containerPort: 6379,
        envVars: {
          REDIS_URL: 'redis://redis:6379',
        },
      };
    }
    if (presetId === 'rabbitmq') {
      const password = makeSecret();
      return {
        id: 'rabbitmq',
        name: 'RabbitMQ',
        dockerImage: 'rabbitmq:3-management-alpine',
        containerPort: 5672,
        env: {
          RABBITMQ_DEFAULT_USER: 'app',
          RABBITMQ_DEFAULT_PASS: password,
        },
        envVars: {
          RABBITMQ_URL: `amqp://app:${password}@rabbitmq:5672`,
        },
      };
    }
    return null;
  }

  function applyInfraPresets(project: Project, presetIds: string[]): string[] {
    const unique = Array.from(new Set(presetIds.filter((id) => INFRA_PRESETS.has(id))));
    if (unique.length === 0) return [];
    const existingInfraIds = new Set(stateService.getInfraServicesForProject(project.id).map((service) => service.id));
    const applied: string[] = [];
    const envMeta = stateService.getEnvMeta(project.id);
    for (const presetId of unique) {
      const preset = createInfraPreset(project, presetId);
      if (!preset || existingInfraIds.has(preset.id)) continue;
      const containerName = project.legacyFlag
        ? `cds-infra-${preset.id}`
        : `cds-infra-${project.slug.slice(0, 12)}-${preset.id}`;
      const service: InfraService = {
        id: preset.id,
        projectId: project.id,
        name: preset.name,
        dockerImage: preset.dockerImage,
        containerPort: preset.containerPort,
        hostPort: stateService.allocatePort(config?.portStart || 10000),
        containerName,
        status: 'stopped',
        volumes: recommendedInfraVolumes(project, preset.id, preset.dockerImage),
        env: preset.env || {},
        createdAt: new Date().toISOString(),
      };
      stateService.addInfraService(service);
      applied.push(service.id);
      for (const [key, value] of Object.entries(preset.envVars || {})) {
        stateService.setCustomEnvVar(key, value, project.id);
        envMeta[key] = {
          kind: 'infra-derived',
          hint: `${preset.name} 连接串，由 CDS 创建基础设施时生成`,
        };
      }
    }
    if (Object.keys(envMeta).length > 0) {
      stateService.setEnvMeta(project.id, envMeta);
    }
    if (applied.length > 0) {
      stateService.save();
    }
    return applied;
  }

  function runtimeProfilePreset(project: Project, service?: OnboardingService): BuildProfile | null {
    const runtime = service?.runtime || project.onboardingRuntime;
    if (!runtime || runtime === 'auto') return null;
    if (runtime === 'dockerfile') return null;
    const id = nextAutoProfileId(project, service?.id || (runtime === 'custom' ? 'app' : 'api'));
    const customImage = ((service?.dockerImage || project.onboardingDockerImage) || '').trim();
    const customCommand = ((service?.command || project.onboardingCommand) || '').trim();
    const customPort = service?.port && service.port > 0
      ? service.port
      : project.onboardingPort && project.onboardingPort > 0
        ? project.onboardingPort
        : undefined;
    const presets: Record<Exclude<OnboardingRuntime, 'auto' | 'custom' | 'dockerfile'>, { name: string; image: string; command: string; port: number }> = {
      node: {
        name: 'Node.js 服务',
        image: customImage || 'node:20-alpine',
        command: customCommand || 'corepack enable && (pnpm install --frozen-lockfile || npm install) && (pnpm start || npm run start)',
        port: customPort || 3000,
      },
      python: {
        name: 'Python 服务',
        image: customImage || 'python:3.12-slim',
        command: customCommand || 'pip install -r requirements.txt && (python app.py || python main.py)',
        port: customPort || 8000,
      },
      dotnet: {
        name: '.NET 服务',
        image: customImage || 'mcr.microsoft.com/dotnet/sdk:8.0',
        command: customCommand || 'dotnet restore && dotnet run --urls http://0.0.0.0:${PORT}',
        port: customPort || 5000,
      },
      java: {
        name: 'Java 服务',
        image: customImage || 'maven:3.9-eclipse-temurin-21',
        command: customCommand || 'mvn -DskipTests package && java -jar target/*.jar',
        port: customPort || 8080,
      },
      go: {
        name: 'Go 服务',
        image: customImage || 'golang:1.23-alpine',
        command: customCommand || 'go mod download && go run .',
        port: customPort || 8080,
      },
      rust: {
        name: 'Rust 服务',
        image: customImage || 'rust:1.82-slim',
        command: customCommand || 'cargo run --release',
        port: customPort || 8080,
      },
      php: {
        name: 'PHP 服务',
        image: customImage || 'php:8.3-cli',
        command: customCommand || 'php -S 0.0.0.0:${PORT} -t public',
        port: customPort || 8000,
      },
      static: {
        name: '静态站点',
        image: customImage || 'node:20-alpine',
        command: customCommand || 'corepack enable && (pnpm install --frozen-lockfile || npm install) && (pnpm build || npm run build) && npx serve -s dist -l ${PORT}',
        port: customPort || 4173,
      },
    };
    const resolved = runtime === 'custom'
      ? {
          name: '自定义服务',
          image: customImage,
          command: customCommand,
          port: customPort || 8080,
        }
      : presets[runtime];
    if (!resolved.image || !resolved.command) return null;
    return {
      id,
      name: service?.name || resolved.name,
      projectId: project.id,
      dockerImage: resolved.image,
      workDir: '.',
      containerPort: resolved.port,
      command: resolved.command,
      env: { PORT: String(resolved.port) },
      ...(service?.role === 'backend' ? { pathPrefixes: ['/api/'] } : {}),
      ...(service?.role === 'frontend' ? { pathPrefixes: ['/'] } : {}),
      ...(defaultCacheMountsFor(resolved.image) ? { cacheMounts: defaultCacheMountsFor(resolved.image) } : {}),
    };
  }

  function applyRuntimeHintProfiles(
    project: Project,
    sendEvent: (event: string, data: unknown) => void,
  ): boolean {
    const serviceHints = Array.isArray(project.onboardingServices)
      ? project.onboardingServices.filter((service) => service.runtime && service.runtime !== 'auto')
      : [];
    const profiles = serviceHints.length > 0
      ? serviceHints.map((service) => runtimeProfilePreset(project, service)).filter((profile): profile is BuildProfile => Boolean(profile))
      : [runtimeProfilePreset(project)].filter((profile): profile is BuildProfile => Boolean(profile));
    if (profiles.length === 0) return false;
    for (const profile of profiles) {
      stateService.addBuildProfile(profile);
    }
    stateService.save();
    sendEvent('progress', {
      line: `[profile] 已按所选应用服务创建 ${profiles.length} 个构建配置: ${profiles.map((profile) => profile.name).join('、')}`,
    });
    sendEvent('profile', {
      status: 'created',
      source: 'runtime-hint',
      profileId: profiles[0].id,
      profileIds: profiles.map((profile) => profile.id),
      dockerImage: profiles[0].dockerImage,
      containerPort: profiles[0].containerPort,
      command: profiles[0].command,
    });
    return true;
  }

  /**
   * Import a `cds-compose.yml` file straight into the project: parse via
   * parseCdsCompose() and apply the resulting buildProfiles + infraServices
   * + customEnv. Mirrors the logic of POST /api/pending-imports/:id/approve
   * but runs inline as part of clone — for the case where the user is the
   * one initiating the action (no human approval needed).
   *
   * Returns true when at least one profile/infra/env entry was applied;
   * false on parse failure so the caller can fall through to heuristic
   * stack detection.
   */
  function importCdsComposeFromFile(
    project: Project,
    composePath: string,
    sendEvent: (event: string, data: unknown) => void,
  ): boolean {
    let yamlText: string;
    try {
      yamlText = nodeFs.readFileSync(composePath, 'utf-8');
    } catch (err) {
      sendEvent('progress', { line: `[detect] 读取 ${nodePath.basename(composePath)} 失败：${(err as Error).message}` });
      return false;
    }

    const parsed = parseCdsCompose(yamlText);
    if (!parsed) {
      sendEvent('progress', { line: `[detect] ${nodePath.basename(composePath)} 解析失败，回退到启发式扫描` });
      return false;
    }

    const idSuffix = project.legacyFlag ? '' : `-${project.slug}`;

    // ── BuildProfiles ──
    const appliedProfiles: string[] = [];
    for (const candidate of parsed.buildProfiles) {
      const scoped: BuildProfile = {
        ...(candidate as BuildProfile),
        id: `${candidate.id}${idSuffix}`,
        projectId: project.id,
      };
      const existing = stateService.getBuildProfile(scoped.id);
      if (existing) {
        stateService.updateBuildProfile(scoped.id, scoped);
      } else {
        stateService.addBuildProfile(scoped);
      }
      appliedProfiles.push(scoped.id);
      sendEvent('progress', {
        line: `[profile] 已创建 ${scoped.id}: ${scoped.dockerImage} · ${(scoped.command || '').slice(0, 60)}${(scoped.command || '').length > 60 ? '…' : ''}`,
      });
    }

    // ── Env vars (project-scoped, do not clobber existing keys) ──
    const existingEnv = stateService.getCustomEnv(project.id);
    const appliedEnvKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed.envVars || {})) {
      if (!(key in existingEnv)) {
        stateService.setCustomEnvVar(key, value, project.id);
        appliedEnvKeys.push(key);
      }
    }
    if (appliedEnvKeys.length > 0) {
      sendEvent('progress', {
        line: `[env] 已注入 ${appliedEnvKeys.length} 个项目环境变量${appliedEnvKeys.some((k) => /TODO|请填写/i.test(parsed.envVars?.[k] || '')) ? '（含占位 TODO，请到项目设置补全）' : ''}`,
      });
    }

    // Phase 8 — env metadata + defaultEnv 同步落库
    // metadata 决定 deploy 是否 block + UI 弹窗如何展示;defaultEnv 给新分支继承
    //
    // F6 fix(2026-05-01 onboarding UAT)— 当 yml 没声明 x-cds-env-meta 段时,
    // 之前直接跳过 setEnvMeta,导致前端 EnvSetupDialog 收到 envMeta={} 无法
    // 做三色分类显示,用户面对一堆 env 不知道哪个必填。
    // 现改为 deriveEnvMetaForVars 兜底:对每个 envVar 用 classifyEnvKind 推断
    // (TODO 占位符 → required,${VAR} → infra-derived,密钥 key 空值 → required,
    // 其它 → auto)。yml 已声明的 explicit meta 优先,fallback 只填补缺失项。
    const explicitMeta = parsed.envMeta || {};
    const derivedMeta = deriveEnvMetaForVars(parsed.envVars || {}, explicitMeta);
    if (Object.keys(derivedMeta).length > 0) {
      stateService.setEnvMeta(project.id, derivedMeta);
      const requiredCount = Object.values(derivedMeta).filter((m) => m.kind === 'required').length;
      const autoCount = Object.values(derivedMeta).filter((m) => m.kind === 'auto').length;
      const derivedCount = Object.values(derivedMeta).filter((m) => m.kind === 'infra-derived').length;
      const explicitCount = Object.keys(explicitMeta).length;
      const inferredCount = Object.keys(derivedMeta).length - explicitCount;
      const source = inferredCount === 0
        ? 'yml 显式声明'
        : explicitCount === 0
          ? 'CDS 自动推断'
          : `${explicitCount} yml + ${inferredCount} 自动推断`;
      sendEvent('progress', {
        line: `[env-meta] ${requiredCount} 项必填用户 / ${autoCount} 项 CDS 自动生成 / ${derivedCount} 项基础设施推导(${source})`,
      });
    }
    // 项目级默认 env 模板:用于新分支创建时拷贝(导入时 customEnv 也是同一份)
    if (Object.keys(parsed.envVars || {}).length > 0) {
      stateService.setDefaultEnv(project.id, parsed.envVars || {});
    }

    // ── Infra services ──
    const existingInfraIds = new Set(
      stateService.getInfraServicesForProject(project.id).map((s) => s.id),
    );
    const appliedInfra: string[] = [];
    for (const def of parsed.infraServices) {
      if (!def.id || !def.dockerImage || !def.containerPort) continue;
      if (existingInfraIds.has(def.id)) continue;
      const containerName = project.legacyFlag
        ? `cds-infra-${def.id}`
        : `cds-infra-${project.slug.slice(0, 12)}-${def.id}`;
      const service: InfraService = {
        id: def.id,
        projectId: project.id,
        name: def.name || def.id,
        dockerImage: def.dockerImage,
        containerPort: def.containerPort,
        hostPort: stateService.allocatePort(10000),
        containerName,
        status: 'stopped',
        volumes: def.volumes || [],
        env: def.env || {},
        healthCheck: def.healthCheck,
        createdAt: new Date().toISOString(),
      };
      stateService.addInfraService(service);
      appliedInfra.push(service.id);
      sendEvent('progress', {
        line: `[infra] 已创建 ${service.id} (${service.dockerImage}) → 端口 ${service.containerPort}`,
      });
    }

    stateService.save();
    sendEvent('progress', {
      line: `[detect] 完成：${appliedProfiles.length} 个构建配置 · ${appliedInfra.length} 个基础设施 · ${appliedEnvKeys.length} 个环境变量`,
    });
    sendEvent('profile', {
      status: 'cds-compose-applied',
      source: nodePath.basename(composePath),
      appliedProfiles,
      appliedInfra,
      appliedEnvKeys,
    });
    return appliedProfiles.length > 0 || appliedInfra.length > 0 || appliedEnvKeys.length > 0;
  }

  /**
   * Create one BuildProfile from a single StackDetection and persist it.
   * Returns true if the profile was successfully created. The auto-profile
   * id is namespaced by handle (api / web / app) so multi-module clones
   * end up with stable, predictable ids like `web-1`, `api-1`.
   */
  function createSingleProfile(
    project: Project,
    detection: StackDetection,
    subPath: string,
    sendEvent: (event: string, data: unknown) => void,
  ): boolean {
    const handle = autoProfileHandle(detection);
    const profileId = nextAutoProfileId(project, handle);
    const containerPort = detection.containerPort || 8080;
    const command = composeAutoCommand(detection);
    if (!command) {
      sendEvent('progress', { line: `[profile] [${subPath}] 未生成运行命令，跳过` });
      return false;
    }
    const profile: BuildProfile = {
      id: profileId,
      name: subPath === '.' ? profileId : `${profileId}-${subPath}`,
      projectId: project.id,
      dockerImage: detection.dockerImage,
      workDir: detection.workDir || '.',
      containerPort,
      command,
      env: { PORT: String(containerPort) },
      ...(handle === 'api' ? { pathPrefixes: ['/api/'] } : {}),
      ...(defaultCacheMountsFor(detection.dockerImage) ? { cacheMounts: defaultCacheMountsFor(detection.dockerImage) } : {}),
    };
    stateService.addBuildProfile(profile);
    stateService.save();
    sendEvent('progress', {
      line: `[profile] 已创建构建配置 ${profile.id} (${profile.name}): ${profile.dockerImage} · ${profile.command}`,
    });
    sendEvent('profile', {
      status: 'created',
      profileId: profile.id,
      subPath,
      stack: detection.stack,
      framework: detection.framework || null,
      dockerImage: profile.dockerImage,
      containerPort,
      command,
    });
    return true;
  }

  /**
   * Last-resort fallback when no manifest files were found anywhere.
   * If the repo ships a root Dockerfile or docker-compose.* we still
   * create a manual-setup placeholder profile so the user has a non-zero
   * starting point to edit, instead of being stuck on "尚未配置构建配置"
   * with no obvious path forward.
   */
  function composeFallbackDetection(repoPath: string): StackDetection | null {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const composeNames = [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
      'docker-compose.dev.yml',
      'docker-compose.dev.yaml',
    ];
    const hasDockerfile = fs.existsSync(path.join(repoPath, 'Dockerfile'));
    const composeFile = composeNames.find((name) => fs.existsSync(path.join(repoPath, name)));
    if (!hasDockerfile && !composeFile) return null;
    return {
      stack: 'dockerfile',
      confidence: 0.5,
      dockerImage: 'ubuntu:24.04',
      runCommand: '# 请在项目设置 → 构建配置中填写实际启动命令',
      workDir: '.',
      containerPort: 8080,
      signals: hasDockerfile ? ['Dockerfile'] : [],
      summary: composeFile
        ? `仅找到 ${composeFile}，已建立占位构建配置，请在项目设置中补全镜像与命令`
        : '仅找到 Dockerfile，已建立占位构建配置，请在项目设置中补全镜像与命令',
      manualSetupRequired: false,
    };
  }

  function autoConfigureClonedProject(
    project: Project,
    repoPath: string,
    sendEvent: (event: string, data: unknown) => void,
  ): void {
    try {
      const existing = stateService.getBuildProfilesForProject(project.id);
      if (existing.length > 0) {
        sendEvent('progress', {
          line: `[profile] 已有 ${existing.length} 个构建配置，跳过自动创建`,
        });
        sendEvent('profile', { status: 'skipped', reason: 'profiles_exist', count: existing.length });
        return;
      }

      // ── Detection priority (high → low) ──
      // 1. cds-compose.yml at repo root — most precise signal possible:
      //    user (or /cds-scan) hand-curated services + infra + env vars.
      //    If present, parse it inline and create everything in one shot;
      //    skip the heuristic stack scan entirely.
      // 2. Heuristic stack scan (monorepo-aware via detectModules).
      // 3. Dockerfile / docker-compose fallback placeholder.
      sendEvent('progress', { line: '[detect] 扫描代码仓库…' });

      const composeFiles = discoverComposeFiles(repoPath);
      const cdsComposePath = composeFiles.find((p) => /cds-compose\.ya?ml$/.test(p));
      if (cdsComposePath) {
        sendEvent('progress', { line: `[detect] 发现 ${nodePath.basename(cdsComposePath)}，按 CDS Compose 导入` });
        const ok = importCdsComposeFromFile(project, cdsComposePath, sendEvent);
        if (ok) return;
        // Parse failed — fall through to heuristic detection below.
      }

      // Phase 8.7 — 即使没有 cds-compose.yml,只要 docker-compose.yml 含相对 mount
      // (./xxx:/app)就当 CDS Compose 解析(parseCdsCompose 已支持标准 compose)。
      // 这样用户带着自己的 docker-compose.yml 项目过来也能直接跑,不强制先生成
      // cds-compose.yml。注意:此时 envMeta 是空(没 x-cds-env-meta 段),即不弹
      // env 配置弹窗 — 用户原项目假定 env 已自洽。
      const dockerComposePath = composeFiles.find((p) =>
        /docker-compose(\.[\w-]+)?\.ya?ml$/.test(p) || /(^|\/)compose\.ya?ml$/.test(p),
      );
      if (dockerComposePath && !cdsComposePath) {
        sendEvent('progress', { line: `[detect] 发现 ${nodePath.basename(dockerComposePath)}，尝试按标准 Compose 直接导入` });
        const ok = importCdsComposeFromFile(project, dockerComposePath, sendEvent);
        if (ok) return;
        // 解析失败(无 app service / 无 CDS 扩展)→ fall through 走 heuristic
        sendEvent('progress', { line: `[detect] ${nodePath.basename(dockerComposePath)} 不含可识别的应用 service,fallback 到栈扫描` });
      }

      // Railway-style onboarding: when the user selected application
      // services in the first-run dialog, create launchable profiles
      // even if the repo has no cds-compose.yml yet. This keeps "new
      // project → pick frontend/backend → deploy" continuous instead
      // of ending on an empty canvas that requires a settings detour.
      const hasOnboardingServices = Array.isArray((project as Project).onboardingServices)
        && ((project as Project).onboardingServices || []).some((service) => service.runtime && service.runtime !== 'auto');
      if (hasOnboardingServices || ((project as Project).onboardingRuntime && (project as Project).onboardingRuntime !== 'auto')) {
        const created = applyRuntimeHintProfiles(project, sendEvent);
        if (created) return;
        sendEvent('progress', {
          line: (project as Project).onboardingRuntime === 'dockerfile'
            ? '[profile] 选择 Dockerfile 模式，继续扫描仓库中的 Dockerfile / compose 文件'
            : '[profile] 应用服务提示不完整，继续尝试自动识别',
        });
      }

      // Bug N fix(2026-05-10) — heuristic stack scan / Dockerfile placeholder
      // 默认关闭。背景:cdscli scan 是用户在本地仔细审视后产物,服务端 onboard
      // 自动 detect 反而 race condition 生成 4 个 ghost profile(jdk-only,命名
      // 后缀 -2 / -3),用户后续 `cdscli import` 还要去手动删,体验极差。
      //
      // 触发开关:project.autoDetectOnClone === true 才允许走启发式扫描。
      // 默认 false:onboard 完成后只有 cds-compose.yml / docker-compose.yml 这两
      // 条精确路径会建 profile;什么都没有 → 留给 cdscli scan 接手。
      // 老项目(已有 profile)由顶部 `existing.length > 0` 守门,本次修改不影响。
      const autoDetectEnabled = (project as { autoDetectOnClone?: boolean }).autoDetectOnClone === true
        || (project as Project).onboardingRuntime === 'dockerfile'
        || (((project as Project).onboardingServices || []).some((service) => service.runtime === 'dockerfile'));
      if (!autoDetectEnabled) {
        sendEvent('progress', {
          line: '[profile] 未发现 cds-compose.yml / docker-compose.yml — 自动栈扫描默认关闭(避免与 cdscli scan 冲突),保留为手动配置',
        });
        sendEvent('profile', { status: 'skipped', reason: 'auto_detect_disabled' });
        return;
      }

      // Monorepo-aware detection: when the root directory has no
      // recognisable stack (common for our own monorepos like prd_agent
      // that nest packages under prd-admin/, cds/web/, etc.) we walk one
      // level of subdirectories so each module gets its own profile.
      const modules = detectModules(repoPath);

      if (modules.length === 0) {
        // Try to fall back to a docker-compose-driven profile when the
        // repo has no manifest files but does ship a Dockerfile or
        // docker-compose.* at the root. This is the same "still
        // launchable" path the legacy UX assumed.
        const fallback = composeFallbackDetection(repoPath);
        if (fallback) {
          sendEvent('progress', { line: `[detect] ${fallback.summary}` });
          createSingleProfile(project, fallback, '.', sendEvent);
          return;
        }
        sendEvent('progress', { line: '[profile] 未识别出已知栈，保留为手动配置' });
        sendEvent('profile', { status: 'skipped', reason: 'unknown_stack' });
        return;
      }

      // Single-module detection: behave like the original code path.
      if (modules.length === 1 && modules[0].subPath === '.') {
        const detection = modules[0].detection;
        sendEvent('progress', { line: `[detect] ${detection.summary || detection.stack}` });
        if (detection.manualSetupRequired) {
          sendEvent('progress', { line: `[profile] ${detection.summary || '需要手动配置镜像'}` });
          sendEvent('profile', { status: 'skipped', reason: 'manual_setup_required', detection });
          return;
        }
        createSingleProfile(project, detection, '.', sendEvent);
        return;
      }

      // Multi-module monorepo: announce each module then create one
      // profile per usable detection. Modules requiring manual setup
      // (e.g. raw Dockerfile placeholders) are reported but skipped.
      sendEvent('progress', { line: `[detect] 识别为 monorepo，命中 ${modules.length} 个模块` });
      let created = 0;
      let skipped = 0;
      for (const mod of modules) {
        sendEvent('progress', { line: `[detect] ${mod.detection.summary}` });
        if (mod.detection.manualSetupRequired) {
          sendEvent('progress', { line: `[profile] [${mod.subPath}] 需要手动配置镜像，跳过` });
          skipped += 1;
          continue;
        }
        const ok = createSingleProfile(project, mod.detection, mod.subPath, sendEvent);
        if (ok) created += 1;
        else skipped += 1;
      }
      sendEvent('profile', {
        status: 'multi-created',
        moduleCount: modules.length,
        createdCount: created,
        skippedCount: skipped,
      });
      return;
    } catch (err) {
      sendEvent('progress', {
        line: `[profile] 自动配置失败，保留为手动配置: ${(err as Error).message || String(err)}`,
      });
      sendEvent('profile', { status: 'error', message: (err as Error).message || String(err) });
    }
  }

  // GET /api/projects — list all projects.
  //
  // Wrapped in try/catch so an unexpected exception inside
  // statsFor (e.g. a malformed branch entry in state.json)
  // surfaces a clear 500 with diagnostics instead of bubbling out as
  // an opaque Express default response. Without this, the dashboard
  // showed the unhelpful "加载项目列表失败：HTTP 400" with no clue
  // what triggered the failure.
  router.get('/projects', (req, res) => {
    try {
      const projects = stateService.getProjects();
      // SECURITY P1 (2026-05-09): mask customEnv/defaultEnv for non-owners.
      // Static AI_ACCESS_KEY / cdsg_ global key callers get key names but
      // not values. cdsp_ project key (matching) and cookie auth bypass.
      const summaries = projects.map((p) => maskProjectSummary(req, toSummary(p, statsFor(p))));
      // Sort: legacy pinned first (existing UX), then by runtime liveness
      // so projects with running services bubble up — useful once you
      // have many projects and only a few are active.
      summaries.sort((a, b) => {
        if (a.legacyFlag && !b.legacyFlag) return -1;
        if (!a.legacyFlag && b.legacyFlag) return 1;
        if (a.runningServiceCount !== b.runningServiceCount) {
          return b.runningServiceCount - a.runningServiceCount;
        }
        const at = a.lastDeployedAt || '';
        const bt = b.lastDeployedAt || '';
        if (at !== bt) return bt.localeCompare(at);
        return 0;
      });
      res.json({ projects: summaries, total: summaries.length });
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      // eslint-disable-next-line no-console
      console.error('[projects] GET /api/projects failed:', err);
      res.status(500).json({
        error: 'projects_list_failed',
        message: `项目列表读取失败: ${msg}`,
      });
    }
  });

  // GET /api/projects/:id — project detail.
  router.get('/projects/:id', (req, res) => {
    try {
      const project = stateService.getProject(req.params.id);
      if (!project) {
        res.status(404).json({
          error: 'project_not_found',
          message: `Project '${req.params.id}' does not exist.`,
        });
        return;
      }
      const summary = maskProjectSummary(req, toSummary(project, statsFor(project)));
      // CDS-CLI-007 / #551 (a)：识别"半成品"项目（cloneStatus=error 或 git
      // 项目缺 repoPath）并在响应里附 recovery 指引，避免 Agent 反复尝试
      // clone 却拿不到具体下一步。这里只读不写，不会引入额外副作用。
      let recovery: { state: string; nextActions: string[]; hint: string } | undefined;
      if (project.gitRepoUrl && project.cloneStatus === 'error') {
        recovery = {
          state: 'clone_failed',
          nextActions: [
            `POST /api/projects/${project.id}/clone — 直接重试，CDS 会清理残留目录后重新 git clone`,
            `DELETE /api/projects/${project.id} — 如果该项目无法恢复且不需要保留`,
          ],
          hint: project.cloneError
            ? `上次 clone 失败原因：${project.cloneError}`
            : '上次 clone 失败但未记录详细原因；重试一次会暴露完整 stderr。',
        };
      } else if (project.gitRepoUrl && !project.repoPath) {
        // #551 (a) 旧项目场景：git 项目但 repoPath 为空。clone 端点会自动 backfill。
        const reposBase = config?.reposBase;
        recovery = {
          state: 'legacy_no_repo_path',
          nextActions: [
            `POST /api/projects/${project.id}/clone — 服务端会自动派生 repoPath 并 clone`,
          ],
          hint: reposBase
            ? `该项目可能在 reposBase 配置之前创建。CDS 当前 reposBase=${reposBase}，clone 时会自动 backfill repoPath=${reposBase}/${project.id}。`
            : 'CDS 仍未配置 reposBase，请先在 .cds.env 设置 CDS_REPOS_BASE 后重试。',
        };
      }
      res.json({ ...summary, ...(recovery ? { recovery } : {}) });
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      // eslint-disable-next-line no-console
      console.error(`[projects] GET /api/projects/${req.params.id} failed:`, err);
      res.status(500).json({
        error: 'project_detail_failed',
        message: `项目详情读取失败: ${msg}`,
      });
    }
  });

  // GET /api/projects/:id/recent-auto-deploys?limit=N — webhook 自动部署最近 N 条
  //
  // 用户痛点(2026-05-04 UX 验证):"GitHub 关联"卡片只显示 "已关联 / 自动部署
  // 开启",**没有"它真的在工作"的证据**。webhook_delivery_logs 集合还没落地,
  // 但已有数据可以推断:branch.githubInstallationId 非空 = 由 webhook 创建,
  // 按 lastDeployAt 排序就是最近自动部署。
  router.get('/projects/:id/recent-auto-deploys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const limit = Math.max(1, Math.min(20, parseInt(String(req.query.limit || '5'), 10) || 5));
    const branches = stateService.getBranchesForProject(project.id);
    const autoDeployed = branches
      .filter((b) => typeof b.githubInstallationId === 'number')
      .map((b) => ({
        branchId: b.id,
        branch: b.branch,
        status: b.status,
        lastDeployAt: b.lastDeployAt || b.createdAt,
        installationId: b.githubInstallationId,
      }))
      .sort((l, r) => new Date(r.lastDeployAt || 0).getTime() - new Date(l.lastDeployAt || 0).getTime())
      .slice(0, limit);
    res.json({
      projectId: project.id,
      total: branches.filter((b) => typeof b.githubInstallationId === 'number').length,
      items: autoDeployed,
    });
  });

  // ── 2026-04-27 边界整理（.claude/rules/scope-naming.md）：
  // 把 preview-mode / comment-template 提到 RESTful per-project 路径。
  // 老路径 /api/preview-mode、/api/comment-template 保留兼容（不在此处），
  // 但响应里加 deprecation 字段提醒前端切到这两条新路由。
  // ──

  router.get('/projects/:id/preview-mode', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    res.json({ mode: stateService.getPreviewModeFor(req.params.id) });
  });

  router.put('/projects/:id/preview-mode', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const { mode } = (req.body || {}) as { mode?: string };
    if (mode !== 'simple' && mode !== 'port' && mode !== 'multi') {
      res.status(400).json({ error: "mode 必须是 'simple' | 'port' | 'multi'" });
      return;
    }
    stateService.setProjectPreviewMode(req.params.id, mode);
    stateService.save();
    const labels: Record<string, string> = { simple: '简洁', port: '端口直连', multi: '子域名' };
    res.json({ message: `预览模式已切换为：${labels[mode]}`, mode });
  });

  router.get('/projects/:id/comment-template', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const current = stateService.getCommentTemplateFor(req.params.id);
    res.json({
      ok: true,
      body: current?.body || '',
      updatedAt: current?.updatedAt || null,
      isDefault: !current || !current.body,
    });
  });

  router.put('/projects/:id/comment-template', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const { body } = (req.body || {}) as { body?: string };
    if (body !== undefined && typeof body !== 'string') {
      res.status(400).json({ ok: false, message: 'body 必须是字符串' });
      return;
    }
    const trimmedBody = (body ?? '').slice(0, 16 * 1024);
    const settings = { body: trimmedBody, updatedAt: new Date().toISOString() };
    stateService.setProjectCommentTemplate(req.params.id, settings);
    stateService.save();
    res.json({ ok: true, body: settings.body, updatedAt: settings.updatedAt });
  });

  // PR_C.4: 项目活动日志（供 UI 渲染时间线 / 浮窗）。
  // limit 默认 50，最大 200（与 ring buffer 上限一致，避免一次拉爆）。
  router.get('/projects/:id/activity-logs', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    const logs = stateService.getActivityLogs(project.id, { limit, sinceIso });
    res.json({ projectId: project.id, logs, total: logs.length });
  });

  // POST /api/projects — real creation (P4 Part 2).
  //
  // Request body: { name, slug?, description?, gitRepoUrl? }
  // Responses:
  //   201 { project }          — success
  //   400 { error: 'validation', field, message }
  //   409 { error: 'duplicate', field }
  //   500 { error: 'docker', message } — docker create failed
  router.post('/projects', async (req, res) => {
    // Project keys are bound to a single project — they may not mint
    // new projects. Only the bootstrap key / cookie-auth may.
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_create',
        message: 'Project-scoped Agent Key 无权创建新项目；请在 CDS 管理页手动新建。',
      });
      return;
    }

    const body = (req.body || {}) as Partial<{
      name: string;
      slug: string;
      description: string;
      gitRepoUrl: string;
      gitDefaultBranch: string;
      // F11(2026-05-03 沙盒模式)— 当 composeYaml 提供且没 gitRepoUrl 时,
      // 跳过 git clone,直接用 user 提供的 yaml + 可选 projectFiles 在
      // reposBase 本地 init 一个 git 仓库,kind 标 'manual'。
      // 用途:demo / quick-prototype 不需要 push GitHub 就能跑。
      composeYaml: string;
      projectFiles: ProjectFilePayload[];
      autoDetectOnClone: boolean;
      infraPresets: string[];
      onboardingRuntime: OnboardingRuntime;
      onboardingDockerImage: string;
      onboardingCommand: string;
      onboardingPort: number;
      onboardingServices: Array<Partial<OnboardingService> & { enabled?: boolean }>;
    }>;

    // — Validation —
    const name = (body.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'validation', field: 'name', message: '项目名称不能为空' });
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      res.status(400).json({
        error: 'validation',
        field: 'name',
        message: `项目名称长度不能超过 ${MAX_NAME_LENGTH}`,
      });
      return;
    }

    // Track whether the slug was explicitly supplied by the caller.
    // When the caller leaves slug blank, we derive it from the project
    // name and silently auto-suffix on collision (-2, -3, ...) so
    // pasting a Git URL whose repo name happens to match an existing
    // project just works. When the caller supplies an explicit slug,
    // we keep the strict 409 behaviour so the user knows their pick
    // collided.
    const slugProvidedExplicitly = Boolean((body.slug || '').trim());
    const baseSlug = slugProvidedExplicitly
      ? (body.slug as string).trim().toLowerCase()
      : slugifyName(name);
    if (!SLUG_REGEX.test(baseSlug)) {
      res.status(400).json({
        error: 'validation',
        field: 'slug',
        message: 'slug 只能包含小写字母、数字和短横线，且不能以短横线开头或结尾',
      });
      return;
    }
    // 2026-04-22 规则：禁止再用 'default' 作为项目 id，避免和遗留迁移项目冲突，
    // 也避免「default」被当成兜底值到处蔓延（就是用户在抱怨的老问题）。
    if (baseSlug === LEGACY_PROJECT_ID) {
      res.status(400).json({
        error: 'validation',
        field: 'slug',
        message: 'slug 不能为 "default"（保留给遗留迁移占位）。请用项目真实名称的派生 slug，例如 my-app。',
      });
      return;
    }

    // P4 Part 18 (Phase E audit fix #9): redact embedded userinfo
    // before persisting. Users who paste tokens in the URL by mistake
    // still get a working project, but the token never hits state.json.
    // Private repo auth should go through the Device Flow token
    // (injected at clone time via _injectGithubTokenIfPossible).
    const rawGitRepoUrl = typeof body.gitRepoUrl === 'string' ? body.gitRepoUrl.trim() : undefined;
    const gitRepoUrl = rawGitRepoUrl ? _redactUrlUserInfo(rawGitRepoUrl) : undefined;
    const githubRepoFullName = gitRepoUrl ? _githubFullNameFromCloneUrl(gitRepoUrl) : undefined;
    const githubRepoAlreadyLinked = githubRepoFullName ? stateService.findProjectByRepoFullName(githubRepoFullName) : undefined;
    const description = typeof body.description === 'string' ? body.description.trim() : undefined;
    const gitDefaultBranch = typeof body.gitDefaultBranch === 'string' && body.gitDefaultBranch.trim()
      ? body.gitDefaultBranch.trim()
      : undefined;
    const autoDetectOnClone = body.autoDetectOnClone === true;
    const requestedRuntime = typeof body.onboardingRuntime === 'string' && ONBOARDING_RUNTIMES.has(body.onboardingRuntime)
      ? body.onboardingRuntime
      : 'auto';
    const onboardingDockerImage = typeof body.onboardingDockerImage === 'string' ? body.onboardingDockerImage.trim() : '';
    const onboardingCommand = typeof body.onboardingCommand === 'string' ? body.onboardingCommand.trim() : '';
    const onboardingPort = Number.isFinite(body.onboardingPort) && Number(body.onboardingPort) > 0
      ? Number(body.onboardingPort)
      : undefined;
    if (requestedRuntime === 'custom' && (!onboardingDockerImage || !onboardingCommand)) {
      res.status(400).json({
        error: 'validation',
        field: 'onboardingRuntime',
        message: '选择自定义运行环境时必须填写 Docker 镜像和启动命令',
      });
      return;
    }
    const onboardingServices = Array.isArray(body.onboardingServices)
      ? body.onboardingServices
          .filter((service) => service && service.enabled !== false)
          .map((service, index): OnboardingService => {
            const role = service.role === 'frontend' || service.role === 'backend' || service.role === 'worker' || service.role === 'app'
              ? service.role
              : index === 0
                ? 'frontend'
                : 'backend';
            const runtime = typeof service.runtime === 'string' && ONBOARDING_RUNTIMES.has(service.runtime)
              ? service.runtime
              : 'auto';
            return {
              id: typeof service.id === 'string' && service.id.trim()
                ? slugifyName(service.id.trim())
                : role,
              name: typeof service.name === 'string' && service.name.trim()
                ? service.name.trim()
                : role === 'frontend'
                  ? '前端服务'
                  : role === 'backend'
                    ? '后端服务'
                    : '应用服务',
              role,
              runtime,
              dockerImage: typeof service.dockerImage === 'string' && service.dockerImage.trim() ? service.dockerImage.trim() : undefined,
              command: typeof service.command === 'string' && service.command.trim() ? service.command.trim() : undefined,
              port: Number.isFinite(service.port) && Number(service.port) > 0 ? Number(service.port) : undefined,
            };
          })
      : [];
    const invalidCustomService = onboardingServices.find((service) =>
      service.runtime === 'custom' && (!service.dockerImage || !service.command),
    );
    if (invalidCustomService) {
      res.status(400).json({
        error: 'validation',
        field: 'onboardingServices',
        message: `${invalidCustomService.name} 选择自定义运行环境时必须填写 Docker 镜像和启动命令`,
      });
      return;
    }
    const infraPresets = Array.isArray(body.infraPresets)
      ? body.infraPresets.filter((id): id is string => typeof id === 'string')
      : [];

    // Resolve the final slug. Auto-derived slugs walk -2, -3, ... on
    // collision so the user never has to manually disambiguate when
    // pasting a URL whose repo name matches an existing project (the
    // common case: legacy "prd-agent" project + a fresh Git repo also
    // named prd_agent). Capped at 99 attempts so a corrupted state
    // can't hang the request.
    const existingProjects = stateService.getProjects();
    const takenSlugs = new Set(existingProjects.map((p) => p.slug));
    let slug = baseSlug;
    if (takenSlugs.has(slug)) {
      if (slugProvidedExplicitly) {
        res.status(409).json({ error: 'duplicate', field: 'slug', message: `slug '${slug}' 已被占用` });
        return;
      }
      let suffix = 2;
      while (takenSlugs.has(`${baseSlug}-${suffix}`) && suffix < 100) suffix++;
      const candidate = `${baseSlug}-${suffix}`;
      if (takenSlugs.has(candidate)) {
        res.status(409).json({ error: 'duplicate', field: 'slug', message: `slug '${baseSlug}' 已被占用，且自动追加序号也未能找到空闲位` });
        return;
      }
      slug = candidate;
    }
    const slugAutoAdjusted = slug !== baseSlug;

    // — Build the new project —
    const now = new Date().toISOString();
    const id = generateProjectId();
    const network = dockerNetworkFor(id);
    // P4 Part 18 (G1.3): when a gitRepoUrl is supplied AND CDS has
    // been configured with a reposBase, stamp the new project with a
    // per-project repoPath and mark cloneStatus='pending'. The actual
    // `git clone` happens out-of-band via POST /api/projects/:id/clone
    // so the create request stays fast. When reposBase isn't set we
    // leave repoPath undefined and the project falls back to the
    // legacy single-repo root at every worktree call-site — this is
    // what pre-G1 CDS installs will see.
    const reposBase = config?.reposBase;
    const willClone = Boolean(gitRepoUrl && reposBase);

    // F11 沙盒模式判定:有 composeYaml 但没 gitRepoUrl(不能两个都有 — 二选一)
    const composeYaml = typeof body.composeYaml === 'string' ? body.composeYaml.trim() : '';
    const projectFilesPayload: ProjectFilePayload[] = Array.isArray(body.projectFiles) ? body.projectFiles : [];
    const isSandbox = composeYaml.length > 0 && !gitRepoUrl;
    if (composeYaml.length > 0 && gitRepoUrl) {
      res.status(400).json({
        error: 'validation',
        field: 'composeYaml',
        message: 'composeYaml 与 gitRepoUrl 互斥:有 git 仓库就走 clone 路径,沙盒模式不需要 gitRepoUrl',
      });
      return;
    }
    // Fail fast when a git repo is requested but reposBase is unavailable.
    // With the auto-default in config.ts this should be rare, but guard
    // against environments where the default directory couldn't be created.
    if (gitRepoUrl && !reposBase) {
      res.status(503).json({
        error: 'reposBase_missing',
        message: 'CDS 未配置源码仓库根目录（reposBase），无法 clone 外部 git 仓库。',
        fixAction: '在 CDS 服务端设置环境变量 CDS_REPOS_BASE=<path>（如 /root/cds/.cds-repos）并重启 CDS。',
        settingsUrl: '/cds-settings',
      });
      return;
    }
    if (isSandbox && !reposBase) {
      res.status(503).json({
        error: 'reposBase_missing',
        message: 'CDS 未配置 reposBase,沙盒模式无法定位本地仓库目录(检查 .cds.env)',
        fixAction: '在 CDS 服务端设置环境变量 CDS_REPOS_BASE=<path> 并重启 CDS。',
        settingsUrl: '/cds-settings',
      });
      return;
    }

    const newProject: Project = {
      id,
      slug,
      name,
      description,
      kind: isSandbox ? 'manual' : 'git',
      gitRepoUrl: gitRepoUrl || undefined,
      gitDefaultBranch: gitDefaultBranch || undefined,
      ...(githubRepoFullName && !githubRepoAlreadyLinked
        ? {
            githubRepoFullName,
            githubAutoDeploy: true,
            githubLinkedAt: now,
          }
        : {}),
      dockerNetwork: network,
      legacyFlag: false,
      createdAt: now,
      updatedAt: now,
      ...(willClone ? { autoDetectOnClone } : {}),
      ...(willClone || isSandbox
        ? {
            onboardingRuntime: requestedRuntime,
            onboardingDockerImage: onboardingDockerImage || undefined,
            onboardingCommand: onboardingCommand || undefined,
            onboardingPort,
            ...(onboardingServices.length > 0 ? { onboardingServices } : {}),
          }
        : {}),
      ...(willClone
        ? {
            repoPath: `${reposBase}/${id}`,
            cloneStatus: 'pending' as const,
          }
        : {}),
      ...(isSandbox
        ? {
            // 沙盒项目跳过 clone:repoPath 立即指向本地 init 的仓库,
            // cloneStatus='ready' 让 deploy 路径直接放行。
            repoPath: `${reposBase}/${id}`,
            cloneStatus: 'ready' as const,
          }
        : {}),
    };

    // — Side effects with rollback —
    //
    // Create the docker network first. If that fails, nothing is
    // persisted and the user can retry. If the state save fails after
    // the network exists, we attempt to roll the network back so the
    // user isn't left with an orphaned network blocking future creates
    // with the same id.
    try {
      await ensureDockerNetwork(network);
    } catch (err) {
      res.status(500).json({
        error: 'docker',
        message: (err as Error).message,
      });
      return;
    }

    try {
      stateService.addProject(newProject);
    } catch (err) {
      // Rollback the network we just created. Best-effort — we log the
      // rollback result but still return the original save error so the
      // caller knows why the request failed.
      await removeDockerNetwork(network).catch(() => { /* already reported */ });
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }
    const appliedInfraPresets = applyInfraPresets(newProject, infraPresets);

    // F11 — 沙盒模式 bootstrap:在 reposBase/<projectId>/ 本地 init 一个
    // git 仓库,写 cds-compose.yml + projectFiles[],模拟"clone 完成"状态,
    // 让后续 worktree 创建 / deploy 与正常 clone 项目走同一条路径。
    if (isSandbox && reposBase) {
      const repoPath = `${reposBase}/${id}`;
      try {
        await initSandboxRepo(repoPath, composeYaml, projectFilesPayload, shell);
        // autoConfigure 解析新写入的 cds-compose.yml 自动建 BuildProfile / InfraService。
        // 用 no-op sender 吞 SSE 事件(POST /projects 不是 SSE)。
        autoConfigureClonedProject(newProject, repoPath, () => { /* no-op */ });
      } catch (err) {
        // 半成品状态:project + network 已建,但 sandbox bootstrap 失败。
        // 回滚 project + network,告诉用户错误。
        try { stateService.removeProject(id); } catch { /* state save 失败也只能 log */ }
        await removeDockerNetwork(network).catch(() => { /* 已记录 */ });
        if (err instanceof ProjectFileError) {
          res.status(err.status).json({
            error: 'sandbox_bootstrap_failed',
            field: err.field,
            message: err.message,
          });
          return;
        }
        res.status(500).json({
          error: 'sandbox_bootstrap_failed',
          message: (err as Error).message,
        });
        return;
      }
    }

    res.status(201).json({
      project: toSummary(newProject, EMPTY_STATS),
      // Surface the auto-suffix so the frontend can show a friendly
      // toast like "已自动调整 slug 为 prd-agent-2 (原 slug 已被占用)".
      slugAutoAdjusted: slugAutoAdjusted ? { from: baseSlug, to: slug } : undefined,
      // F11 — 告诉前端这是沙盒项目,UI 可显示"沙盒"标签 + 提示"想要持久化请关联 GitHub"
      sandbox: isSandbox || undefined,
      infraPresetsApplied: appliedInfraPresets,
    });
  });

  /**
   * F11 helper — 在 reposBase 本地 init 一个新仓库,写 cds-compose.yml
   * + projectFiles[],并 git add + commit + 自指 origin。
   *
   * 自指 origin (git remote add origin <self path>) 的目的:
   * 后续 WorktreeService.add() 调 `git fetch origin <branch>` +
   * `git worktree add ... origin/<branch>`,这两步对正常 clone 项目走 GitHub,
   * 对沙盒项目"走自己"。这样 worktree / pull 路径不需要为沙盒分支特判。
   *
   * Bugbot fix(2026-05-04 PR #523):任何步失败都 `rm -rf repoPath` 清理
   * 半成品目录;之前只有 mkdir 后没清理,留 orphan dir。
   * 文件校验也改成 mkdir *之前* 跑(走 ProjectFilesService.validatePayload),
   * 大文件 / 非法路径不会留下空 git repo。
   */
  async function initSandboxRepo(
    repoPath: string,
    composeYaml: string,
    extraFiles: ProjectFilePayload[],
    shellExec: IShellExecutor,
  ): Promise<void> {
    // 不能复用已有目录(避免覆盖之前 deploy 残留);上层 slug 校验已确保唯一。
    if (nodeFs.existsSync(repoPath)) {
      throw new ProjectFileError(
        409,
        'repo_path_exists',
        `沙盒目录 ${repoPath} 已存在;新沙盒项目应该走全新 slug`,
      );
    }

    const allFiles: ProjectFilePayload[] = [
      { relativePath: 'cds-compose.yml', content: composeYaml },
      ...extraFiles,
    ];
    const filesService = new ProjectFilesService(stateService, config);

    // 先校验文件 payload 全部合法(纯静态检查,不创目录),
    // 任何路径/大小问题立即抛出 — 不会留下空目录或空 git repo。
    // Bugbot fix(2026-05-04 第六轮):捕获 resolved 列表传给后续
    // writeFilesAtPath 走 preValidated,避免二次校验冗余。
    const preValidated = filesService.validatePayload(repoPath, allFiles);

    // 校验通过后才动 fs;任何步失败 catch 里 rm -rf。
    let dirCreated = false;
    try {
      const mkParent = await shellExec.exec(`mkdir -p "${repoPath}"`);
      if (mkParent.exitCode !== 0) {
        throw new Error(`创建 sandbox 目录失败: ${combinedOutput(mkParent)}`);
      }
      dirCreated = true;
      const initRes = await shellExec.exec('git init -b main', { cwd: repoPath });
      if (initRes.exitCode !== 0) {
        throw new Error(`git init 失败: ${combinedOutput(initRes)}`);
      }
      // 写文件(校验已在前面跑过,preValidated 跳过二次校验,只做实际 IO)。
      await filesService.writeFilesAtPath(repoPath, allFiles, {
        requireExist: false,
        preValidated,
      });

      // 配 commit author(用户没装 git config 也能 commit)。
      await shellExec.exec(
        'git config user.email cds@miduo.local && git config user.name CDS',
        { cwd: repoPath },
      );
      const addRes = await shellExec.exec('git add .', { cwd: repoPath });
      if (addRes.exitCode !== 0) {
        throw new Error(`git add 失败: ${combinedOutput(addRes)}`);
      }
      const commitRes = await shellExec.exec('git commit -m "CDS sandbox init"', { cwd: repoPath });
      if (commitRes.exitCode !== 0) {
        throw new Error(`git commit 失败: ${combinedOutput(commitRes)}`);
      }
      // 自指 origin:之后 worktree 路径走 origin/main 也能命中。
      const remoteRes = await shellExec.exec(`git remote add origin "${repoPath}"`, { cwd: repoPath });
      if (remoteRes.exitCode !== 0) {
        throw new Error(`git remote add origin 失败: ${combinedOutput(remoteRes)}`);
      }
      // 触发一次 fetch 让 origin/main 引用就位。
      const fetchRes = await shellExec.exec('git fetch origin main', { cwd: repoPath });
      if (fetchRes.exitCode !== 0) {
        throw new Error(`git fetch origin main 失败: ${combinedOutput(fetchRes)}`);
      }
    } catch (err) {
      if (dirCreated) {
        // best-effort:清不掉只 warn,主错误仍抛出
        try { await shellExec.exec(`rm -rf "${repoPath}"`); } catch { /* ignore */ }
      }
      throw err;
    }
  }

  // PUT /api/projects/:id — patch mutable project fields.
  //
  // P4 Part 13 (Project Settings page). Accepts {name, description,
  // gitRepoUrl} and delegates to StateService.updateProject which
  // bumps updatedAt + persists. Immutable fields (id, slug, kind,
  // legacyFlag, dockerNetwork, createdAt) are intentionally not
  // patchable through this endpoint — changing slug would break the
  // URL routing and changing dockerNetwork would orphan containers.
  router.put('/projects/:id', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }

    const body = (req.body || {}) as Partial<{
      name: string;
      aliasName: string;
      aliasSlug: string;
      description: string;
      gitRepoUrl: string;
      autoSmokeEnabled: boolean;
      defaultDeployModes: Record<string, string>;
      // PR_D.3: 5 个 per-event toggle，对应 Project.githubEventPolicy
      githubEventPolicy: {
        push?: boolean;
        delete?: boolean;
        prClose?: boolean;
        prOpen?: boolean;
        slashCommand?: boolean;
      };
    }>;

    // Validate name when supplied
    if (body.name !== undefined) {
      const trimmed = String(body.name).trim();
      if (!trimmed) {
        res.status(400).json({ error: 'validation', field: 'name', message: '项目名称不能为空' });
        return;
      }
      if (trimmed.length > MAX_NAME_LENGTH) {
        res.status(400).json({
          error: 'validation',
          field: 'name',
          message: `项目名称长度不能超过 ${MAX_NAME_LENGTH}`,
        });
        return;
      }
    }

    // Validate aliasName when supplied. Empty string = clear the alias.
    if (body.aliasName !== undefined) {
      const trimmed = String(body.aliasName).trim();
      if (trimmed.length > MAX_NAME_LENGTH) {
        res.status(400).json({
          error: 'validation',
          field: 'aliasName',
          message: `显示别名长度不能超过 ${MAX_NAME_LENGTH}`,
        });
        return;
      }
    }

    // Validate aliasSlug when supplied. Empty string = clear. Non-empty
    // must pass SLUG_REGEX AND not collide with any project's slug /
    // aliasSlug (including the current project's own slug — that would
    // be redundant and confusing).
    if (body.aliasSlug !== undefined) {
      const trimmed = String(body.aliasSlug).trim().toLowerCase();
      if (trimmed !== '') {
        if (!SLUG_REGEX.test(trimmed)) {
          res.status(400).json({
            error: 'validation',
            field: 'aliasSlug',
            message: '别名 slug 只能包含小写字母、数字和短横线，且不能以短横线开头或结尾',
          });
          return;
        }
        if (trimmed === project.slug) {
          res.status(400).json({
            error: 'validation',
            field: 'aliasSlug',
            message: '别名 slug 不能与项目原 slug 相同',
          });
          return;
        }
        // Walk every OTHER project and check both slug and aliasSlug.
        const collision = stateService
          .getProjects()
          .find(
            (p) =>
              p.id !== project.id &&
              (p.slug === trimmed || p.aliasSlug === trimmed),
          );
        if (collision) {
          res.status(409).json({
            error: 'duplicate',
            field: 'aliasSlug',
            message: `别名 slug '${trimmed}' 已被项目 '${collision.name}' 占用`,
          });
          return;
        }
      }
    }

    const patch: Partial<Pick<Project, 'name' | 'aliasName' | 'aliasSlug' | 'description' | 'gitRepoUrl' | 'autoSmokeEnabled' | 'githubEventPolicy' | 'defaultDeployModes'>> = {};
    // PR_D.3: 合并 5 个 toggle 到 githubEventPolicy（partial patch — 仅
    // 对显式传入的 key 更新，不影响其它 key）。
    if (body.githubEventPolicy && typeof body.githubEventPolicy === 'object') {
      const incoming = body.githubEventPolicy;
      const existing = project.githubEventPolicy || {};
      const merged: NonNullable<Project['githubEventPolicy']> = { ...existing };
      const allowedKeys = ['push', 'delete', 'prClose', 'prOpen', 'slashCommand'] as const;
      for (const k of allowedKeys) {
        if (incoming[k] !== undefined) merged[k] = incoming[k] === true;
      }
      patch.githubEventPolicy = merged;
    }
    if (body.autoSmokeEnabled !== undefined) {
      // Booleans come in as true / false / 'true' / 'false' depending on
      // the UI; coerce everything truthy but 'false' into a real boolean.
      patch.autoSmokeEnabled = body.autoSmokeEnabled === true || body.autoSmokeEnabled === 'true' as unknown as boolean;
    }
    if (body.defaultDeployModes !== undefined) {
      const incoming = body.defaultDeployModes;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        res.status(400).json({ error: 'validation', field: 'defaultDeployModes', message: '默认部署模式格式不正确' });
        return;
      }
      const next: Record<string, string> = {};
      const projectProfiles = stateService.getBuildProfilesForProject(project.id);
      const profilesById = new Map(projectProfiles.map((profile) => [profile.id, profile]));
      for (const [profileId, rawMode] of Object.entries(incoming)) {
        if (typeof rawMode !== 'string') continue;
        const profile = profilesById.get(profileId);
        if (!profile) {
          res.status(400).json({ error: 'validation', field: 'defaultDeployModes', message: `构建配置 "${profileId}" 不属于当前项目` });
          return;
        }
        const mode = rawMode.trim();
        if (mode && !profile.deployModes?.[mode]) {
          const available = Object.keys(profile.deployModes || {}).join(', ') || '无';
          res.status(400).json({ error: 'validation', field: 'defaultDeployModes', message: `构建配置 "${profileId}" 不存在部署模式 "${mode}"，可用: ${available}` });
          return;
        }
        next[profileId] = mode;
      }
      patch.defaultDeployModes = next;
    }
    if (body.name !== undefined) patch.name = String(body.name).trim();
    // For alias fields an empty string explicitly clears them so the UI
    // can revert to showing `name` / `slug`. updateProject() serialises
    // undefined fields out via spread, so we pass undefined (not '') to
    // remove the key entirely — keeps state.json tidy.
    if (body.aliasName !== undefined) {
      const trimmed = String(body.aliasName).trim();
      patch.aliasName = trimmed === '' ? undefined : trimmed;
    }
    if (body.aliasSlug !== undefined) {
      const trimmed = String(body.aliasSlug).trim().toLowerCase();
      patch.aliasSlug = trimmed === '' ? undefined : trimmed;
    }
    if (body.description !== undefined) patch.description = String(body.description).trim();
    if (body.gitRepoUrl !== undefined) patch.gitRepoUrl = String(body.gitRepoUrl).trim();

    try {
      stateService.updateProject(project.id, patch);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    const updated = stateService.getProject(project.id)!;
    res.json({ project: toSummary(updated, statsFor(updated)) });
  });

  // POST /api/projects/:id/files — upload arbitrary text files into a branch worktree.
  //
  // 用途(F12 / 2026-05-03 收尾):
  //   - 用户在 EnvSetupDialog 看到 mysql/postgres infra 时上传 init.sql,
  //     CDS 把文件写到 `<worktreeBase>/<projectId>/<branch>/<relativePath>`,
  //     下次 deploy docker 自动挂到 /docker-entrypoint-initdb.d/。
  //   - 也可被 cdscli 命令封装供脚本上传任意配置文件。
  //
  // 不会:
  //   - git commit / git push(用户负责);文档说明"未提交的本地改动会
  //     在下次 git pull 出现冲突"。
  //   - 接受二进制(只支持 utf-8 文本字段);二进制文件需另开 multipart 端点。
  //
  // 限额(常量见 ProjectFilesService 顶部):
  //   - 单文件 ≤ 256KB,单次 ≤ 1MB,最多 50 个,路径深度 ≤ 10
  //   - 路径段只允许 [A-Za-z0-9_.-],禁止 .. / 绝对路径 / 反斜杠 / 控制符
  //
  // Body: { branch?: string, files: [{ relativePath, content }] }
  // - branch 缺省:project.defaultBranch || 'main'
  router.post('/projects/:id/files', async (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const body = (req.body || {}) as Partial<{
      branch: string;
      files: ProjectFilePayload[];
    }>;
    const branch = (
      body.branch ||
      project.gitDefaultBranch ||
      (project as { defaultBranch?: string }).defaultBranch ||
      'main'
    ).trim();
    const files = Array.isArray(body.files) ? body.files : [];
    const filesService = new ProjectFilesService(stateService, config);
    try {
      const result = await filesService.writeFiles(project.id, branch, files);
      // 不回响内容(可能含 secret);只返写入清单 + 大小 + 路径。
      res.json({
        projectId: project.id,
        branch,
        worktreePath: result.worktreePath,
        written: result.written.map((w) => ({
          relativePath: w.relativePath,
          bytes: w.bytes,
        })),
        totalBytes: result.totalBytes,
        warning:
          'CDS 已把文件写入 worktree;若想被 git 历史保留请手动 git commit + push,' +
          '否则下次 git pull 可能因本地未提交改动失败。',
      });
    } catch (err) {
      if (err instanceof ProjectFileError) {
        res.status(err.status).json({
          error: err.code,
          field: err.field,
          message: err.message,
        });
        return;
      }
      res.status(500).json({
        error: 'unknown',
        message: (err as Error).message,
      });
    }
  });

  // POST /api/projects/:id/clone — run the async git clone (P4 Part 18 G1.3).
  //
  // Contract:
  //   Trigger: POST /api/projects/:id/clone  (SSE response)
  //   Events:
  //     event: start     { projectId, gitRepoUrl, repoPath }
  //     event: progress  { line }             — one line of git clone output
  //     event: complete  { projectId, repoPath }
  //     event: error     { message }
  //
  // The clone is called only once per project — the endpoint refuses
  // if cloneStatus is already 'cloning' or 'ready' so repeated clicks
  // don't spawn parallel git processes. To re-clone after an error,
  // the client PATCHes cloneStatus back to 'pending' first (or just
  // retries if cloneStatus is currently 'error').
  //
  // This endpoint intentionally leaves the repoPath in place on
  // failure so the operator can inspect it. Successful clone flips
  // cloneStatus → 'ready' and the branch deploy path becomes usable
  // via StateService.getProjectRepoRoot().
  router.post('/projects/:id/clone', async (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const cloneMismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (cloneMismatch) {
      res.status(cloneMismatch.status).json(cloneMismatch.body);
      return;
    }
    if (!project.gitRepoUrl) {
      res.status(400).json({
        error: 'no_git_url',
        message: '项目未配置 gitRepoUrl，无法克隆。',
      });
      return;
    }
    // #551 (a) backfill：对于在 reposBase=null 时创建的旧项目，project.repoPath
    // 为空。reposBase 现在已配置时（PR #546 默认 ${repoRoot}/.cds-repos），可以
    // 从 reposBase + project.id 派生标准路径并 persist 回 store，让 clone 接着走。
    // 这样不需要让用户重建项目。
    if (!project.repoPath) {
      const reposBase = config?.reposBase;
      if (reposBase && project.id) {
        const derivedRepoPath = nodePath.resolve(reposBase, project.id);
        // eslint-disable-next-line no-console
        console.log(
          `[project] backfilled repoPath=${derivedRepoPath} for project id=${project.id} ` +
          `(legacy project created without reposBase, now reposBase=${reposBase})`,
        );
        stateService.updateProject(project.id, {
          repoPath: derivedRepoPath,
          cloneStatus: project.cloneStatus || 'pending',
        });
        // Mutate the in-memory copy too so the rest of this handler sees it.
        project.repoPath = derivedRepoPath;
        if (!project.cloneStatus) project.cloneStatus = 'pending';
      } else {
        res.status(400).json({
          error: 'no_repo_path',
          message: 'CDS 未配置 reposBase（见 exec_cds.sh），无法确定克隆目标路径。',
          hint: '若该项目是在 reposBase 修复前创建的，请先在 CDS 系统设置或 .cds.env 中确认 CDS_REPOS_BASE 已生效，再重试。',
        });
        return;
      }
    }
    if (project.cloneStatus === 'cloning') {
      res.status(409).json({
        error: 'already_cloning',
        message: '该项目正在克隆中，请等待当前任务结束或刷新状态。',
      });
      return;
    }
    if (project.cloneStatus === 'ready') {
      res.status(409).json({
        error: 'already_ready',
        message: '该项目已克隆完成。如需重新克隆请先删除 repoPath 目录。',
      });
      return;
    }

    // Open SSE immediately so the client sees "cloning" as soon as
    // the request is accepted, even before mkdir returns.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: unknown): void => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* client disconnected — update below still runs via server authority */
      }
    };

    const repoPath = project.repoPath;
    const gitUrl = project.gitRepoUrl;

    // P4 Part 18 (Phase E audit fix #1): if the URL points at github.com
    // AND a GitHub Device Flow token is stored, inject the token into
    // the clone URL so private repos work. The token is ephemerally
    // inserted into the shell command only — never persisted back to
    // state.json. If Device Flow isn't connected we try the bare URL,
    // which works for public repos.
    //
    // Also (audit fix #9): the displayed gitUrl in events is the
    // ORIGINAL user-supplied URL, but we DO redact any embedded
    // userinfo before logging so pasted credentials don't leak into
    // the SSE log or state.json.
    const displayUrl = _redactUrlUserInfo(gitUrl);
    const deviceToken = stateService.getGithubDeviceAuth()?.token;
    const cloneUrl = _injectGithubTokenIfPossible(gitUrl, deviceToken);

    // UF-01 preflight: when the URL points at github.com but we have
    // no Device Flow token, warn the user up-front. For public repos
    // this is harmless (we still attempt the clone), but for private
    // repos the bare URL will fail with
    //   fatal: could not read Username for 'https://github.com'
    // and the user sees an english git error with no actionable hint.
    // We emit a 'progress' warning now and map the error below.
    const isGithubUrl = _isGithubHttpsUrl(gitUrl);
    const needsAuthHint = isGithubUrl && !deviceToken;

    try {
      stateService.updateProject(project.id, {
        cloneStatus: 'cloning',
        cloneError: undefined,
      });
      sendEvent('start', {
        projectId: project.id,
        gitRepoUrl: displayUrl,
        repoPath,
      });
      if (needsAuthHint) {
        sendEvent('progress', {
          line: '警告：未检测到 GitHub Device Flow 登录。若这是私有仓库,clone 会因无法获取 Username 而失败。请关闭对话框,点击"使用 GitHub 登录"后重试。',
        });
      }

      // Ensure parent directory exists (reposBase / …)
      const lastSep = repoPath.lastIndexOf('/');
      const parentDir = lastSep > 0 ? repoPath.substring(0, lastSep) : '.';
      const mkdir = await shell.exec(`mkdir -p "${parentDir}"`);
      if (mkdir.exitCode !== 0) {
        throw new Error(`创建父目录失败: ${combinedOutput(mkdir)}`);
      }

      // Clean up a stale target dir if one exists (e.g. from a
      // previous errored clone). The cloneStatus guard above already
      // refuses 'ready', so we can only land here in 'pending' /
      // 'error' — both safe to blow away.
      const check = await shell.exec(`test -d "${repoPath}"`);
      if (check.exitCode === 0) {
        sendEvent('progress', { line: `清理残留目录: ${repoPath}` });
        const rm = await shell.exec(`rm -rf "${repoPath}"`);
        if (rm.exitCode !== 0) {
          throw new Error(`清理残留目录失败: ${combinedOutput(rm)}`);
        }
      }

      // Run the clone with streaming. git clone prints to stderr by
      // default but the MockShellExecutor's onData fires for both,
      // which is fine because the SSE stream is a cat of everything.
      // Always use `displayUrl` in the echoed shell line so tokens
      // don't leak into the SSE stream.
      sendEvent('progress', { line: `$ git clone ${displayUrl} ${repoPath}` });
      const clone = await shell.exec(
        `GIT_TERMINAL_PROMPT=0 git clone "${cloneUrl}" "${repoPath}"`,
        {
          timeout: 10 * 60 * 1000, // 10 minutes max; cancel any stuck clone
          onData: (chunk: string) => {
            // git often emits carriage-return progress updates for
            // "Receiving objects: 34%" etc. Split on both \n and \r
            // so the SSE client sees incremental updates instead of
            // a single giant line at the end.
            for (const line of chunk.split(/[\r\n]/)) {
              const trimmed = line.trim();
              if (trimmed) sendEvent('progress', { line: trimmed });
            }
          },
        },
      );

      if (clone.exitCode !== 0) {
        const rawErr = (combinedOutput(clone) || 'git clone failed').trim();
        // UF-01: translate "could not read Username" into a clear,
        // actionable Chinese message pointing the user at Device Flow.
        const errMsg = _mapGitCloneError(rawErr, isGithubUrl, !!deviceToken);
        stateService.updateProject(project.id, {
          cloneStatus: 'error',
          cloneError: errMsg,
        });
        sendEvent('error', { message: errMsg });
        res.end();
        return;
      }

      stateService.updateProject(project.id, {
        cloneStatus: 'ready',
        cloneError: undefined,
      });
      const gitDefaultBranch = await resolveRemoteDefaultBranch(shell, repoPath);
      if (gitDefaultBranch) {
        stateService.updateProject(project.id, { gitDefaultBranch });
        project.gitDefaultBranch = gitDefaultBranch;
        sendEvent('progress', { line: `远程默认分支: ${gitDefaultBranch}` });
      }
      autoConfigureClonedProject(project, repoPath, sendEvent);
      sendEvent('complete', { projectId: project.id, repoPath });
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      stateService.updateProject(project.id, {
        cloneStatus: 'error',
        cloneError: errMsg,
      });
      sendEvent('error', { message: errMsg });
    } finally {
      res.end();
    }
  });

  // DELETE /api/projects/:id — real deletion (P4 Part 2).
  //
  // Cascading branch/profile cleanup will happen in P4 Part 3 once
  // those entities carry projectId. For now a project is just a
  // top-level entry plus a docker network, so deletion touches only
  // those two things.
  router.delete('/projects/:id', async (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const delMismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (delMismatch) {
      res.status(delMismatch.status).json(delMismatch.body);
      return;
    }
    if (project.legacyFlag) {
      res.status(403).json({
        error: 'legacy_protected',
        message: '默认项目不可删除。',
      });
      return;
    }

    // Drop the docker network first so that even if state save fails,
    // the operator can retry and succeed without network collisions.
    if (project.dockerNetwork) {
      const result = await removeDockerNetwork(project.dockerNetwork);
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[projects] failed to remove docker network ${project.dockerNetwork}: ${result.detail}`,
        );
        // Continue anyway — zombie network is less harmful than zombie
        // project entry. State cascade will clean up the rest.
      }
    }

    // P4 Part 17 (G8 fix): cascade-remove branches/profiles/infra/routing
    // belonging to this project so deleting a project no longer leaves
    // orphans in state.json. The state service returns a summary so we
    // can hand it back to the operator (and the next agent log replay
    // can spot what was lost). Container teardown is intentionally NOT
    // done here — the previous list view's per-branch DELETE already
    // handles that, and chasing it from a project DELETE would slow the
    // request to multi-second territory. We log the cascade summary so
    // operators can run `docker ps` and see the leftovers.
    let summary: ReturnType<typeof stateService.removeProject>;
    try {
      summary = stateService.removeProject(project.id);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    const totalCascade =
      summary.branches.length +
      summary.buildProfiles.length +
      summary.infraServices.length +
      summary.routingRules.length;
    if (totalCascade > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[projects] cascade-removed for project ${project.id}: ` +
          `${summary.branches.length} branches, ` +
          `${summary.buildProfiles.length} buildProfiles, ` +
          `${summary.infraServices.length} infraServices, ` +
          `${summary.routingRules.length} routingRules`,
      );
    }

    res.status(200).json({
      ok: true,
      projectId: project.id,
      cascade: summary,
    });
  });

  // ── Project-scoped Agent Keys ──
  //
  // POST /api/projects/:id/agent-keys — sign a new project-bound agent key
  //   body: { label?: string }
  //   201 { keyId, plaintext, preview }  (plaintext shown ONCE, never stored)
  //
  // GET /api/projects/:id/agent-keys — list metadata (no plaintext, no hash)
  //
  // DELETE /api/projects/:id/agent-keys/:keyId — revoke (200 / 404)
  //
  // See doc rule no-rootless-tree + CLAUDE.md §6 — plaintext is the root
  // users bootstrap their Agent with; CDS never caches or echoes it again.

  router.post('/projects/:id/agent-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    // Project-key holders may only sign keys for their own project.
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }

    const body = (req.body || {}) as { label?: string };
    const now = new Date();
    // Label: auto-generate from timestamp when the user didn't supply one.
    const defaultLabel =
      '签发于 ' +
      now.toISOString().replace('T', ' ').slice(0, 16);
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 100)
      : defaultLabel;

    // Plaintext layout: cdsp_<slugHead12>_<base64url 32 bytes>
    // - slugHead: first 12 chars of project.slug (lowercased). slug regex
    //   already forbids `_` and `/`, so the prefix splits cleanly on `_`.
    // - suffix: 32 random bytes, base64url — ~43 chars, entropy sufficient.
    const slugHead = project.slug.slice(0, 12).toLowerCase();
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsp_${slugHead}_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');

    // Capture signer identity from the github-auth middleware when present.
    const ghUser = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;

    const entry: AgentKey = {
      id: keyId,
      label,
      hash,
      scope: 'rw',
      createdAt: now.toISOString(),
      createdBy: ghUser?.login || undefined,
    };
    try {
      stateService.addAgentKey(project.id, entry);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    res.status(201).json({
      keyId,
      plaintext,
      preview: formatKeyPreview(plaintext),
    });
  });

  router.get('/projects/:id/agent-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const entries = stateService.getAgentKeys(project.id);
    res.json({
      keys: entries.map((e) => ({
        id: e.id,
        label: e.label,
        scope: e.scope,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
        lastUsedAt: e.lastUsedAt,
        revokedAt: e.revokedAt,
        status: e.revokedAt ? 'revoked' : 'active',
      })),
    });
  });

  router.delete('/projects/:id/agent-keys/:keyId', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({
        error: 'project_not_found',
        message: `Project '${req.params.id}' does not exist.`,
      });
      return;
    }
    const mismatch = assertProjectAccess(
      req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } },
      project.id,
    );
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body);
      return;
    }
    const ok = stateService.revokeAgentKey(project.id, req.params.keyId);
    if (!ok) {
      res.status(404).json({
        error: 'key_not_found',
        message: `Agent key '${req.params.keyId}' not found in project.`,
      });
      return;
    }
    res.json({ ok: true, keyId: req.params.keyId });
  });

  // ── Global (bootstrap-equivalent) Agent Keys ──
  //
  // POST /api/global-agent-keys — sign a new bootstrap key
  //   body: { label?: string }
  //   201 { keyId, plaintext, preview }
  //   403 when the caller is using a project-scoped key (those can't
  //       escalate their own scope; only cookie auth or the bootstrap
  //       AI_ACCESS_KEY may mint globals).
  //
  // GET /api/global-agent-keys — list metadata (no plaintext)
  // DELETE /api/global-agent-keys/:keyId — revoke
  //
  // Global keys use the `cdsg_` prefix (parallel to `cdsp_` for project
  // keys) so the auth middleware can route them without a projectId
  // lookup. See server.ts findGlobalAgentKeyForAuth path.

  router.post('/global-agent-keys', (req, res) => {
    // Project-scoped keys may not mint bootstrap-level keys — that would
    // be a privilege escalation (project key → global key → new project).
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_mint_global',
        message:
          '项目级 Agent Key 无权签发全局通行证。请在浏览器登录 CDS，或使用 bootstrap AI_ACCESS_KEY 操作。',
      });
      return;
    }

    const body = (req.body || {}) as { label?: string };
    const now = new Date();
    const defaultLabel = 'Global bootstrap 签发于 ' + now.toISOString().replace('T', ' ').slice(0, 16);
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 100)
      : defaultLabel;

    // Plaintext layout: cdsg_<base64url 32 bytes>. No slug head — global
    // keys have no project scope, so the auth path walks the full list
    // (small, bounded) looking for a hash match.
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsg_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');

    const ghUser = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;

    const entry = {
      id: keyId,
      label,
      hash,
      scope: 'rw' as const,
      createdAt: now.toISOString(),
      createdBy: ghUser?.login || undefined,
    };
    try {
      stateService.addGlobalAgentKey(entry);
    } catch (err) {
      res.status(500).json({
        error: 'state_save_failed',
        message: (err as Error).message,
      });
      return;
    }

    res.status(201).json({
      keyId,
      plaintext,
      preview: formatKeyPreview(plaintext),
    });
  });

  router.get('/global-agent-keys', (_req, res) => {
    const entries = stateService.getGlobalAgentKeys();
    res.json({
      keys: entries.map((e) => ({
        id: e.id,
        label: e.label,
        scope: e.scope,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
        lastUsedAt: e.lastUsedAt,
        revokedAt: e.revokedAt,
        status: e.revokedAt ? 'revoked' : 'active',
      })),
    });
  });

  router.delete('/global-agent-keys/:keyId', (req, res) => {
    if ((req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      res.status(403).json({
        error: 'project_key_cannot_revoke_global',
        message: '项目级 Agent Key 无权吊销全局通行证。',
      });
      return;
    }
    const ok = stateService.revokeGlobalAgentKey(req.params.keyId);
    if (!ok) {
      res.status(404).json({
        error: 'key_not_found',
        message: `Global agent key '${req.params.keyId}' not found.`,
      });
      return;
    }
    res.json({ ok: true, keyId: req.params.keyId });
  });

  return router;
}
