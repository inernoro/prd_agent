/**
 * Mongo 索引对账（Codex PR #1275 九轮 P2）。
 *
 * 背景：日志库的 TTL 索引 `ttl_ts` 的 `expireAfterSeconds` 直接来自配置的保留天数。
 * 一旦运维把保留期从 7 天改成 30 天，`createIndex` 会以 **IndexOptionsConflict(85)**
 * 拒绝——同名索引已存在但选项不同。这是配置变更的**正常后果**，不是故障，却会让
 * 「连接 + 建索引」写在同一个 try 里的 init 整体失败，把一个明明连得上的日志库判死。
 *
 * 这里把「同名不同选项」显式对账掉：drop 再建。其余错误原样抛出，不吞。
 */
import type { Collection, Document, IndexSpecification, CreateIndexesOptions } from 'mongodb';

/** Mongo 的 IndexOptionsConflict 错误码。 */
export const INDEX_OPTIONS_CONFLICT_CODE = 85;

/** 判定某个 createIndex 错误是否为「同名索引已存在但选项不同」。 */
export function isIndexOptionsConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === INDEX_OPTIONS_CONFLICT_CODE) return true;
  const name = (err as { codeName?: unknown }).codeName;
  if (typeof name === 'string' && name === 'IndexOptionsConflict') return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /IndexOptionsConflict|already exists with different options/i.test(msg);
}

/**
 * 建索引，遇到「同名不同选项」时 drop 再建。
 * 没有 `name` 就无从 drop，此时原样抛出（调用方一律显式命名索引）。
 */
export async function ensureIndexWithReconcile<T extends Document>(
  collection: Pick<Collection<T>, 'createIndex' | 'dropIndex'>,
  keys: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  try {
    await collection.createIndex(keys, options);
    return;
  } catch (err) {
    if (!isIndexOptionsConflict(err)) throw err;
  }
  await collection.dropIndex(options.name);
  await collection.createIndex(keys, options);
}
