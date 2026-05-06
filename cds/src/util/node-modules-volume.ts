/**
 * SSOT for the per-(branch, profile) docker named volume that holds
 * `node_modules` for pnpm projects (cross-deploy persistence).
 *
 * Both creation (cds/src/services/container.ts) and cleanup
 * (cds/src/routes/branches.ts DELETE handler) MUST use these helpers,
 * otherwise drift between the two sanitize regex / length cap silently
 * orphans volumes (Bugbot 2026-05-06 3e19da66).
 */

import { createHash } from 'node:crypto';

const NODE_MODULES_VOLUME_PREFIX = 'cds-nm-';
const SANITIZE_RE = /[^a-zA-Z0-9_.-]/g;
const SANITIZE_MAX_LEN = 60;
const HASH_LEN = 8; // 8-hex char suffix(2^32 collision space,够分支级别用)

function sanitizeForDockerVolume(s: string): string {
  const replaced = s.replace(SANITIZE_RE, '-');
  if (replaced.length <= SANITIZE_MAX_LEN) return replaced;
  // ⚠ Bugbot 2026-05-06 b952e898:纯 slice 截断会让两个仅在 60 位之后差异的
  // branch ID 共用同一前缀,删一个会误吞另一个的 volume。截断时拼上 sha1
  // 前 8 位作 disambiguator,保证 SANITIZE_MAX_LEN+1+HASH_LEN 长度内一一对应。
  const hash = createHash('sha1').update(s).digest('hex').slice(0, HASH_LEN);
  return `${replaced.slice(0, SANITIZE_MAX_LEN - HASH_LEN - 1)}-${hash}`;
}

/** 单个 (branch, profile) 的完整 volume 名,用于 `-v {name}:/app/node_modules`。 */
export function nodeModulesVolumeName(branchId: string, profileId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${sanitizeForDockerVolume(branchId)}-${sanitizeForDockerVolume(profileId)}`;
}

/** 单个分支所有 profile 的 volume 共享前缀,用于 `docker volume ls --filter name=^{prefix}`。 */
export function nodeModulesVolumePrefix(branchId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${sanitizeForDockerVolume(branchId)}-`;
}
