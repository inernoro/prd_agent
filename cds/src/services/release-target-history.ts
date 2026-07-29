/**
 * release-target-history — 发布目标配置变更历史（唯一判定源 + 唯一写入收敛点）。
 *
 * 要回答的问题：「这个站点的健康检查地址是谁、什么时候改成现在这个值的？」
 * 此前完全答不上来 —— upsertReleaseTarget 只留一个 updatedAt，createdBy 在 PATCH
 * 路径上走 `...existing` 原样保留，所以「谁改的」永远显示首次创建者。
 *
 * 两个必须写死在代码里的坑：
 *
 * 1. **diff 不能按请求 body 的 key 集合算**。PATCH 只传一个 name，也可能真的改掉
 *    ssh.deployCommand —— 它是从 strategy 反推的（非 existing-script 模式一律置空串），
 *    strategy 没变但模式判定链路上的任何输入变了都会带出来。所以 diff 必须算
 *    「落库前的对象 vs 落库后真正生效的对象」，中间那层请求体不可信。
 *
 * 2. **留痕写在 PATCH 路由里必漏**。创建 / 本机生产创建 / 更新 / 归档四个入口都会
 *    落一次发布目标，第五个入口迟早会加。所以本文件同时提供 recordReleaseTargetUpsert
 *    这个**唯一写入收敛点**，路由一律不许再直接调 stateService.upsertReleaseTarget；
 *    由 tests/services/release-target-history-single-writer.test.ts 源码扫描守住。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseTarget } from '../types.js';
import { maskSecrets } from './secret-masker.js';
import { getAgentOperationContext } from './agent-operation-context.js';

/** 单个字段的变化。值都是**展示用字符串**，不是原值——历史是长期留痕，不做回放。 */
export interface ReleaseTargetFieldChange {
  path: string;
  /** 人话字段名，让不看代码的人也能读懂这条历史 */
  label: string;
  before?: string;
  after?: string;
}

export interface ReleaseTargetChange {
  id: string;
  targetId: string;
  projectId: string;
  at: string;
  actor?: string;
  /** 归档等带原因的操作会带上，便于回答「为什么改」 */
  reason?: string;
  requestId?: string;
  operationId?: string;
  kind: 'created' | 'updated' | 'archived';
  changes: ReleaseTargetFieldChange[];
}

/**
 * 可审计字段白名单（唯一判定源）。
 *
 * 白名单而不是「整个对象递归 diff」：后者会把 updatedAt 这种每次必变的字段
 * 记成一条变更，历史里 90% 是噪声，真正改了健康检查地址那条反而被淹掉。
 */
export const RELEASE_TARGET_TRACKED_PATHS: ReadonlyArray<{ path: string; label: string }> = [
  { path: 'name', label: '站点名称' },
  { path: 'isEnabled', label: '是否启用' },
  { path: 'lifecycle', label: '生命周期' },
  { path: 'environment', label: '环境' },
  { path: 'isCanonical', label: '是否主发布目标' },
  { path: 'strategy.mode', label: '发布模式' },
  { path: 'strategy.command', label: '发布命令' },
  { path: 'strategy.composeFile', label: 'Compose 文件' },
  { path: 'strategy.composeProject', label: 'Compose 项目名' },
  { path: 'strategy.buildCommand', label: '构建命令' },
  { path: 'strategy.artifactDirectory', label: '产物目录' },
  { path: 'strategy.publicDirectory', label: '发布目录' },
  { path: 'ssh.host', label: '服务器地址' },
  { path: 'ssh.port', label: 'SSH 端口' },
  { path: 'ssh.user', label: 'SSH 用户' },
  { path: 'ssh.privateKeyRef', label: '服务器凭据' },
  { path: 'ssh.appPath', label: '生产目录' },
  { path: 'ssh.deployCommand', label: '发布命令（落库值）' },
  { path: 'ssh.rollbackCommand', label: '回滚命令' },
  { path: 'ssh.healthcheckUrl', label: '健康检查地址' },
];

