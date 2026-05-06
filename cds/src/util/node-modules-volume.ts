/**
 * SSOT for the per-(branch, profile) docker named volume that holds
 * `node_modules` for pnpm projects (cross-deploy persistence).
 *
 * Both creation (cds/src/services/container.ts) and cleanup
 * (cds/src/routes/branches.ts DELETE handler) MUST use these helpers,
 * otherwise drift between the two encoding 实现 silently orphans volumes
 * (Bugbot 2026-05-06 3e19da66).
 *
 * 设计取舍(Bugbot 65a383bb 之后):
 * 之前用 `cds-nm-{sanitize(branchId)}-{sanitize(profileId)}` 把斜杠等替换成
 * `-` 再 join,导致 ("foo/bar","baz") 和 ("foo","bar-baz") 都生成
 * `cds-nm-foo-bar-baz` —— 创建期就共用同一 volume,node_modules 串了。
 * 改用**两段固定长度 sha1 前缀**,join 边界绝对明确:
 *   `cds-nm-{branchHash8}-{profileHash8}` (总长 24 chars)
 * 两段分别 hash,只要原文不同,hash 不同(2^32 空间冲突可忽略)。
 *
 * ⚠ 升级影响:旧格式 (`cds-nm-{sanitize}-{sanitize}`) 的 volume 不会被新格式
 * 命名命中。下次部署相当于全新 volume → 第一次 pnpm install 会慢一回,后续
 * 复用快路径。可选一次性清理:`docker volume ls -q -f name=cds-nm- | xargs docker volume rm 2>/dev/null`。
 */

import { createHash } from 'node:crypto';

const NODE_MODULES_VOLUME_PREFIX = 'cds-nm-';
const HASH_LEN = 8; // 8-hex char(2^32 空间够分支 × profile 量级用)

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, HASH_LEN);
}

/** 单个 (branch, profile) 的完整 volume 名,用于 `-v {name}:/app/node_modules`。 */
export function nodeModulesVolumeName(branchId: string, profileId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${shortHash(branchId)}-${shortHash(profileId)}`;
}

/** 单个分支所有 profile 的 volume 共享前缀,用于 `docker volume ls --filter name={prefix}`。 */
export function nodeModulesVolumePrefix(branchId: string): string {
  return `${NODE_MODULES_VOLUME_PREFIX}${shortHash(branchId)}-`;
}
