/**
 * 验收报告正文的持久层（2026-09-10）。
 *
 * 为什么有这个文件：报告元数据在 Mongo（跨分支共享、持久），正文却一直在
 * `fs.writeFileSync` 到容器本地盘。CDS 跑在容器里时（CDS-in-CDS 的分支预览就是），
 * 容器一重建正文全没、元数据还在——列表里 23 份报告，点开每一份都是 404。
 * 用户看到的是「大量的 404」，本质是**同一份数据的两半存在不同持久等级上**。
 *
 * 规矩（见 AGENTS.md 强制规则「实体与元数据必须同生共死」）：
 *   正文永远进对象存储，本地盘只当读缓存。
 *
 * 没配对象存储时**不许假装**：`isConfigured()` 返回 false，写入方要把
 * 「这份正文只在本地、下次重建就没」如实写进元数据与响应，而不是等用户点开吃 404。
 * 这条是抄 prd-api 的 AssetStorageProviderResolver——它早就拒绝在凭据不全时
 * 静默回退本地盘，CDS 这边补上。
 */
import {
  deleteR2Object, fetchR2ObjectBuffer, uploadAndVerifyR2Object,
  type R2BackupConfig,
} from './infra-backup-r2.js';

/** 报告正文在桶里的前缀。与基础设施备份分开，便于单独设生命周期策略与配额。 */
const DEFAULT_PREFIX = 'cds-acceptance-reports';

export interface ReportObjectStoreConfig extends R2BackupConfig {}

/**
 * 从环境变量解析报告正文的存储配置。
 *
 * 复用备份那套 R2_* 凭据（同一个桶账号），但前缀独立：备份桶有自己的保留策略，
 * 报告不能跟着一起被回收。允许用 CDS_REPORTS_R2_PREFIX 单独指到另一个前缀。
 *
 * 凭据不全时返回 null——不做「有几个算几个」的降级，那正是 prd-api 明令禁止的
 * 静默回退：写了一半的凭据只会写出一批取不回来的对象。
 */
export function reportObjectStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReportObjectStoreConfig | null {
  const endpoint = String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = String(env.CDS_REPORTS_R2_BUCKET || env.R2_BUCKET || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: String(env.CDS_REPORTS_R2_PREFIX || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, ''),
  };
}

/**
 * 报告正文的对象键。
 *
 * 带 projectId 分段是为了「一个项目的证据能整段取走/整段清理」；报告 id 已经是
 * 全局唯一，所以项目段只影响可读性与批量操作，不参与定位正确性。
 * projectId 缺失的历史报告归到 `_unassigned`，不允许拼出 `//` 这种空段。
 */
export function reportObjectKey(meta: { id: string; format: 'html' | 'md'; projectId?: string | null }): string {
  const ext = meta.format === 'md' ? 'md' : 'html';
  const project = String(meta.projectId || '').trim().replace(/[^A-Za-z0-9_-]/g, '') || '_unassigned';
  return `reports/${project}/${meta.id}.${ext}`;
}

function contentTypeOf(format: 'html' | 'md'): string {
  return format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
}

export interface ReportObjectStore {
  isConfigured(): boolean;
  /** 写入并回读校验；返回对象键。未配置时返回 null（调用方必须据此如实标注）。 */
  put(meta: { id: string; format: 'html' | 'md'; projectId?: string | null }, content: string): Promise<string | null>;
  /** 取回正文；未配置或对象不存在返回 null。网络/校验故障照常抛，不许吞成 null。 */
  get(objectKey: string): Promise<string | null>;
  /** 幂等删除。 */
  remove(objectKey: string): Promise<void>;
}

export function createReportObjectStore(
  config: ReportObjectStoreConfig | null = reportObjectStoreFromEnv(),
  deps: {
    upload?: typeof uploadAndVerifyR2Object;
    fetchObject?: typeof fetchR2ObjectBuffer;
    remove?: typeof deleteR2Object;
  } = {},
): ReportObjectStore {
  const upload = deps.upload ?? uploadAndVerifyR2Object;
  const fetchObject = deps.fetchObject ?? fetchR2ObjectBuffer;
  const removeObject = deps.remove ?? deleteR2Object;

  return {
    isConfigured: () => config !== null,

    async put(meta, content) {
      if (!config) return null;
      const objectKey = reportObjectKey(meta);
      // 空正文不写：uploadAndVerifyR2Object 拒收空对象，且一份空报告本身就是缺陷，
      // 与其写一个取回来也没用的对象，不如让调用方拿到 null 走「只在本地」那条路。
      const body = Buffer.from(content, 'utf-8');
      if (body.byteLength === 0) return null;
      await upload({ config, objectKey, body, contentType: contentTypeOf(meta.format) });
      return objectKey;
    },

    async get(objectKey) {
      if (!config || !objectKey) return null;
      const buf = await fetchObject({ config, objectKey });
      return buf ? buf.toString('utf-8') : null;
    },

    async remove(objectKey) {
      if (!config || !objectKey) return;
      await removeObject({ config, objectKey });
    },
  };
}