/**
 * 只留指纹、绝不留原值的字段。
 *
 * privateKeyRef 是服务器凭据的引用，历史留痕的读权限比发布目标本身宽（谁都能翻
 * 审计），把它原样写进去等于把「哪台机器用哪把钥匙」摊开。指纹保留了「换没换」
 * 这个唯一有价值的信息，同时不泄露引用值本身。
 */
const FINGERPRINT_ONLY_PATHS = new Set(['ssh.privateKeyRef']);

/** 单个值的展示上限。local-prod 的 deployCommand 是一长串拼出来的 env，不截断会撑爆历史。 */
const MAX_VALUE_CHARS = 512;
/** 每个目标保留的变更条数上限。历史是给人看的，不是审计归档系统。 */
export const MAX_CHANGES_PER_TARGET = 50;

function readPath(target: ReleaseTarget | undefined, dottedPath: string): unknown {
  if (!target) return undefined;
  let cursor: unknown = target;
  for (const segment of dottedPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function fingerprint(value: string): string {
  return `ref:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** 值 → 展示字符串。undefined / 空串统一收敛成 undefined，避免「空 vs 不存在」刷出假变更。 */
/**
 * 值 → **原值**字符串。只做类型归一，不脱敏、不截断。
 *
 * 与 formatTrackedValue 的分工是本模块最容易搞错的一处：
 *   - 这个给**指纹**用 —— 结果进单向哈希，不落库、不展示，必须保真；
 *   - formatTrackedValue 给**展示**用 —— 会掩码敏感值、512 字截断，会丢信息。
 *
 * 事故值（Codex P1）：指纹曾经建在 formatTrackedValue 上，于是两个「只在长发布命令
 * 尾部不同」或「只改了 TOKEN=xxx」的目标算出**同一个指纹** —— 命令已经换了，
 * 旧预检照样在两分钟窗口里放行。脱敏该发生在给人看的那一层，不该发生在判等的那一层。
 */
function rawTrackedValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  const text = typeof raw === 'string' ? raw : String(raw);
  return text.trim() ? text : undefined;
}

/**
 * 目标配置指纹 —— 「这个发布目标的配置有没有变过」的唯一判据。
 *
 * 为什么复用 RELEASE_TARGET_TRACKED_PATHS 而不另立一份清单：这张表已经是「哪些字段
 * 变了算一次配置变更」的 SSOT（变更历史照它记）。预检复用如果自己再列一遍，
 * 两张表迟早漂移 —— 而漂移的后果是「历史里记了一笔变更，预检却认为配置没变、
 * 照旧复用旧结论」，正好是最危险的方向。加字段时只需改那一张表，两边同时生效。
 *
 * 事故值（Codex P1 第一轮）：复用键只有 branchId/targetId/previewUrl/operator/commitSha。
 * 运维在两分钟复用窗口内改了 host / 凭据 / appPath / 发布命令 / healthcheckUrl，
 * 键照样命中，于是把「旧目标上验过的结论」套到新目标上 —— 发布打到一台连通性、
 * 仓库身份、脚本都从没验证过的机器上。
 *
 * 取**原值**做单向哈希（见 rawTrackedValue）：sha256 不可逆，指纹里不残留任何明文，
 * 落库安全；而用脱敏值会让「命令换了但掩码后一样」的两个配置撞成同一个指纹。
 */
export function releaseTargetConfigFingerprint(target: ReleaseTarget | undefined): string {
  if (!target) return '';
  const parts = RELEASE_TARGET_TRACKED_PATHS.map(({ path: dottedPath }) => {
    // 字段名与值一起进哈希，避免「A 字段清空、B 字段填上同一个值」互相抵消。
    const value = rawTrackedValue(readPath(target, dottedPath));
    return `${dottedPath}=${value ?? ''}`;
  });
  return fingerprint(parts.join('\n'));
}

export function formatTrackedValue(raw: unknown, dottedPath: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw ? '是' : '否';
  const text = typeof raw === 'string' ? raw : String(raw);
  if (!text.trim()) return undefined;
  if (FINGERPRINT_ONLY_PATHS.has(dottedPath)) return fingerprint(text);
  // 发布命令这类自由文本可能内联 TOKEN=xxx 之类的赋值，先过一遍通用脱敏。
  const masked = maskSecrets(text);
  return masked.length > MAX_VALUE_CHARS ? `${masked.slice(0, MAX_VALUE_CHARS)}…（已截断）` : masked;
}

/**
 * 落库前 vs 落库后的字段级 diff。
 * before 缺省 = 新建，此时把所有有值的字段作为「初始值」记下来（only after）。
 */
export function diffReleaseTarget(
  before: ReleaseTarget | undefined,
  after: ReleaseTarget,
): ReleaseTargetFieldChange[] {
  const changes: ReleaseTargetFieldChange[] = [];
  for (const { path: dottedPath, label } of RELEASE_TARGET_TRACKED_PATHS) {
    const beforeValue = formatTrackedValue(readPath(before, dottedPath), dottedPath);
    const afterValue = formatTrackedValue(readPath(after, dottedPath), dottedPath);
    if (beforeValue === afterValue) continue;
    changes.push({ path: dottedPath, label, before: beforeValue, after: afterValue });
  }
  return changes;
}

export function resolveChangeKind(
  before: ReleaseTarget | undefined,
  after: ReleaseTarget,
): ReleaseTargetChange['kind'] {
  if (!before) return 'created';
  if (after.lifecycle === 'archived' && before.lifecycle !== 'archived') return 'archived';
  return 'updated';
}

/** 定长追加：超出上限从头部丢最旧的。同 uptime-metrics.ts::appendCapped 的口径。 */
export function appendReleaseTargetChange(
  list: ReleaseTargetChange[],
  entry: ReleaseTargetChange,
  max: number = MAX_CHANGES_PER_TARGET,
): ReleaseTargetChange[] {
  list.push(entry);
  const overflow = list.length - Math.max(1, max);
  if (overflow > 0) list.splice(0, overflow);
  return list;
}

interface HistoryStoreFile {
  version: 1;
  savedAt: string;
  byTarget: Record<string, ReleaseTargetChange[]>;
}

/**
 * 文件落盘的变更历史台账。
 *
 * 走独立文件而不是塞进 CdsState：与 uptime-monitor.json 同款取舍——审计流水是
 * 只增不改的旁路数据，混进控制面状态会让每次 save 都要整份序列化它，
 * 而控制面 save 的频率远高于「改一次发布目标」。
 */
export class ReleaseTargetHistoryStore {
  private byTarget = new Map<string, ReleaseTargetChange[]>();
  private loaded = false;

  constructor(
    private readonly options: {
      storePath?: string;
      maxPerTarget?: number;
      now?: () => Date;
      logger?: { warn?: (m: string) => void };
    } = {},
  ) {}

  private get maxPerTarget(): number {
    return this.options.maxPerTarget ?? MAX_CHANGES_PER_TARGET;
  }

  /** 惰性加载：构造时不碰磁盘，测试与冷启动都不会因为读一个不存在的文件而变慢或抛错。 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const fp = this.options.storePath;
    if (!fp) return;
    try {
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as HistoryStoreFile;
      if (!parsed || !parsed.byTarget || typeof parsed.byTarget !== 'object') return;
      for (const [targetId, list] of Object.entries(parsed.byTarget)) {
        if (!Array.isArray(list)) continue;
        this.byTarget.set(targetId, list.slice(-this.maxPerTarget));
      }
    } catch (err) {
      this.options.logger?.warn?.(`[release-history] 读取变更历史失败，从空台账开始: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const fp = this.options.storePath;
    if (!fp) return;
    const payload: HistoryStoreFile = {
      version: 1,
      savedAt: (this.options.now?.() ?? new Date()).toISOString(),
      byTarget: Object.fromEntries(this.byTarget),
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, fp);
    } catch (err) {
      // 落盘失败只丢历史，绝不能反过来把「改发布目标」这件正事整黄。
      this.options.logger?.warn?.(`[release-history] 落盘失败（仅内存保留）: ${(err as Error).message}`);
    }
  }

  append(entry: ReleaseTargetChange): ReleaseTargetChange {
    this.ensureLoaded();
    const list = this.byTarget.get(entry.targetId) || [];
    appendReleaseTargetChange(list, entry, this.maxPerTarget);
    this.byTarget.set(entry.targetId, list);
    this.persist();
    return entry;
  }

  /** 倒序返回（最新在前）。 */
  list(targetId: string, limit = this.maxPerTarget): ReleaseTargetChange[] {
    this.ensureLoaded();
    const list = this.byTarget.get(targetId) || [];
    const capped = Math.max(1, Math.min(Math.floor(limit) || this.maxPerTarget, this.maxPerTarget));
    return [...list].reverse().slice(0, capped);
  }

  /**
   * 目标被彻底删除时清账。没有这一步，删掉的目标会永远占着一桶历史 ——
   * 每个桶自身有上限，但桶的数量没有，那就是另一种无界增长。
   */
  forget(targetId: string): void {
    this.ensureLoaded();
    if (!this.byTarget.delete(targetId)) return;
    this.persist();
  }
}

