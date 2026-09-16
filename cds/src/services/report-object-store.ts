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

  // 「一个都没配」与「配了一半」必须分开：前者是有意只用本地（离线开发、自托管
  // 小实例），后者是配置事故。此前两者都返回 null，于是少打一个密钥的部署会安静地
  // 退回本地盘、接口照回 201，等容器一重建又变回那本取不出货的幽灵台账——正是
  // durable-payload-storage 规则里写明「凭据不全必须拒绝」的那一条，而这里没做到。
  const present = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
  if (present === 0) return null;
  if (present < 4) {
    const missing = [
      endpoint ? '' : 'R2_ENDPOINT',
      bucket ? '' : 'CDS_REPORTS_R2_BUCKET(或 R2_BUCKET)',
      accessKeyId ? '' : 'R2_ACCESS_KEY_ID',
      secretAccessKey ? '' : 'R2_SECRET_ACCESS_KEY',
    ].filter(Boolean).join('、');
    throw new Error(
      `验收报告对象存储的凭据只配了一半，缺 ${missing}。`
      + '要么把它配全，要么四个全部留空以明确只用本地盘；'
      + '配一半会把正文写成取不回来的对象，或者静默退回本地盘、重建即丢。',
    );
  }
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
export function reportObjectKey(
  meta: { id: string; format: 'html' | 'md'; projectId?: string | null },
  prefix: string = DEFAULT_PREFIX,
): string {
  const ext = meta.format === 'md' ? 'md' : 'html';
  const project = String(meta.projectId || '').trim().replace(/[^A-Za-z0-9_-]/g, '') || '_unassigned';
  // 前缀必须真的拼进键里。此前它只被解析进 config.prefix 就再没人用过，
  // uploadAndVerifyR2Object 拿 objectKey 原样建 URL（它只在自己那条备份路径上拼前缀），
  // 于是报告落在桶根、和备份混在一起：本文件开头承诺的「独立前缀、不跟着备份被回收」
  // 一直没有兑现，而且前缀受限的桶凭据会让每一次上传都失败（Codex review 抓到）。
  const head = String(prefix || '').trim().replace(/^\/+|\/+$/g, '');
  return [head, 'reports', project, `${meta.id}.${ext}`].filter(Boolean).join('/');
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

/**
 * 决定「现在这套凭据」的那几个环境变量。用它们的当前值做指纹，值一变就重解析。
 *
 * 只列真正参与解析的键：多列会让无关改动白白重解析，少列会让某个键的热改不生效。
 */
const ENV_KEYS = [
  'R2_ENDPOINT', 'CDS_REPORTS_R2_BUCKET', 'R2_BUCKET',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CDS_REPORTS_R2_PREFIX',
] as const;

function envFingerprint(env: Record<string, string | undefined>): string {
  return ENV_KEYS.map((k) => `${k}=${env[k] ?? ''}`).join('\u0000');
}

export function createReportObjectStore(
  config?: ReportObjectStoreConfig | null,
  deps: {
    upload?: typeof uploadAndVerifyR2Object;
    fetchObject?: typeof fetchR2ObjectBuffer;
    remove?: typeof deleteR2Object;
  } = {},
): ReportObjectStore {
  const upload = deps.upload ?? uploadAndVerifyR2Object;
  const fetchObject = deps.fetchObject ?? fetchR2ObjectBuffer;
  const removeObject = deps.remove ?? deleteR2Object;

  /**
   * 显式传了 config（含 null）就钉死它——测试与调用方靠这条注入。
   *
   * 没传就跟着 process.env 走，且**每次操作前重新求值**：离机备份设置面板
   * (`POST /cds-system/offsite-backup`) 写完 .cds.env 之后会把新值灌回 process.env
   * 并回「无需重启」，而这个 store 是进程启动时建的。冻在构造那一刻的话，
   * 原本没配对象存储的实例热配完仍然只写本地盘，正是本文件开头那本幽灵台账；
   * 轮换凭据也会继续拿已作废的那把打，直到有人重启。
   *
   * 仍然在构造时先解析一次：凭据配一半必须在开机时就炸（reportObjectStoreFromEnv
   * 会抛），这条 fail-fast 不能因为改成懒解析而丢掉。
   */
  const pinned = config !== undefined;
  let resolved: ReportObjectStoreConfig | null = pinned ? (config as ReportObjectStoreConfig | null) : reportObjectStoreFromEnv();
  let fingerprint = pinned ? '' : envFingerprint(process.env);

  function current(): ReportObjectStoreConfig | null {
    if (pinned) return resolved;
    const now = envFingerprint(process.env);
    if (now !== fingerprint) {
      resolved = reportObjectStoreFromEnv();
      fingerprint = now;
    }
    return resolved;
  }

  return {
    isConfigured: () => current() !== null,

    async put(meta, content) {
      const config = current();
      if (!config) return null;
      const objectKey = reportObjectKey(meta, config.prefix);
      // 空正文不写：uploadAndVerifyR2Object 拒收空对象，且一份空报告本身就是缺陷，
      // 与其写一个取回来也没用的对象，不如让调用方拿到 null 走「只在本地」那条路。
      const body = Buffer.from(content, 'utf-8');
      if (body.byteLength === 0) return null;
      await upload({ config, objectKey, body, contentType: contentTypeOf(meta.format) });
      return objectKey;
    },

    async get(objectKey) {
      const config = current();
      if (!config || !objectKey) return null;
      const buf = await fetchObject({ config, objectKey });
      return buf ? buf.toString('utf-8') : null;
    },

    async remove(objectKey) {
      const config = current();
      if (!config || !objectKey) return;
      await removeObject({ config, objectKey });
    },
  };
}
