/**
 * SSOT for the per-(branch, profile) docker named volume that holds
 * `node_modules` for pnpm projects (cross-deploy persistence).
 *
 * Both creation (cds/src/services/container.ts) and cleanup
 * (cds/src/routes/branches.ts DELETE handler) MUST use these helpers,
 * otherwise drift between the two sanitize regex / length cap silently
 * orphans volumes (Bugbot 2026-05-06 3e19da66).
 */

const NODE_MODULES_VOLUME_PREFIX = 'cds-nm-';
const SANITIZE_RE = /[^a-zA-Z0-9_.-]/g;
const SANITIZE_MAX_LEN = 60;

function sanitizeForDockerVolume(s: string): string {
  return s.replace(SANITIZE_RE, '-').slice(0, SANITIZE_MAX_LEN);
}

/** 单个 (branch, profile) 的完整 volume 名,用于 `-v {name}:/app/node_modules`。 */
export function nodeModulesVolumeName(branchId: string, profileId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${sanitizeForDockerVolume(branchId)}-${sanitizeForDockerVolume(profileId)}`;
}

/** 单个分支所有 profile 的 volume 共享前缀,用于 `docker volume ls --filter name=^{prefix}`。 */
export function nodeModulesVolumePrefix(branchId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${sanitizeForDockerVolume(branchId)}-`;
}