/** recordReleaseTargetUpsert 需要的最小 state 面，窄接口便于单测注入假 state。 */
export interface ReleaseTargetWriter {
  getReleaseTarget(id: string): ReleaseTarget | undefined;
  upsertReleaseTarget(target: ReleaseTarget): ReleaseTarget;
}

/**
 * **唯一写入收敛点**：所有落库发布目标的地方都必须走这里，不许再直接调
 * stateService.upsertReleaseTarget（守卫测试会扫源码）。
 *
 * 顺序很重要：先读落库前快照 → 落库 → 拿**落库后真正生效的对象**做 diff。
 * upsertReleaseTarget 内部是 `{...existing, ...target}` 合并，落库后的值不等于
 * 调用方递进来的那个对象；拿入参做 diff 会漏掉合并带出的字段。
 */
export function recordReleaseTargetUpsert(
  deps: { state: ReleaseTargetWriter; history: ReleaseTargetHistoryStore },
  target: ReleaseTarget,
  meta: { actor?: string; reason?: string; now?: Date } = {},
): ReleaseTarget {
  const before = deps.state.getReleaseTarget(target.id);
  // 深拷贝：upsert 会就地改写 state 里的同一个对象引用，浅持有会让 before 和 after
  // 变成同一份，diff 恒为空——这正是「记了等于没记」的静默失效。
  const beforeSnapshot: ReleaseTarget | undefined = before
    ? JSON.parse(JSON.stringify(before)) as ReleaseTarget
    : undefined;
  const saved = deps.state.upsertReleaseTarget(target);
  const changes = diffReleaseTarget(beforeSnapshot, saved);
  const kind = resolveChangeKind(beforeSnapshot, saved);
  // 无变化的 PATCH（前端整表提交很常见）不记，否则历史里全是空条目。
  if (changes.length === 0 && kind === 'updated') return saved;
  const context = getAgentOperationContext();
  deps.history.append({
    id: `rtc_${crypto.randomBytes(6).toString('hex')}`,
    targetId: saved.id,
    projectId: saved.projectId,
    at: (meta.now ?? new Date()).toISOString(),
    actor: meta.actor,
    reason: meta.reason,
    requestId: context?.requestId,
    operationId: context?.operationId,
    kind,
    changes,
  });
  return saved;
}
